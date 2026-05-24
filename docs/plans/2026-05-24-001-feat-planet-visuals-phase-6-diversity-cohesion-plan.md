---
title: Planet visuals Phase 6 — diversity guardrails + style cohesion enforcement
type: feat
status: active
date: 2026-05-24
parent: docs/plans/2026-05-23-001-feat-planet-visuals-llm-driven-assets-plan.md
---

# Planet visuals Phase 6 — diversity guardrails + style cohesion enforcement

## Overview

Phase 6 of the [planet-visuals workstream](../plans/2026-05-23-001-feat-planet-visuals-llm-driven-assets-plan.md). Phase 2 shipped the diversity infrastructure (MMR, recency demotion, recent-asset ring buffer, hybrid retrieval) but never wired up the **write side** — the ring buffer is read on every shortlist call and ignored on every claim. Phase 10 fixed per-asset color drift but didn't address picking the same crystal monolith on three planets in a row, or assembling a planet from five clashing creators.

This phase finishes the cohesion + diversity story across three planes:

- **Temporal:** assets the player just used get pushed down the retrieval rank for the next planet (recency demotion, *actually* populated).
- **Intra-planet:** all six asset slots on a planet bias toward sharing a `pack` so the planet reads as one place (pack-cohesion bonus).
- **Per-shortlist:** the candidate set for any one slot stays diverse so the LLM has real choices to make (MMR / fallback dedupe).

Plus a developer audit hook (`__GAME.auditMaterials()`) to verify that, post-Phase-10, every visible mesh on a planet sources its material from that planet's `matSet` — no PBR leaks, no orphaned standard materials.

## Problem Statement

Three observable failure modes from prod:

1. **"Every planet looks like the last one I saw."** The retriever's recency-demotion code path is live (`AssetRetriever.js:229-231`, `RECENCY_PENALTY = 0.3`) and `markUsed(ids)` is exported (`L317-322`), but a grep across the entire `src/` directory turns up **zero callers**. The ring buffer is permanently empty in practice; the demotion multiplies by 0.3 against an always-empty set, doing nothing.

2. **"This planet feels like a kit mashup."** Today's three shortlist calls (`LLMClient._pickAssets`, `LLMClient.js:111-189`) run in parallel and the LLM picks hero, landmark, and surface independently from their respective shortlists. There's no signal coupling the picks to a single pack. The system prompt at `worker/src/routes/llm.js:48` *asks* the model to prefer pack cohesion, but the shortlist payload sent at `LLMClient.js:175-180` is bare asset IDs — the LLM has no idea what pack any candidate belongs to.

3. **"Did Phase 10's color system actually catch every material?"** `applyMaterialSet` (`MaterialSet.js:88-116`) traverses every mesh and replaces materials unconditionally — but there's no runtime assertion verifying that 100% of visible meshes on a mounted planet actually came from `matSet`. Phase 10's PBR opt-out for `hero` slot is correct *if* the slot tag is reliable across all bundled GLBs — and there's no way to know without measuring.

Plus a real correctness gap the audit surfaced:

4. **The ring buffer key is global, not per-user.** `RECENT_KEY = 'personalspace:recent-assets:v1'` (`AssetRetriever.js:30`). Two players sharing a browser, or a signed-out → signed-in transition, pollute each other's diversity state. `AuthClient` already exposes `this.user.id` (`src/auth/AuthClient.js:21,47-48`); the fix is a one-liner.

5. **BM25-only fallback skips diversity entirely.** MMR only runs in the dense-available branch (`AssetRetriever.js:237`). When the embedder failed to warm up (rare returning-player edge), the shortlist degrades to a plain RRF slice with no diversity pass. The first 8 BM25 hits ship straight to the LLM.

## Proposed Solution

Six workstreams, ordered by dependency:

### 1. Persist `selected_assets` + wire `markUsed` post-claim

The IDs to demote live on the Tier 2 LLM response (`meta.selected_assets`). Today `applyLLM(meta)` (`Planet.js:135-151`) doesn't stash them on the planet — only the LLM-returned palette and landmark names land. Phase 6 stashes the full `meta` (already true) AND adds an explicit `planet.meta.selected_assets = meta.selected_assets` reference *also* set on a successful applyVisuals so the claim handler has reliable access.

Then `main.js:579-644` (the claim block) calls `markUsed([hero, landmark_a, landmark_b, landmark_c, surface_a, surface_b].filter(Boolean))` synchronously inside `markClaimed()`, before the two-phase logbook save kicks off.

**Race nuance — claim-before-Tier-2.** Coverage can hit `CLAIM_COVERAGE` while `llm.approach` is still in flight (placeholder visuals render, claim triggers). If picks haven't resolved yet, the claim mark is a no-op. To handle this, `tryApproach`'s success path checks `if (planet.claimed) markUsed(...)` so late-arriving picks still get demoted. Only the *successful resolution* path marks — a retried approach (`approachSent.delete(seed)` on failure) doesn't double-mark on the eventual win.

### 2. Per-user keying with auth-transition handling

```js
// AssetRetriever.js
function recentKeyFor(userId) {
  return `personalspace:recent-assets:v1:${userId || 'anonymous'}`;
}
```

Replace direct `RECENT_KEY` reads with `recentKeyFor(currentUserId)`. The current user id is threaded into `AssetRetriever` via a setter (`setUser(userId)`) called from `AuthClient`'s `onUserChange` listener (or pulled lazily from `__GAME.auth.user?.id` if no listener API yet).

**Auth transitions:**
- Sign-in (anonymous → user): copy the anonymous buffer's contents into the user's buffer (latest-wins merge), then clear the anonymous key.
- Sign-out: drop the in-memory cache; subsequent shortlists read the anonymous key.
- Account delete: clear the user's recent key alongside other user state (`AuthClient.deleteAccount` flow).

### 3. Pack-cohesion bonus — parallel-preserving design

The SpecFlow surfaced a critical architecture point: the LLM picks all 6 IDs in a single `/tier2/pick` call, so a literal "pick hero, then re-rank rest" client-side flow would require splitting `/tier2/pick` into two calls (adds ~12s of LLM latency — unacceptable).

The chosen design preserves parallelism by enriching the shortlist payload + nudging the system prompt + applying a soft **anchor pack** boost during the shortlist computation itself:

**(a) Probabilistic anchor pack.** Compute the per-planet anchor pack client-side as the most-common `pack` across the hero shortlist's top-3 (after recency + MMR). This is a *probabilistic* anchor — it represents "the LLM is likely to pick from this pack" without forcing it. Seeded from `planet_seed` so re-spawns are stable.

**(b) Score boost.** During landmark + surface shortlist construction, apply a `1.3x` multiplicative boost to candidates whose `pack === anchor_pack` *before* MMR / recency. Boost lands at the post-RRF score (`AssetRetriever.js:218-226`). Cohesion thus operates at the *retrieval* layer; MMR still enforces diversity at the *selection* layer. They're orthogonal.

**(c) Pack metadata in the LLM payload.** Replace the bare-string shortlist (`LLMClient.js:175-180`) with `{id, pack, family}` per entry. The strict-tool enum stays string-of-IDs (no schema change), but the prompt context now includes pack labels so Haiku can honor the existing pack-cohesion line in the system prompt (`worker/src/routes/llm.js:48`).

**Anchor edge cases:**
- Hero shortlist empty → no anchor, skip the boost (graceful baseline).
- Anchor pack has 0 assets matching a target role+biome → 1.3x boost over empty set is a no-op; baseline ranking applies. Document that cohesion is best-effort.
- Anchor pack has only 1 landmark candidate but schema needs 3 → per-id cap (don't boost an id already at top rank multiple times); fall back to top-K of remaining packs for slots 2 and 3.

**Note on resolved-vs-picked hero:** the anchor is computed from the *shortlist*, not from the LLM's chosen ID — so a hero GLB load failure post-pick (`Planet._loadAssetSafe` returns null) doesn't invalidate the anchor. The landmarks + surfaces will still read as the anchor pack's visual family.

### 4. Tuned recency + MMR

Two tuning changes informed by the external research synthesis:

**(a) Recency: per-role smooth decay** replacing the binary `RECENCY_PENALTY = 0.3`:

```js
// AssetRetriever.js
const RECENCY_HALF_LIFE = { hero: 12, landmark: 8, surface: 5 };

function recencyMultiplier(age, role) {
  const h = RECENCY_HALF_LIFE[role] ?? 8;
  return 0.3 + 0.7 * (1 - Math.exp(-age / h));
}
```

- `age` = index in the recent ring buffer (0 = most recent).
- Hero gets weaker demotion (heroes are scarce; aggressive demotion pushes to weak fits).
- Surface gets strongest demotion (filler that screams "same planet" if repeated).

Ring buffer cap grows from 20 → 32 so the oldest entries fully decay (`3 × max half-life ≈ 36`, rounded down).

**(b) MMR: λ 0.7 → 0.5.** Canonical λ=0.7 is tuned for web search over millions of docs where relevance is dominant. At our scale (~50 candidates per role after filtering), the 50th-best crystal is still a fine crystal — trading more relevance for more diversity is cheap. λ=0.5 sits in the middle of the 2025-recommended range for browse-style discovery.

### 5. MaterialSet enforcement audit (`__GAME.auditMaterials()`)

Dev-only hook walking every loaded planet's mesh tree and reporting any material that *should* have been replaced but wasn't. Reports per planet:

```
[auditMaterials] Planet 1703407886
  ✓ 142 meshes from matSet
  ⚠ 3 meshes with non-matSet material:
    - landmark[2] / Cube_1 / MeshStandardMaterial (color #b04020)
    - landmark[2] / Cube_2 / MeshStandardMaterial
    - surface[0] (InstancedMesh, 87 instances) / MeshPhysicalMaterial
[auditMaterials] Planet 2204891234
  ✓ 98 meshes from matSet
  ✓ all clean
```

**Exemption rules** (the false-positive sources SpecFlow flagged):

- Skip any mesh under an ancestor named `__debugPlacement` (Phase 10's debug helpers — Box3Helper/AxesHelper/ArrowHelper use raw materials by design).
- Skip materials of type `LineBasicMaterial`, `LineDashedMaterial`, `SpriteMaterial` (always debug overlays).
- Skip meshes with `userData.matSlot === 'hero'` (intentional PBR opt-out; the planned Phase 7 LUT pass handles their biome cohesion).
- Skip meshes with `userData.matSlot === 'terrain'` (terrain uses `matSet.terrain` directly, not per-mesh-cloned).
- Skip meshes under a group with `userData.procedural === true` (procedural-fallback landmarks; their materials are ad-hoc by design).

**Implementation:** add `userData.cloned = true` on every material that `applyMaterialSet` writes (already done in Phase 10 — `MaterialSet.js:114`). Procedural landmark fallbacks (`buildLandmarkMeshes` in `Landmarks.js:154-208`) get `group.userData.procedural = true` set in the same call. Audit walks the tree; for each `isMesh`, if not exempt and `material.userData.cloned !== true`, report.

### 6. BM25-fallback diversity pass

When the dense embedder is unavailable, MMR can't run (it requires embeddings to compute pairwise similarity). Cheap substitute:

```js
// First-token dedupe: don't pick two `crystal_largeA` and `crystal_largeB` back-to-back.
function bm25FallbackDiversity(candidates, k) {
  const picked = [];
  const seenPrefixes = new Set();
  for (const c of candidates) {
    const prefix = c.id.split(':').pop().split('_')[0].toLowerCase();
    if (seenPrefixes.has(prefix) && picked.length >= Math.ceil(k / 2)) continue;
    picked.push(c);
    seenPrefixes.add(prefix);
    if (picked.length >= k) break;
  }
  return picked;
}
```

Conservative: only dedupes after half the slots are filled (so the highest-ranked few survive regardless), and only on first-token-of-id (cheap, no embedding lookup). Logged via the existing degraded-mode telemetry.

## Technical Approach

### Architecture

```
Browser
  ├── AuthClient (src/auth/AuthClient.js)
  │     └── onUserChange → AssetRetriever.setUser(userId)
  │
  ├── AssetRetriever (src/world/AssetRetriever.js)
  │     ├── recentKeyFor(userId)               — per-user ring buffer key
  │     ├── recencyMultiplier(age, role)       — per-role smooth decay
  │     ├── markUsed(ids)                      — wired by claim flow (NEW caller)
  │     ├── shortlist({..., preferPack, role})— pack boost + tuned MMR (λ=0.5)
  │     └── bm25FallbackDiversity()            — dense-unavailable path
  │
  ├── LLMClient (src/llm/LLMClient.js)
  │     └── _pickAssets()
  │           1. heroShortlist (no anchor yet) — runs first to derive anchor
  │           2. anchor = topPackOf(heroShortlist[0..3])
  │           3. landmarkShortlist + surfaceShortlist (preferPack=anchor) — parallel
  │           4. enrich payload to {id, pack, family} for /tier2/pick
  │           Net latency cost: one synchronous re-rank pass (~5ms)
  │
  ├── main.js
  │     ├── tryApproach success path: planet.meta.selected_assets = sel
  │     │                              if (planet.claimed) markUsed(sel)
  │     └── markClaimed path: if (planet.meta?.selected_assets) markUsed(sel)
  │
  └── __GAME.auditMaterials() (src/main.js debug block)
        └── walks galaxy.systems → planet.group → asserts matSet provenance

worker/src/routes/llm.js
  └── /tier2/pick — system prompt already nudges pack cohesion (line 48);
                    payload now provides pack labels per shortlist entry
```

### Asset retriever changes

**Recency multiplier (replacing `RECENCY_PENALTY = 0.3`):**

```js
// AssetRetriever.js
const RECENT_CAP = 32;                                     // was 20
const RECENCY_HALF_LIFE = { hero: 12, landmark: 8, surface: 5 };

function recencyMultiplier(age, role) {
  const h = RECENCY_HALF_LIFE[role] ?? 8;
  return 0.3 + 0.7 * (1 - Math.exp(-age / h));
}

// In shortlist() — replace the existing recency block:
const recentIndex = new Map(recent.map((id, idx) => [id, idx]));
for (const [id, entry] of fused) {
  const age = recentIndex.get(id);
  if (age !== undefined) entry.score *= recencyMultiplier(age, role);
}
```

**Pack boost:**

```js
// AssetRetriever.js — added in shortlist() after recency, before MMR:
if (preferPack) {
  for (const [id, entry] of fused) {
    if (entry.asset.pack === preferPack) entry.score *= 1.3;
  }
  // Re-sort fused by adjusted score before MMR consumes it
  fused.sort(([, a], [, b]) => b.score - a.score);
}
```

**Per-user keying:**

```js
let _currentUserId = null;
export function setUser(userId) {
  _currentUserId = userId || null;
  // Migrate anonymous → user buffer on first sign-in (one-shot).
  const anon = localStorage.getItem(recentKeyFor(null));
  const userKey = recentKeyFor(_currentUserId);
  if (anon && _currentUserId && !localStorage.getItem(userKey)) {
    localStorage.setItem(userKey, anon);
    localStorage.removeItem(recentKeyFor(null));
  }
}
```

### LLM pick orchestration

```js
// LLMClient._pickAssets — change from full parallel to "hero-derive-anchor, then parallel rest":
const heroShortlist = await retrieverShortlist({ query: heroQuery, role: 'hero', k: 8, biomeAffinity });
const anchorPack = topPackOf(heroShortlist.slice(0, 3));   // most common pack in top-3, or null

const [landmarkShortlist, surfaceShortlist] = await Promise.all([
  retrieverShortlist({ query: landmarkQuery, role: 'landmark', k: 10, biomeAffinity, preferPack: anchorPack }),
  retrieverShortlist({ query: surfaceQuery,  role: 'surface',  k: 15, biomeAffinity, preferPack: anchorPack }),
]);

// Payload enrichment — was bare string IDs; now per-entry metadata.
const enrich = (arr) => arr.map(({ id, asset }) => ({ id, pack: asset.pack, family: asset.family }));
const shortlists = {
  hero:     enrich(heroShortlist),
  landmark: enrich(landmarkShortlist),
  surface:  enrich(surfaceShortlist),
};
```

Net latency: one async hop (hero shortlist completes) before the parallel pair fires, vs three parallel today. Hero shortlist takes ~10-30ms on warm embedder, so worst-case delta is one frame.

### MaterialSet audit hook

```js
// New file: src/world/MaterialAudit.js
const EXEMPT_MATERIAL_TYPES = new Set(['LineBasicMaterial', 'LineDashedMaterial', 'SpriteMaterial']);
const EXEMPT_SLOTS = new Set(['hero', 'terrain']);

function isUnderDebugGroup(obj) {
  for (let o = obj; o; o = o.parent) {
    if (o.name === '__debugPlacement') return true;
  }
  return false;
}

function isUnderProceduralGroup(obj) {
  for (let o = obj; o; o = o.parent) {
    if (o.userData?.procedural === true) return true;
  }
  return false;
}

export function auditPlanet(planet) {
  const ok = [];
  const leaks = [];
  planet.group.traverse((o) => {
    if (!o.isMesh) return;
    if (isUnderDebugGroup(o)) return;
    if (isUnderProceduralGroup(o)) return;
    if (EXEMPT_SLOTS.has(o.userData?.matSlot)) { ok.push(o); return; }
    if (EXEMPT_MATERIAL_TYPES.has(o.material?.type)) return;
    if (o.material?.userData?.cloned === true) { ok.push(o); return; }
    leaks.push({
      path: pathOf(o),
      type: o.material?.type,
      color: '#' + (o.material?.color?.getHex?.() ?? 0).toString(16).padStart(6, '0'),
    });
  });
  return { planetSeed: planet.seed, ok: ok.length, leaks };
}

function pathOf(o) {
  const parts = [];
  for (let x = o; x; x = x.parent) {
    parts.unshift(x.name || x.type);
    if (x.userData?.role) parts[0] = `${x.userData.role}[${x.userData.slotId ?? '?'}]`;
  }
  return parts.join(' / ');
}
```

Exposed via `__GAME.auditMaterials()` (main.js debug block) which loops `galaxy.systems` and prints a per-planet report.

## Alternative Approaches Considered

| Approach | Why rejected |
|---|---|
| **Hard pack filter** (all picks MUST be from anchor pack) | Brittle — if anchor pack has only 2 surface assets but plan needs 5, hard filter forces duplicates. Soft 1.3x boost degrades gracefully. Aligns with 2024-2025 source-bias literature (soft beats hard for user-perceived quality). |
| **Two-call `/tier2/pick` chain** (pick hero first server-side, then anchor and call again for landmark+surface) | Adds ~12s of LLM latency. The whole point of the parallel-preserving design is to keep cohesion essentially free. |
| **Move hero pick fully client-side** (constrain `/tier2/pick`'s hero enum to a single id) | Loses LLM creative taste on the most-photographed asset. The shortlist top-1 is rarely the *best* hero by taste; the LLM beats it consistently in pilot tests cited in the parent plan. |
| **Switch from MMR to greedy DPP** | The 2024-2025 trend favors DPP at this scale (~50 candidates, ~10 picks), but the cost/benefit is small (~5% diversity gain) and would mean rewriting the existing tested MMR path. Punt to v2; revisit if MMR-tuned diversity metrics still feel weak. |
| **localStorage `storage` event listener** for cross-tab ring-buffer sync | Two tabs is an uncommon usage pattern for a 3D game. Defer to v2; document as known limitation. |
| **Server-side recency tracking** (push the ring buffer into the Worker KV instead of localStorage) | Adds cross-device sync (player on phone and laptop would share diversity state) but introduces a network hop on every shortlist call. Current local-only behavior is correct for v1; revisit if Phase 7 (Poly Pizza) shows a need for cross-device asset state. |

## System-Wide Impact

### Interaction graph

```
Player surveys 100% on planet A (main.js:579-644 — claim handler)
  → markClaimed(planet)
      → planet.claimed = true
      → if (planet.meta?.selected_assets) AssetRetriever.markUsed([...6 IDs])
            → readRecent() → prepend new IDs → cap at RECENT_CAP=32 → writeRecent()
            → localStorage[`personalspace:recent-assets:v1:${userId || 'anonymous'}`]
      → existing path: logbookStore.add(), upsell.noteClaim(), Tier 3 lore fetch, thumbnail capture

Player commits toward planet B (main.js:240-284 — tryApproach)
  → llm.approach(seed, {radius})
      → /tier2/direct → biome, theme, palette, hints
      → AssetRetriever.shortlist (hero)         ← reads recent ring buffer, applies per-role decay
          → BM25 + dense (embedder warm) → RRF → recency → MMR (λ=0.5)
      → anchorPack = topPackOf(heroShortlist[0..3])
      → AssetRetriever.shortlist (landmark, surface) — parallel, with preferPack=anchorPack
          → ... → pack boost (1.3x same-pack) → recency → MMR
      → /tier2/pick (payload now {id, pack, family} per shortlist entry)
          → Haiku 4.5 strict-tool: picks honoring pack cohesion (system prompt nudge)
      → AssetCache.preload(allIds) → applyVisuals
          → planet.meta.selected_assets = sel  ← stash for later claim
          → if (planet.claimed) AssetRetriever.markUsed(sel)  ← late-arriving picks on already-claimed planet
```

### Error & failure propagation

- **`markUsed()` throws (localStorage quota / disabled in private mode)** → swallowed inside `markUsed`; logged as debug warning; claim continues. Recency state is best-effort, not load-bearing.
- **Hero shortlist empty (degraded retrieval)** → anchor pack is null; pack boost is no-op; flow degrades to the pre-Phase-6 parallel path. Telemetry logs the degradation.
- **`AssetRetriever.setUser()` not called yet at first shortlist** → falls back to anonymous key; one planet's diversity state lives under anonymous before the migration runs on next sign-in. Acceptable.
- **Anchor pack has 0 candidates for a role** → boost is a no-op; baseline ranking applies. Cohesion is best-effort by design.
- **LLM ignores the pack-cohesion nudge in system prompt** → not a failure, just a quality miss. Telemetry: per-planet pack-share metric exposed via debug hook for monitoring.
- **Material audit reports leaks** → it's a dev-only hook; doesn't gate runtime. Action: investigate the specific asset and either add a `matSlot` author tag in `gltf-transform` or whitelist via Phase 7 follow-up.

### State lifecycle risks

- **Two rapid claims race on the ring buffer.** Worst-case: both claims fire within same animation frame; both call `markUsed` synchronously. JS is single-threaded so the second call sees the first call's writes via `readRecent()`. Dedupe at the top of `markUsed` makes order stable. Verified by test scenario below.
- **Sign-in mid-session.** The migration is one-shot (only copies if user buffer doesn't exist). Subsequent sign-outs and sign-ins are no-ops. In-memory cached recent set in `AssetRetriever` (if any — current code re-reads localStorage on each shortlist) is invalidated on `setUser`.
- **Account delete.** Add `localStorage.removeItem(recentKeyFor(userId))` to the `AuthClient.deleteAccount` flow (if it exists; otherwise document as a follow-up tidy).
- **`approachSent.delete(seed)` after failure → retried approach picks fresh IDs.** Markeded only on successful applyVisuals, so retry doesn't double-mark. Late-arriving picks on an already-claimed planet *do* mark — correct, those are the assets actually visible to the player.

### API surface parity

- **Offline-claimed entries** (logbook plan reference) get `visualsLoaded: false` and don't yet have `selected_assets`. On reconnection backfill, if Phase 7's planned re-spawn-and-recapture flow lands, that's the right place to also call `markUsed`. Document as a Phase 7 hand-off.
- **`testAsset` debug hook** (`main.js:832`) mounts a GLB outside the planet's `applyVisuals` flow → doesn't appear in the material audit's per-planet walk (it's parented to the planet's group with `userData.testAsset`). Either include it in the audit with a clear tag, or filter it out. Default: filter it (test assets aren't expected to honor matSet).

### Integration test scenarios

1. **Claim → markUsed → next planet sees demotion.** Manually claim a planet with known `selected_assets`, then approach a second planet with similar biome. Assert at least one slot's top-3 shortlist *would have* matched a recent ID but didn't (or is ranked lower). Verified via `__GAME.testShortlist()` introspection.
2. **Sign-in migration.** Anonymous browse → claim 3 planets → sign in. Assert `personalspace:recent-assets:v1:anonymous` is empty, `personalspace:recent-assets:v1:<userId>` has the 18 IDs.
3. **Pack cohesion under hero load failure.** Mock a 404 on the hero's GLB URL after Tier 2 picks resolve. Assert landmarks + surface still come from the anchor pack derived pre-load (`topPackOf(heroShortlist[0..3])`).
4. **Material audit clean planet.** Mount a planet with hero + 3 landmarks + 2 surface assets. Assert `__GAME.auditMaterials()` reports 0 leaks. Toggle `__GAME.debugPlacement = true; refreshDebugPlacement()`; audit should *still* report 0 leaks (debug overlay exemption working).
5. **BM25-fallback diversity.** Force-disable the dense embedder (`__GAME.testShortlist` with a flag, or mock the failure path). Assert the resulting shortlist of 8 has at most ⌈8/2⌉ = 4 entries sharing the same first-token prefix.

## Acceptance Criteria

### Functional requirements

- [x] `markUsed([heroId, ...landmarkIds, ...surfaceIds])` is called synchronously inside `markClaimed` for every planet claim where `planet.meta.selected_assets` is populated.
- [x] `tryApproach`'s success path stashes `planet.meta.selected_assets = sel` (via `applyLLM`) and calls `markUsed` if the planet was claimed before picks resolved.
- [x] Recent-asset ring buffer is per-user-keyed; signed-in users have a private buffer; signed-out users share `:anonymous`.
- [x] On first sign-in, the anonymous buffer migrates to the user's buffer (latest-wins merge) and clears. *(Verified: anon buffer cleared, user buffer received data.)*
- [x] Recency demotion uses per-role smooth decay (hero h=12, landmark h=8, surface h=5); ring buffer cap is 32. *(Verified: marked hero dropped out of top-8.)*
- [x] Pack-cohesion bonus: landmark + surface shortlists apply a 1.3x score boost to assets sharing the hero-shortlist's anchor pack. *(Verified: pack-share 1→2 in top-15.)*
- [x] LLM `/tier2/pick` payload includes `{id, pack, family}` per shortlist entry (via `shortlist_meta`; bare-id `shortlist` retained for the enum + cache key).
- [x] MMR λ is 0.5 (down from 0.7).
- [x] BM25-only fallback path applies a first-token-prefix dedupe pass (max ⌈k/2⌉ entries share a prefix). *(Verified: crystal-heavy candidate set deduped in the back half.)*
- [x] `__GAME.auditMaterials()` is exposed and reports per-planet leak counts; exempts debug overlays, hero/terrain slots, procedural fallbacks, and Line/Sprite materials.
- [x] On a freshly mounted planet with 6 successful asset loads, audit reports 0 leaks. *(Verified: 8 clean meshes, 0 leaks, after tagging terrain `matSlot:'terrain'`.)*

### Non-functional requirements

- [ ] Phase 6 changes add ≤ 1 frame of latency to the Tier 2 pick path (the hero shortlist hop is the only sequential add).
- [ ] localStorage writes from `markUsed` are wrapped in try/catch — Safari private-mode quota errors don't break claims.
- [ ] No new console warnings on a clean planet load.
- [ ] Memory: the ring buffer cap grew 20 → 32, adding ~0.5 KB of localStorage. Negligible.

### Quality gates

- [x] All 5 integration test scenarios above pass (verified in dev via `evaluate_script` against the live retriever + a mounted planet).
- [ ] Visual review of 10 sample planets in dev mode (use `__GAME.testTier2(seed)` for known seeds): each reads as one cohesive place (pack-share ≥0.5 by visual inspection). *(Deferred to post-deploy prod validation — needs the live LLM worker, not available locally.)*
- [x] `__GAME.auditMaterials()` reports 0 leaks on the mounted test planet. *(Full 10-planet sweep deferred to prod.)*
- [ ] Asset reuse <30% across any 10-planet window for a single player. *(Deferred to post-deploy — needs a real claim session against the live worker.)*

## Success Metrics

- **Asset reuse:** <30% across any 10-planet window (target from parent plan, Phase 6 success criteria).
- **Pack-share:** 0.5-0.7 per planet (≥3 of 6 picks from the anchor pack). Below 0.4 means boost too weak; above 0.8 means MMR is being overrun. Tunable via the boost constant.
- **Material audit:** 0 leaks per planet across the 10-sample dev review. Any leak found is a follow-up tidy (likely an asset that needs a `matSlot` author tag).
- **Latency:** Tier 2 pick path p50 unchanged (the hero shortlist hop is the only sequential add, ~10-30ms on warm embedder).
- **Player perception** (qualitative): the "every planet looks like the last one" feeling subsides over a 5-claim session. Tracked by user feedback.

## Dependencies & Prerequisites

- Phase 2 (`AssetRetriever.shortlist`, MMR, recency, ring buffer) — shipped.
- Phase 3 (`/tier2/pick` Haiku strict-tool path) — shipped; payload schema change is additive (LLM ignores unknown fields, but we pass them in the prompt context so it can use them).
- Phase 4 (`Planet.applyVisuals`, `visualGen` cancellation) — shipped; the `selected_assets` stash hooks into this.
- Phase 10 (`applyMaterialSet`, `MaterialSet`) — shipped; the audit hook leverages the `userData.cloned` tag Phase 10 already sets.
- `AuthClient` user-id surface — exists; minor extension to expose `onUserChange` if not present.

## Risk Analysis & Mitigation

| Risk | Severity | Mitigation |
|---|---|---|
| **LLM ignores pack-cohesion nudge in system prompt** | Medium | Acceptable — cohesion is best-effort and pack-share telemetry will surface persistent ignores. If chronic, escalate to including `anchor_pack` as a required field in the tool schema so the model has to commit. |
| **Hero shortlist returns 0 results → no anchor** | Low | Pack boost is a no-op; flow degrades to baseline. Same retrieval-failure path as today. |
| **Anchor pack has fewer assets than role needs** | Low | Per-id cap prevents duplicates; remaining slots fall through to non-anchor candidates. Best-effort cohesion. |
| **Sign-in migration accidentally clobbers existing user buffer** | Medium | Migration is one-shot, gated on `!localStorage.getItem(userKey)`. Re-running setUser on the same user is idempotent. |
| **Material audit false-positive flood** (Phase 10 debug overlay or other unforeseen exemption miss) | Medium | Exemption list is in code, easy to extend. First dev run will surface any remaining categories; iterate. Audit is dev-only, not runtime-gating. |
| **Asset reuse target (<30%) not met after Phase 6 ships** | Low | Recency curve and pack-boost constants are tunable knobs (single-line constants). Add a `?retrieval=debug` URL flag exposing per-shortlist scores for in-flight tuning. |
| **Cross-tab ring-buffer divergence** | Low | Documented limitation. Defer storage-event sync to v2. |
| **Half-life formula has wrong age units** | Low | Buffer is index-ordered (LRU), so `age = ring.indexOf(id)` is the natural unit (claims-ago, not seconds). Document. |

## Resource Requirements

- **Time:** ~2-3 days solo dev (bumped from the parent plan's 1.5-day sketch due to the per-user keying + auth migration + audit hook surface SpecFlow surfaced).
- **Costs:** ~0 — all changes local to the browser + Worker payload enrichment (no new API calls).
- **External:** none.

## Future Considerations

- **Greedy DPP** in place of MMR (~5% diversity gain at this scale, cleaner math).
- **20-query golden set + dev-only diversity dashboard** (ILD + dispersion + coverage + pack-share + creator-share). Worth ~1 day if Phase 6 tuning runs into A/B questions.
- **LLM-as-judge weekly diversity audit** — Claude rates 10 random planets on "kit mashup feel (1-5)" + "monotony feel (1-5)".
- **Cross-tab storage-event sync** for serious shared-browser usage.
- **Server-side recent-asset state in Worker KV** if Phase 7 (Poly Pizza) reveals a cross-device sync need.

## Documentation Plan

- This plan in `docs/plans/2026-05-24-001-feat-planet-visuals-phase-6-diversity-cohesion-plan.md`.
- Update parent plan progress table to reference this sub-plan and PR.
- Add the new `__GAME.auditMaterials()` hook to the dev debug surface table (if a doc exists; otherwise inline JSDoc).
- Per-PR: short description with the 5 integration test scenarios as the test plan.

## Sources & References

### Origin

- **Parent plan:** `docs/plans/2026-05-23-001-feat-planet-visuals-llm-driven-assets-plan.md` — Phase 6 section (lines 705-718). Specific decisions carried forward: recency demotion + MMR are already shipped, this phase is *wiring* + *audit*; pack cohesion is "one pack per planet" not kit blending; MaterialSet override must be type-agnostic.
- **Research synthesis** (this turn): parallel agents on (a) ground truth in current codebase, (b) external best practices on diversity tuning at small catalog scale, (c) SpecFlow gap analysis on the proposed implementation.

### Internal references

- Current state of diversity infrastructure: `src/world/AssetRetriever.js:30,36,41,179,229-231,237,317-322`.
- Claim flow: `src/main.js:579-644` (claim block), `main.js:240-284` (tryApproach).
- LLM orchestration: `src/llm/LLMClient.js:111-189` (`_pickAssets`), `worker/src/routes/llm.js:48` (system prompt pack-cohesion nudge), `worker/src/routes/llm.js:181-186` (tool schema).
- Material override: `src/world/MaterialSet.js:88-116` (post-Phase-10 dual-axis path).
- Auth: `src/auth/AuthClient.js:21,47-48`.
- Procedural landmark fallbacks: `src/world/Landmarks.js:154-208`.
- Debug overlay (Phase 10): `src/world/DebugPlacement.js` — exemption source.

### External references

- [Adaptive Collaborative Filtering with Personalized Time Decay (RecSys '23)](https://dl.acm.org/doi/10.1145/3604915.3608832) — half-life parametric decay rationale.
- [APAED: Adaptive Parameter Exponential Decay (MDPI 2025)](https://www.mdpi.com/2076-3417/15/17/9577) — exponential decay family for recency.
- [Recency Dropout for Recurrent Recommenders (arXiv 2201.11016)](https://arxiv.org/pdf/2201.11016) — per-role demotion asymmetry.
- [Diversity in Recommendations: MMR (Agrawal, Dec 2025)](https://aayushmnit.com/posts/2025-12-25-DiversityMMRPart1/DiversityMMRPart1.html) — λ=0.5 recommendation for small catalogs.
- [OpenSearch Vector Search with MMR Reranking (2025)](https://docs.opensearch.org/latest/vector-search/specialized-operations/vector-search-mmr/) — production MMR tuning patterns.
- [Ranking by Relevance in Academic Searches (Springer 2024)](https://link.springer.com/article/10.1007/s42438-024-00530-z) — soft source bias > hard filter.
- [Do LLMs Favor Recent Content? Recency Bias in LLM Rerankers (SIGIR-AP 2025)](https://dl.acm.org/doi/10.1145/3767695.3769493) — LLM reranker recency bias caveat (relevant if Phase 6 ever adds an LLM rerank layer).
- [A Critical Reexamination of Intra-List Distance and Dispersion (arXiv 2305.13801)](https://arxiv.org/pdf/2305.13801) — ILD + dispersion as paired diversity metrics for the future eval dashboard.
- [Statsig: Golden Datasets for Evaluation](https://www.statsig.com/perspectives/golden-datasets-evaluation-standards) — golden-set methodology for the deferred eval framework.

### Related work

- Logbook cloud-memoir plan: `docs/plans/2026-05-20-001-feat-logbook-cloud-memoir-plan.md` (claim flow patterns referenced).
- Phase 10 (placement + dual-axis color): just-shipped at PR #15.
