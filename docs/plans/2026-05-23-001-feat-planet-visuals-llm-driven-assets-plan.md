---
title: Planet visuals — LLM-driven 3D asset selection
type: feat
status: active
date: 2026-05-23
supersedes: plan.md Phase 3+ entries "Planet visuals workstream" and "Planet discovery lifecycle review"
---

# Planet visuals — LLM-driven 3D asset selection

## Progress

| Phase | Status | PR | Notes |
|---|---|---|---|
| 1. Catalog scaffolding + AssetCache + MaterialSet | ✅ Shipped | [#10](https://github.com/kkoppenhaver/personal-space/pull/10) | Loader pipeline (`GLTFLoader` + `DRACOLoader` + `KTX2Loader` + `MeshoptDecoder`), per-planet `MaterialSet`, `__GAME.testAsset()` debug hook. Catalog content is a separate manual workstream. |
| 2. Embedding pipeline + AssetRetriever + Welcome-Modal warmup | ✅ Shipped | [#11](https://github.com/kkoppenhaver/personal-space/pull/11) | Hybrid BM25 + MiniLM + RRF + MMR + recency demotion; welcome modal doubles as MiniLM warmup window (ambient amber progress bar, no MB count). |
| 3. Tier 2 split into direct + pick | ✅ Shipped | [#12](https://github.com/kkoppenhaver/personal-space/pull/12) | `/tier2/direct` extended with creative-direction fields (theme, density, hint arrays); new `/tier2/pick` uses Haiku 4.5 strict-tool enum-per-slot. In-flight cap of 2; threshold guard; degraded-pick fallback. Requires `wrangler deploy`. |
| 4. Planet construction refactor + cancellation tokens | ✅ Shipped | [#14](https://github.com/kkoppenhaver/personal-space/pull/14) | `Planet.applyVisuals()` binds hero/landmark/surface GLBs via `AssetCache` + `MaterialSet`. `visualGen` token guards against despawn-during-load. `pickLandmarkSlots` expanded with spire + coast detection. Catalog seeded with **555 CC0 assets across 13 kits** (Kenney + Quaternius + KayKit); biome strings aligned to the LLM enum verbatim with per-filename refinement. **Confirmed end-to-end in prod** (personalspace.fun) — GLBs mount on approached planets. **Related fixes shipped same PR:** client Tier 2/3 timeout 12s → 25s (Sonnet 4.6 ~14s p50), RRF threshold 0.05 → 0.01 (the 0.05 was set thinking cosine but `_pickAssets` checks fused RRF scores which max ~0.033), placeholder Tier 2 emits hints so dev mode also exercises pick, intent gate pulled forward from Phase 5 since the latency math demanded it. |
| 5. Reveal-as-you-fly | ⌛ Pending | — | Fade-in shader (distant vs late curves), atmospheric haze, distance-gated LOD, thumbnail-capture defer. (Intent gate already shipped in #14.) |
| 6. Diversity guardrails + style cohesion enforcement | ⌛ Pending | — | Recent-asset demotion wiring (the retriever supports it; need to call `markUsed()` post-claim), pack-cohesion retrieval bonus, end-to-end MaterialSet enforcement. |
| 7. Poly Pizza dynamic + attribution UX | ⌛ Pending | — | Worker proxy + KV cache + per-entry attribution in logbook detail view. |
| 8. Performance pass | ⌛ Pending | — | Hard 2-system cap on full-realization, frustum culling re-enable, ORT WASM CDN config (currently bundled to dist but served from jsdelivr at runtime — bloat is harmless but worth cleaning). |
| 9. LLM latency reduction | ⌛ Pending | — | **Observed in prod:** Sonnet 4.6 `/tier2/direct` ≈14s p50, Haiku 4.5 `/tier2/pick` ≈12s p50, Tier 1 ≈1s. Even with the intent gate hiding latency behind approach flight time, planets often render as procedural-fallback for several seconds before GLBs swap in. Ideas to explore: (a) streaming the direct response so retrieval + pick can start the moment the first hint tokens arrive (cuts ~3-4s); (b) splitting `/tier2/direct` into a fast "biome + density + hints" core call and a slower "atmospheric prose + landmark names" deferred call so visuals fire on the fast half; (c) mixing models — Haiku for biome/hints (~3s), Sonnet only for the narrative prose layer; (d) speculative warm-up of `/tier2/direct` on the *adjacent* system at the moment a system spawns, so the seed is already cached before the player commits; (e) per-biome cached prompt prefix that lets the worker cache-hit Anthropic's 5-min prompt cache more often. Each option has a cost/quality tradeoff worth measuring. |
| 10. Asset placement + color variation | ⌛ Pending | — | **Two sub-problems observed in prod (Velundra screenshot):** <br><br>**A. Placement.** Loaded GLBs often float above the surface (windmill prop is the canonical case) or land on tilted pedestals. Root causes: (1) `buildLandmarkInstance` positions the GLB *origin* on the slot's surface point, but many GLBs have origin at center or even above-base — they need a per-asset `bbox.min.y` offset along the surface normal so the visible base actually touches the terrain. (2) Some assets are Z-up, not Y-up — needs a per-creator/per-pack rotation override on load. (3) Per-asset `scale_range` is coarse (kit-level default); a few outliers read as oversized. Deliverables: compute + cache `boundingBox` per loaded GLB; ground-snap on mount using `bbox.min.y`; per-pack axis-up override map; debug overlay (`__GAME.debugPlacement = true`) drawing bbox + surface normal + axis gizmo on every mounted asset for visual review; per-asset `scale_override` field in `catalog.source.json` for hand-tuned outliers. Stretch: physics raycast against terrain at mount time for exact contact-point grounding. <br><br>**B. Color variation within the palette.** Today every flora/rock/landmark on a planet shares the exact same `matSet.flora`/`rock`/`landmark` material (per-planet cloned but identical), giving a flat monochromatic look that reads as "single solid color" rather than "cohesive palette." Goal: keep tight per-planet cohesion (we still want palette-cousin colors) but add deterministic per-asset HSL nudges so each instance varies subtly. Deliverables: in `applyMaterialSet`, derive a small HSL offset per mesh from a hash of its asset id (hue ±5°, saturation ±15%, lightness ±10% — tune in pilot); seeded variation = deterministic between visits; preserve the slot-tag (rock/flora/landmark) family identity; visual review of 5 sample planets to confirm "varied but cohesive." Optional stretch: vary the variation *amount* per material slot (rocks tighter than flora, etc). |

**Related fixes shipped alongside:**
- [#13](https://github.com/kkoppenhaver/personal-space/pull/13) — `fix(hud)`: claim bar now starts empty on atmosphere entry instead of ~50%. Coverage baseline-snapshot fix; surfaced during Phase 3 testing.

---

## Enhancement Summary

**Deepened:** 2026-05-23 (same day as initial plan write) via parallel research agents on five sections.

**Research agents run:**
1. In-browser hybrid retrieval (transformers.js + MiniSearch + RRF + MMR tuning)
2. Three.js GLB loading, caching, instancing patterns (r170+)
3. Anthropic strict tool use with enum constraints (May 2026 production patterns)
4. Style cohesion across multi-creator GLBs (No Man's Sky / Astroneer references)
5. Three.js performance under streamed-world conditions

**Key changes propagated into the plan body:**

1. **Pick-stage LLM downgraded from Sonnet 4.6 to Haiku 4.5.** Strict-mode enum makes hallucination impossible by construction; benchmarks show Haiku 4.5 is genuinely competitive for 10-15 item rank-judgment tasks. Cuts pick-stage cost ~3×.
2. **MMR added** as a step after recency demotion. They solve different problems (temporal vs. intra-result similarity); both are cheap.
3. **Tool schema:** enum-per-slot (`{hero: enum, secondary: enum, ...}`) instead of array-of-enum. Sidesteps `maxItems` non-enforcement; better grammar caching.
4. **Loader stack** includes KTX2Loader + MeshoptDecoder from Phase 1 (not deferred to Phase 8). Trivial setup; massive VRAM savings.
5. **`BatchedMesh` (r170+ stable)** replaces some `InstancedMesh` uses for heterogeneous-static landmark variants.
6. **Distance-gated loading** replaces `THREE.LOD` for the streaming-world case. LOD only used within the hero ring (active planet).
7. **`customProgramCacheKey`** returning a constant string is added to the material-override pattern to prevent shader-program explosion (one program shared across all overridden materials).
8. **Frustum culling under floating origin:** leave `frustumCulled=true` on regular meshes (works fine); only disable on InstancedMesh + cull at the chunk level. Reverses the blanket-disable currently in place (`a9caa41`).

Research insights appended to relevant sections below. Full source citations in **Sources & References** at the bottom.

---

## Overview

Replace the procedural-primitive-only planet visuals (icosahedron terrain + cone/torus landmark primitives + tetrahedron rock instances + cone tree instances) with a system where **the LLM acts as creative director, selecting curated 3D assets from a multi-source CC0 + CC-BY catalog** to populate each planet. Asset selection happens at Tier 2 (on approach) so the planet visually "reveals itself" as the player closes — a discovery beat aligned with Personal Space's brand promise that *each player's galaxy is uniquely theirs and worth remembering*.

The selection pipeline is **hybrid retrieve-then-constrain**: the first Tier 2 call returns creative direction (biome + theme + density + free-form style hints); a browser-side hybrid index (BM25 + MiniLM embeddings via RRF) shortlists ~10 candidates per slot; a second Anthropic strict-tool-use call picks final asset IDs from an enum constrained to the shortlist. Zero hallucination by construction, semantic taste applied to a curated short list.

Each planet is composed as **backdrop biome kit + thematic overlay kit**, with per-planet style cohesion enforced via a single `MaterialSet` derived from the LLM-supplied palette. Density is theme-driven with a sparse-leaning bias and occasional lush wildcards.

**This plan supersedes** the `plan.md` Phase 3+ entries "Planet visuals workstream" and "Planet discovery lifecycle review" — those flagged the work; this is the design.

## Problem Statement

The current visual layer (built `src/world/Planet.js:7-74`) produces serviceable but **forgettable** planets. Concretely:

1. **Primitives everywhere.** Landmarks are `ConeGeometry(2,12,5)` peaks or `TorusGeometry(4.5,0.5,6,16)` basins (`src/world/Landmarks.js:82,91`). Surface features are `TetrahedronGeometry(1)` rocks and `ConeGeometry(0.9,2.2,5)` flora (`src/world/Features.js:54,75`). No 3D model is loaded anywhere in the codebase — `grep` for `GLTFLoader|loadAsync|.glb|.gltf` returns zero matches. Every planet looks like every other planet, modulated only by 6-color palette variation.

2. **LLM influence is purely cosmetic.** `Planet.applyLLM(meta)` (`src/world/Planet.js:94-110`) only retints vertex colors when Tier 2 returns a new palette. Landmark and feature geometry stay primitive — and even materials on landmarks/features keep their original palette derivation (`Landmarks.js:82,91`; `Features.js:54,75`), so a re-tint creates internal inconsistency.

3. **Schema implies more than gets built.** `Prompts.js:64` accepts landmark `kind ∈ {peak, basin, coast, spire}` from Tier 2, but `buildLandmarkMeshes` only constructs peak and basin (`Landmarks.js:75-104`). `coast` and `spire` are silently dropped — the LLM can request things that never appear.

4. **No variety beyond noise + palette.** Two planets in the same biome with similar palettes will look almost identical. Given per-user galaxy seeds (every player's planets are unique), this scales poorly — there is no shared library of "you saw this on Reddit, want to visit?" planets, so each player's planets must themselves be visually memorable.

5. **The logbook thumbnail is the player's only artifact.** Once a player leaves, the planet is gone. The thumbnail (`src/logbook/ThumbnailCapture.js:62-69`) captures what they saw. Today it captures procedural primitives. The artifact is exactly as memorable as the planet was.

The bar to clear: **every planet should earn its place in the player's logbook on visual merit alone**.

## Proposed Solution

A three-layer system:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Asset catalog          (~150 CC0 assets bundled + Poly Pizza CC-BY) │
│  src/world/assets/                                                   │
│  • catalog.json          metadata + embeddings (built offline)       │
│  • bundled GLBs          shipped via Cloudflare Pages                │
│  • Poly Pizza fetched    via Worker proxy (CORS, caching)            │
└─────────────────────────────────────────────────────────────────────┘
            ▲
            │ shortlist(slot_hints) → top-K candidates per slot
            │
┌─────────────────────────────────────────────────────────────────────┐
│  Hybrid retrieval         (in-browser, transformers.js MiniLM)       │
│  src/world/AssetRetriever.js                                         │
│  • BM25 over tag clouds   (minisearch ~10 KB)                        │
│  • Dense over MiniLM-384  (~22 MB model, ~10 ms / query)             │
│  • RRF fusion             score-scale agnostic                       │
│  • Diversity demotion     recent-asset penalty                       │
└─────────────────────────────────────────────────────────────────────┘
            ▲
            │ asks LLM to pick from shortlist
            │
┌─────────────────────────────────────────────────────────────────────┐
│  LLM pipeline             (creative direction → constrained pick)    │
│  worker/src/routes/llm.js                                            │
│  • Tier 2 call 1          free-form direction + style_hints[]        │
│  • Tier 2 call 2          strict tool, enum = shortlist asset IDs    │
│  • Cache key includes     identity tuple + recent-asset list         │
└─────────────────────────────────────────────────────────────────────┘
            ▲
            │ selected asset IDs + palette + density
            │
┌─────────────────────────────────────────────────────────────────────┐
│  Planet construction      (deferred build; fade-in reveal)           │
│  src/world/Planet.js (refactored)                                    │
│  • Eager:   geometry + sampler + collider                            │
│  • Deferred: landmarks + features (built from selected assets)       │
│  • MaterialSet derived from palette enforces per-planet cohesion     │
│  • Fade-in shader: 500 ms alpha ramp on newly-mounted meshes         │
└─────────────────────────────────────────────────────────────────────┘
```

Key properties:

- **Reveal-as-you-fly.** Terrain is up immediately on planet construction (seed-deterministic). Landmarks + features bind only after Tier 2 returns and assets load. Atmospheric haze + a 500 ms fade-in shader hide the pop-in.
- **Zero hallucination.** LLM final pick is enum-constrained to assets that exist. No "asset_id not found" failure mode.
- **Style cohesion per planet.** Single `MaterialSet` object derived from the LLM-returned palette is the *only* color source for terrain, landmarks, and features. Cross-planet variety stays high; intra-planet clutter stays low.
- **Per-user diversity.** A localStorage ring buffer of the last 20 asset IDs used by this user demotes them in retrieval; prevents "every planet looks like crystals" failure mode.
- **Cacheable.** Worker KV cache key already includes the full context; we just need to hash the shortlist into the key for the second call.
- **Phaseable.** Each phase ships independently. Phase 1 stands alone (deterministic biome-to-asset lookup; no LLM changes). Phases 2 and 3 layer the LLM intelligence on top.

## Technical Approach

### Architecture

```
Browser (personalspace.fun, Cloudflare Pages)
  ├── Game (Three.js + Rapier)
  ├── src/world/
  │   ├── Galaxy.js                — unchanged
  │   ├── SolarSystem.js           — unchanged
  │   ├── Planet.js                — refactored: deferred landmark/feature build
  │   ├── TerrainGen.js            — unchanged
  │   ├── Landmarks.js             — replaced: now binds to selected GLBs
  │   ├── Features.js              — replaced: now instances from selected GLBs
  │   ├── MaterialSet.js           — NEW: single per-planet material source
  │   ├── AssetCache.js            — NEW: GLB loader + module-level Map cache
  │   ├── AssetRetriever.js        — NEW: hybrid BM25 + MiniLM retrieval
  │   ├── assets/
  │   │   ├── catalog.json         — generated; metadata + embeddings
  │   │   └── bundled/             — CC0 GLBs (Draco-compressed)
  │   └── FadeInShader.js          — NEW: alpha ramp wrapper material
  └── tools/
      └── embed-catalog.js         — build-time embedding pre-computation

Cloudflare Worker (api.personalspace.fun)
  ├── worker/src/routes/llm.js     — Tier 2 split into 2 calls; pick handler
  ├── (new) worker/src/routes/assets.js
  │   └── /assets/polypizza        — proxy + embed Poly Pizza assets on demand
  └── Bindings (existing):
      DB (D1), THUMBS (R2), LLM_CACHE (KV)
  └── New binding:
      ASSET_CACHE (KV) — Poly Pizza GLBs + their embeddings
```

### Asset catalog schema

`src/world/assets/catalog.json` (generated by `tools/embed-catalog.js`):

```json
{
  "version": 1,
  "generated_at": "2026-05-23T00:00:00Z",
  "assets": [
    {
      "id": "quaternius:nature:tree_oak_01",
      "pack": "quaternius_nature",
      "creator": "Quaternius",
      "license": "CC0",
      "attribution": null,
      "url": "/assets/bundled/quaternius/nature/tree_oak_01.glb",
      "thumbnail_url": "/assets/bundled/quaternius/nature/tree_oak_01.jpg",
      "role": "surface",
      "tags": ["tree", "oak", "deciduous", "tall", "forest"],
      "biome_affinity": ["jungle", "temperate_forest", "ruined_city"],
      "theme_affinity": ["ancient", "overgrown"],
      "scale_range": [2.0, 6.0],
      "draw_cost": 1,
      "embedding": [0.0231, -0.0847, 0.1102, ...]
    }
  ]
}
```

**Roles** (drives slot routing):
- `hero` — visible from approach silhouette; ≤ 3 per planet; e.g., crystal monoliths, towers, statues.
- `landmark` — anchors for Tier 3 lore; framed in thumbnail; 3-5 per planet.
- `surface` — populated densely (10-200 instances); flora, rocks, small structures.
- `decor` — small details; scattered freely.

**License handling:**
- `CC0` → no attribution required; bundled directly.
- `CC-BY` → attribution string mandatory; surface attribution in logbook entry detail view.

### LLM tier pipeline (redesigned)

**Tier 1 (Haiku)** — unchanged. Returns `{teaser}` on system spawn for the ping strip.

**Tier 2 (Sonnet)** — now **two calls** chained.

*Call 1 — creative direction:*
```json
{
  "name": "Velax-Theia",
  "biome": "crystal_barrens",
  "theme": "abandoned_observatory",
  "density": "sparse",
  "atmosphere": "thin violet, low gravity",
  "palette": { "water": "...", "low": "...", "mid": "...", "high": "...", "snow": "...", "sky": "..." },
  "hero_landmark_hints": ["towering obsidian spire crowned with a broken crystal lens"],
  "surface_feature_hints": ["small angular crystal shards", "wind-worn ridges"],
  "landmark_anchor_hints": ["abandoned observation platform", "shattered telescope ring"],
  "thumbnail_framing_hint": "looking up at the spire from a low ridge"
}
```

*Browser shortlists* with `AssetRetriever.shortlist(slot_hints, planet_seed)`:
- Per slot type (`hero`, `surface`, `landmark`), runs hybrid BM25+MiniLM with RRF fusion over the catalog filtered by `role` and `biome_affinity`.
- Returns top-K per slot (K = 8 for hero, 15 for surface, 10 for landmark).
- Recent-asset demotion (last 20 per user) applied as multiplicative penalty.

*Call 2 — final pick* (**Haiku 4.5** strict tool use; was originally specced as Sonnet 4.6 — deepen-plan research showed Haiku 4.5 is equivalent for enum-constrained rank judgments and 3× cheaper):

```ts
// tool schema — enum-per-slot (NOT array[enum]); strict: true
{
  name: "pick_assets",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["hero", "landmark_a", "landmark_b", "landmark_c", "surface_a", "surface_b", "rationale"],
    properties: {
      hero:       { type: "string", enum: [/* top-K hero IDs */] },
      landmark_a: { type: "string", enum: [/* top-K landmark IDs */] },
      landmark_b: { type: "string", enum: [/* top-K landmark IDs */] },
      landmark_c: { type: "string", enum: [/* top-K landmark IDs */] },
      surface_a:  { type: "string", enum: [/* top-K surface IDs */] },
      surface_b:  { type: "string", enum: [/* top-K surface IDs */] },
      rationale:  { type: "string" }
    }
  }
}
```

**Why enum-per-slot, not `array[enum]`:** Anthropic strict mode only honors `minItems: 0|1` and ignores `maxItems` entirely. Enum-per-slot enforces exact slot count at the schema level. Also gives clearer grammar-compile cache (schema shape is stable across requests; only enum contents change → compiled grammar reuses).

**Why Haiku 4.5 for this call:** strict-mode enum eliminates hallucination axis entirely. The remaining task is rank judgment over ~10-15 items — well within Haiku's range. Sonnet 4.6 stays on Call 1 where creative prose taste matters; Haiku takes over for the constrained pick. ~3× cost reduction on the pick stage, no measurable quality loss in pilot tests cited in research.

**Tier 3 (Sonnet)** — unchanged. Returns `{surfaceLore, landmarkLore[]}` keyed by `slotId`. Landmark slots now refer to chosen asset placements (set during planet construction), so blurbs cohere with the actual visible objects.

### Research insights — LLM tier pipeline

**Cache control strategy:**
- Do **not** put `cache_control` on the tool block. Shortlists change every request → 1.25× write tax with ~0% hit rate.
- **Do** put `cache_control` on a static system prompt containing the art-direction style guide / selection heuristics. That prefix survives across requests.
- Worker KV cache key for the pick call: hash `(slotSchemaVersion, sortedShortlistIds, creativeDirectionHash, modelId)`. Sorting IDs before hashing is critical — same shortlist in different order should hit.

**Prompt patterns (production guidance):** rank-aware prompts pull the model off rank-1. Example phrasings to include in the pick-call system prompt:
- "Candidates are retrieval-ranked by surface similarity, not by taste. Your job is to apply art direction. Picking rank-1 every time means the retriever is doing your job."
- "Avoid theme collisions: if hero is crystal-themed, secondary picks should add contrast (organic / mechanical / atmospheric) unless creative direction explicitly calls for monothematic."
- Require `rationale` to reference (a) the creative direction phrase it serves, (b) the candidate's distinct quality vs. shortlist alternatives.

**Failure modes (corrections to original plan):**
- Out-of-enum response is **impossible by construction** under strict mode — grammar-constrained sampling. The "retry on enum violation" path can be dropped.
- Realistic failures: grammar-compile 400 on new schema shape, `stop_reason="end_turn"` without tool call (force with `tool_choice`), `stop_reason="max_tokens"` (bump limit), bad taste (log + fall back to retrieval top-1 only after N tries with temperature jitter).

**Asset ID format:** prefer short readable IDs (`q_nature_oak_01`) over UUIDs in the enum. Saves ~3× tokens in the enum and helps the model's own rationale-writing reason about picks.

**Sources:** [Anthropic strict tool use docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use), [Structured outputs / JSON schema limits](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [Prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [Verma — UUID hallucination & enums](https://nikhil-verma.com/blog/llms-unreliable-narrators-uuid-hallucination/), [Claude Sonnet 4.6 vs Haiku 4.5 selection guide](https://claudelab.net/en/articles/claude-ai/claude-sonnet-46-vs-haiku-45-model-selection-guide).

### Hybrid retrieval implementation

In-browser via [transformers.js](https://huggingface.co/docs/transformers.js):

```js
// src/world/AssetRetriever.js (sketch)
import { pipeline } from '@xenova/transformers';
import MiniSearch from 'minisearch';
import catalog from './assets/catalog.json';

const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true });
const bm25 = new MiniSearch({ fields: ['tags','biome_affinity','theme_affinity'], storeFields: ['id','role'] });
catalog.assets.forEach(a => bm25.add({ ...a, tags: a.tags.join(' '), ... }));

export async function shortlist(slotHints, slotType, k, recentIds) {
  const query = slotHints.join(' ');
  const queryEmb = await embedder(query, { pooling: 'mean', normalize: true }).data;
  const dense = denseSearch(queryEmb, slotType, k * 3);   // cosine over catalog embeddings
  const sparse = bm25.search(query, { filter: a => a.role === slotType }).slice(0, k * 3);
  const fused = reciprocalRankFusion(dense, sparse, 60);
  return demoteRecent(fused, recentIds).slice(0, k);
}
```

Sizes: `Xenova/all-MiniLM-L6-v2` quantized = ~22 MB, ~10 ms / query on M-class hardware. For 500 assets × 384-dim float embeddings = ~800 KB shipped statically. Total addition to bundle: ~23 MB, gzipped ~7 MB. Acceptable given Rapier WASM (~1.2 MB) and Three.js (~620 KB) are already shipped.

### Research insights — hybrid retrieval

**Embedder configuration (2026):**
- Set `dtype: 'q8'` and `device: 'webgpu'` with WASM fallback. WebGPU is broadly shipped on Chromium / Safari TP / Firefox Nightly in 2026; 3-10× faster than WASM but cold-compile cost is higher (~300-600ms). Since the game already initializes WebGL for Three.js, the WebGPU path is essentially free.
- `env.useBrowserCache = true` (default) backs by Cache API. Subsequent visits skip the 22 MB download.
- **Load triggers:** first-time visitors get the model fetched during the welcome modal (warmup window). Returning visitors hit browser cache → ~200 ms `preloadEmbedder()` init kicked off at game-interactive, in background. The pure "lazy on first retrieval call" pattern is only a fallback for the rare case where neither path completed before the player's first approach.
- **Alternative if 22 MB is too much:** `Supabase/gte-small` is a drop-in replacement (~9 MB q8) and scores higher on MTEB (61.4 vs 56.3) at the same 384 dims. Snowflake/snowflake-arctic-embed-xs is another option.

**MiniSearch field weighting + tokenization:**
```js
const ms = new MiniSearch({
  fields: ['name', 'tags', 'biome_affinity', 'theme_affinity'],
  storeFields: ['id', 'role'],
  extractField: (doc, f) => Array.isArray(doc[f]) ? doc[f].join(' ') : doc[f] ?? '',
  processTerm: (term) => term.toLowerCase().replace(/[_-]/g, ' ').split(/\s+/).filter(Boolean),
  searchOptions: {
    boost: { tags: 3, biome_affinity: 2, theme_affinity: 1.5, name: 1 },
    fuzzy: 0.2,    // ~1 edit per 5 chars; documented sweet spot for tag tokens
    prefix: true,
    combineWith: 'OR',
    filter: (r) => allowedRoles.has(r.role)
  }
});
```

**RRF tuning on small (<500 item) catalogs:** k=60 is robust but not optimal. On small catalogs BM25 alone is often within 5% recall of hybrid because IDF is unstable at this scale — that's exactly why **rank-based** RRF is safer than weighted-score fusion. Retrieve top-20 from each retriever, fuse to top-8 shortlist. If A/B testing shows BM25 dominating, drop k to 30.

**Diversity: MMR added to the pipeline.** Recency demotion (temporal) and MMR (intra-shortlist similarity) solve different problems; both are cheap and we should do both:

```js
// 1. recency demote then 2. MMR
const demoted = fused.map(([id, s]) => [id, s * (recentlyShown.has(id) ? 0.3 : 1)]);

function mmr(candidates, queryVec, docVecs, k=8, lambda=0.7) {
  const picked = [], pool = [...candidates];
  while (picked.length < k && pool.length) {
    let best = -Infinity, bestIdx = 0;
    pool.forEach((c, i) => {
      const rel = cos(queryVec, docVecs[c.id]);
      const div = picked.length
        ? Math.max(...picked.map(p => cos(docVecs[p.id], docVecs[c.id])))
        : 0;
      const score = lambda*rel - (1-lambda)*div;
      if (score > best) { best = score; bestIdx = i; }
    });
    picked.push(pool.splice(bestIdx,1)[0]);
  }
  return picked;
}
```

λ=0.7 is the canonical default (leans relevance). Drop to 0.5 if shortlist feels too samey.

**Pre-compute pipeline (`tools/embed-catalog.js`):**
- Use the **exact same model + dtype + pooling + normalize** as the browser. Mismatched dtype between Node (FP32) and browser (q8) produces small drift — usually fine for cosine, but verify by re-embedding one known item at boot and asserting cosine > 0.98 vs stored.
- Verify on first runtime load: assert `embeddings.dim === 384` and `embeddings.model` matches runtime config. Catches model drift across versions.
- Size budget: 500 items × 384 × 4 bytes = ~750 KB raw, ~300 KB gzipped. Don't bother quantizing stored vectors at this size.

**Debug recall:** build a 30-line `?debug=retrieval` panel that logs `{query, dense_topN: [{id, cos}], sparse_topN: [{id, bm25}], rrf_contrib: [{id, dense_rank, sparse_rank, dense_contrib, sparse_contrib, total}]}`. The score breakdown table tells you instantly whether dense or sparse dominated a bad pick. Maintain a tiny `golden.json` of `{query: [expected_ids]}` and run it on every catalog change as a CI check.

**Sources:** [Xenova/all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2), [transformers.js docs](https://huggingface.co/docs/transformers.js/en/index), [MiniSearch options](https://lucaong.github.io/minisearch/types/MiniSearch.Options.html), [Cormack RRF — BigDataBoutique](https://bigdataboutique.com/blog/reciprocal-rank-fusion-how-it-works-and-when-to-use-it), [Elastic MMR guide](https://www.elastic.co/search-labs/blog/maximum-marginal-relevance-diversify-results), [WebGPU vs WASM benchmarks](https://www.sitepoint.com/webgpu-vs-webasm-transformers-js/).

### Planet construction refactor

Today `Planet`'s constructor builds geometry + sampler + landmarks + features + collider all eagerly (`Planet.js:7-79`). After refactor:

**Eager (in constructor, seed-only):**
- `geometry`, `elevations`, `palette` (default biome palette before LLM override)
- `mesh` (terrain) with a `MeshLambertMaterial` driven from the MaterialSet
- `sample` (terrain sampler for nav math)
- `Coverage` tracker
- Rapier trimesh collider
- Empty `landmarkGroup` and `featuresGroup` placeholders

**Deferred (in `Planet.applyVisuals(spec)`):**
- LLM-returned `palette` overrides the default; vertex colors retinted (existing `_reTintVertexColors`).
- `MaterialSet` rebuilt from the new palette.
- Selected hero/landmark/surface GLBs loaded via `AssetCache.get(id)` (returns cached or fetched).
- `Landmarks.js` rebuilt: each `landmark_id` becomes an instance placed at an existing landmark slot (peak/basin/coast/spire), scaled per asset metadata.
- `Features.js` rebuilt: surface IDs become `InstancedMesh`es with placement filtered by biome elevation bands.
- All new meshes mounted to `planet.group` wrapped in a `FadeInMaterial` that ramps alpha from 0 → 1 over 500 ms.

`Planet.applyLLM` keeps the existing palette-retint path for backward compatibility; new code calls `applyVisuals`.

### Style cohesion enforcement: MaterialSet

```js
// src/world/MaterialSet.js
export function buildMaterialSet(palette) {
  return {
    terrain:  new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
    rock:     new THREE.MeshLambertMaterial({ color: shade(palette.high, 0.9), flatShading: true }),
    flora:    new THREE.MeshLambertMaterial({ color: shade(palette.low, 0.85), flatShading: true }),
    landmark: new THREE.MeshLambertMaterial({ color: palette.snow, flatShading: true }),
    hero:     new THREE.MeshLambertMaterial({ color: palette.high, flatShading: true }),
    sky:      palette.sky,
  };
}
```

All planet-mounted meshes pull from this set. GLB-internal materials are overridden on load (`mesh.traverse(m => { if (m.isMesh) m.material = matSet[m.userData.matSlot || 'flora']; })`). This is the lever that makes a Kenney pirate ship and a Quaternius oak tree look like they belong on the same planet.

### Research insights — style cohesion

**Shipped AAA validation.** [Astroneer's art-of post](https://blog.astroneer.space/p/the-art-of-astroneer-low-poly/) — *no textures at all* on terrain, flat shading, 12-17 colors per planet baked into vertex colors. Their cohesion comes from (a) shared shader, (b) tight per-planet palette, (c) post-process LUT. Validates our `MeshLambertMaterial` + vertex-color pipeline as a legitimate AAA-shipped approach.

**No Man's Sky pattern ([Duncan GDC 2015 "How I Learned to Love Procedural Art"](https://www.gdcvault.com/play/1024265/Continuous-World-Generation-in-No)):** biome is a *recipe*, not a fixed scene. Recipe holds palette, atmosphere uniforms, prop tags allowed, density curves. Same base mesh tinted/scaled per biome (their "morph + recolor" pipe). Translates directly: one `tree_pine.glb` reused across 20 planets, recolored via the `flora` slot.

**Readability rule:** vary *value (lightness) and saturation* more than hue within a single planet. Flora gets a contrasting hue slot; rocks get desaturated/darker terrain; landmarks get the accent. Don't randomize hue — sample from the palette intentionally.

**`customProgramCacheKey` to prevent shader explosion:** when materials are cloned per-planet AND patched via `onBeforeCompile` (e.g. for atmosphere tint), each clone normally recompiles its own shader program → quickly hits the GPU's program limit. Solution:

```js
function patchForAtmosphere(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSkyTint = skyUniforms.uSkyTint;
    shader.uniforms.uSkyStrength = skyUniforms.uSkyStrength;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform vec3 uSkyTint;\nuniform float uSkyStrength;`)
      .replace('#include <fog_fragment>',
        `#include <fog_fragment>\ngl_FragColor.rgb = mix(gl_FragColor.rgb, uSkyTint, uSkyStrength * (1.0 - exp(-0.0005 * vFogDepth)));`);
  };
  mat.customProgramCacheKey = () => 'planetAtmo';   // ALL patched materials share one compiled program
}
```

Without `customProgramCacheKey`, every clone recompiles. With it returning a constant string, all atmosphere-patched materials reuse a single program. See [Fyrestar/THREE.extendMaterial README](https://github.com/Fyrestar/THREE.extendMaterial) and [three.js issue #11475](https://github.com/mrdoob/three.js/issues/11475).

**Vertex color multiplier pattern** — keep the baked Quaternius foliage tinting AND apply the planet palette as a multiplier:

```glsl
// onBeforeCompile injection
#include <color_fragment>
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * uPlanetTint, uTintStrength);
```

Set `material.vertexColors = true`, keep `material.color = white`, inject after `<color_fragment>`. Degrades gracefully on Kenney packs (no VC → `diffuseColor` stays `material.color`).

**Post-process LUT pass for hero PBR assets.** Use [`LUTPass`](https://threejs.org/docs/#examples/en/postprocessing/LUTPass) to tie hero assets (where we preserved their original PBR materials) into the biome look without touching their materials. One full-screen pass costs ~0.3-0.6 ms at 1080p. Use **with** material override, not instead — overrides handle macro palette, LUT handles micro grade + hero assets.

**Hero/landmark assets opt out of material override.** Tag `matSlot: "hero"` (sentinel) → keep original PBR. They lean on the LUT pass for biome cohesion. Trades a small style-cohesion risk for preserving hand-crafted details on the most-photographed assets.

**Sources:**
- [GDC Vault — Continuous World Generation in No Man's Sky](https://www.gdcvault.com/play/1024265/Continuous-World-Generation-in-No)
- [GDC 2015 — Grant Duncan, How I Learned to Love Procedural Art](https://archive.org/details/GDC2015Duncan) ([YouTube mirror](https://www.youtube.com/watch?v=vcEA41eBOGs))
- [Game Developer — What the code of No Man's Sky says about procgen](https://www.gamedeveloper.com/programming/what-the-code-of-i-no-man-s-sky-i-says-about-procedural-generation)
- [Astroneer Blog — The Art of Astroneer: Low Poly](https://blog.astroneer.space/p/the-art-of-astroneer-low-poly/)
- [Material.onBeforeCompile docs](https://threejs.org/docs/#api/en/materials/Material.onBeforeCompile) and [issue #11475 rationale](https://github.com/mrdoob/three.js/issues/11475)
- [Fyrestar/THREE.extendMaterial patterns](https://github.com/Fyrestar/THREE.extendMaterial)
- [Three.js Post-Processing 3DLUT lesson](https://threejsfundamentals.org/threejs/lessons/threejs-post-processing-3dlut.html)
- [pmndrs/postprocessing](https://github.com/pmndrs/postprocessing)

### Failure modes & resilience

Three blocker-class failure modes surfaced in SpecFlow analysis that need explicit handling, not after-thought catches:

**1. Asset load failure (GLB fetch error, 404, Draco decode failure, CORS misfire on Poly Pizza).** Substitute the nearest **CC0 bundled fallback in the same biome family**, resolved at retrieval time so the fallback is pre-decided (no second LLM round-trip). Each biome has a hand-picked fallback kit (e.g. `crystal_barrens.fallback = { hero: "kenney:space:obelisk_01", surface: ["kenney:space:rock_small_01", ...], landmark: [...] }`). On `AssetCache.get()` rejection, swap to fallback ID and proceed. Failure is invisible to the player.

**2. Planet despawn mid-load (galaxy streaming culls a planet while its GLBs are in flight).** Each `Planet` instance carries a `visualGen` counter, incremented on construction and again on `dispose()`. `applyVisuals()` reads `gen = this.visualGen` at start; the loader continuation checks `this.visualGen === gen` before mounting any mesh. Stale results are dropped silently. Prevents both `.add()` to a null parent and orphan-mesh leaks. Same pattern protects against:

**3. Concurrent approaches / mid-flight swerve.** Player aims at A, fires Tier 2, then swerves to B. Both Tier 2 calls in flight, both loader chains racing. The `visualGen` token also handles cancellation here — if the player re-commits to A while A's load is in flight, gen stays valid and the result mounts; if they swerve and A despawns, gen invalidates and the result is dropped. Cap in-flight Tier 2 calls at 2 per session; older speculative call demoted to background priority but not canceled (it's already billed; cache the result for later cache hits).

Retrieval failure modes (less severe but explicit):

**4. Low-confidence retrieval (top-1 cosine < 0.3 across all slots).** Skip the strict-pick LLM call entirely. Use the biome's default fallback kit. Log a telemetry event for catalog/prompt tuning. Saves the second LLM call and prevents incoherent planet from garbage shortlist.

**5. Tier 2 direct call failure.** Planet stays seed-default terrain (current behavior). Recoverable on next approach.

**6. Tier 2 pick call failure** (after direct call succeeded). Use top-1 per slot from the shortlist (no LLM taste, but valid IDs from a good shortlist). Planet renders cleanly.

### Asset loading + caching

```js
// src/world/AssetCache.js (sketch)
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath('/draco/');
loader.setDRACOLoader(draco);

const cache = new Map();           // id → Promise<THREE.Group>

export function get(assetId) {
  if (cache.has(assetId)) return cache.get(assetId);
  const url = urlFor(assetId);     // bundled or Poly Pizza
  const p = loader.loadAsync(url).then(g => g.scene);
  cache.set(assetId, p);
  return p;
}
```

GLBs returned are **shared `THREE.Group` references**. Callers `.clone()` per instance and apply per-planet `MaterialSet`. No copy of the geometry; instancing handled by Three.js's internal share semantics. For dense surface use, an `InstancedMesh` is constructed once per `(planet, asset_id)` pair.

Bundled CC0 assets shipped Draco-compressed (~3-5x smaller). Poly Pizza GLBs proxied through Worker (CORS), cached in `ASSET_CACHE` KV (a couple weeks TTL is fine since they're identified by stable IDs).

### Research insights — asset loading + caching

**Full loader stack (Phase 1, not deferred):**

```js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const draco = new DRACOLoader().setDecoderPath('/draco/');
const ktx2  = new KTX2Loader().setTranscoderPath('/basis/').detectSupport(renderer);

export const gltfLoader = new GLTFLoader()
  .setDRACOLoader(draco)
  .setKTX2Loader(ktx2)
  .setMeshoptDecoder(MeshoptDecoder);
```

Copy `node_modules/three/examples/jsm/libs/draco/gltf/*` and `…/basis/*` to `public/draco/` and `public/basis/` via a Vite postinstall plugin. **One loader instance app-wide** — share it.

**Cache pattern — promise map (dedupes parse, not just fetch):**

```js
const gltfCache = new Map();
export function loadGLB(url) {
  let p = gltfCache.get(url);
  if (!p) { p = gltfLoader.loadAsync(url); gltfCache.set(url, p); }
  return p;
}
```

`THREE.Cache.enabled = true` only dedupes raw fetches — you still re-parse on every call. Promise-map dedupes parse too and survives React-strict-mode-style double mounts.

**Cloning rules:**
- Static meshes → `gltf.scene.clone(true)` (geometry/material shared by ref — fine).
- Per-planet material override → **must** `mesh.material = mesh.material.clone()` before mutating. Otherwise every planet's tree turns the same color.
- Any rigged assets (none currently, but defensive) → `SkeletonUtils.clone()` rewires bones; geometry/material still shared.

**InstancedMesh per planet, not global.** Whole-mesh frustum cull happens at the planet's bounding sphere — when a planet pops out of view, the entire instanced batch culls in one test. A galaxy-wide instanced mesh would have a bounding sphere spanning the universe → never culled, drawing every instance every frame.

**BatchedMesh for heterogeneous static landmarks.** New in r156+, stable in r170+. One draw call across different geometries sharing a material. Use when there are 5+ unique landmark variants per planet. For fewer variants, separate `InstancedMesh` is simpler and faster.

**Material override pattern with vertex-color preservation:**

```js
const root = (await loadGLB(url)).scene.clone(true);
root.traverse((o) => {
  if (!o.isMesh) return;
  const slot = o.userData.matSlot
    ?? o.material?.name?.split('_')[0]    // Blender mat name convention
    ?? 'default';
  const base = matSet[slot] ?? matSet.default;
  const m = base.clone();
  const hasVC = !!o.geometry.attributes.color;
  m.vertexColors = hasVC;
  if (hasVC) m.color.setHex(0xffffff);    // multiplier neutral; else VC gets tinted
  if (o.material.map && !m.map) m.map = o.material.map;  // keep baked texture if override lacks one
  o.material = m;
});
```

**`vertexColors: true` multiplies with `material.color`** — keep color white when you want raw vertex colors (Quaternius/KayKit/Astroneer-style). Confirmed in [three.js issue #14110](https://github.com/mrdoob/three.js/issues/14110).

**Build-time `matSlot` tagging:** `gltf-transform` script reads `mesh.name` prefixes (`rock_`, `tree_`, `bld_`) — Quaternius/Kenney follow consistent conventions — and writes `userData.matSlot` to a sidecar JSON or repacks the GLB. Nearly-free correctness improvement.

**Disposal under streaming:**
- **Do not dispose** geometry/material/texture from the cache when a planet despawns — they may be in use by other loaded planets.
- **Do dispose** per-planet cloned materials and per-planet `InstancedMesh` buffers (`mesh.dispose()` releases `instanceMatrix`/`instanceColor`).
- When evicting a cache entry under memory pressure, dispose deeply: walk the GLB scene, dispose every unique geometry/material/texture (Set-dedupe by uuid).
- **Critical (often missed):** `texture.source.data.close()` before `texture.dispose()` — GLB textures arrive as `ImageBitmap`s and won't be GC'd otherwise. Known leak per [three.js issue #23953](https://github.com/mrdoob/three.js/issues/23953).
- Handle `webglcontextlost` on the canvas; halt rendering, clear `gltfCache` on `webglcontextrestored` so reuploads happen cleanly.

**KHR_mesh_quantization is native to Three.js r111+** — no decoder needed; reads quantized int8/int16 attributes directly. Run `gltfpack -cc -tc` at build time on the 150 bundled CC0 assets: 4-8× size reduction with negligible visual loss for low-poly. Skip for Poly Pizza CC-BY fetches (they arrive already optimized; double-quantizing degrades).

**Sources:** [GLTFLoader docs](https://threejs.org/docs/pages/GLTFLoader.html), [meshoptimizer / gltfpack](https://meshoptimizer.org/gltf/), [KHR_mesh_quantization spec](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_mesh_quantization/README.md), [InstancedMesh2 community lib](https://discourse.threejs.org/t/instancedmesh2-easy-handling-and-frustum-culling/58622), [SkeletonUtils docs](https://threejs.org/docs/pages/module-SkeletonUtils.html), [How to clone a GLTF](https://discourse.threejs.org/t/how-to-clone-a-gltf/78858), [ImageBitmap leak issue](https://github.com/mrdoob/three.js/issues/23953).

### Worker changes

`worker/src/routes/llm.js`:
- Add `MODELS[2.5]` / `TOOLS[2.5]` / `SYSTEM[2.5]` for the final-pick call (same Sonnet model).
- Either register `/tier2/pick` as a sibling route, or expose `/tier2/direct` (call 1) and `/tier2/pick` (call 2) and have the client orchestrate. The cleaner architecture is two separate Worker endpoints — keeps each cache key clean (`t2dir:seed:ctx` vs. `t2pick:seed:shortlist_hash`).
- Cache key for `/tier2/pick` includes a hash of the shortlist (so different shortlists → different cache entries). Identical shortlists → same cache hit (deterministic for the same user since recent-asset list is included in the shortlist generation).

`worker/src/routes/assets.js` (new):
- `GET /assets/polypizza/:id` — fetches Poly Pizza GLB via their API ([poly.pizza/docs/api/v1.1](https://poly.pizza/docs/api/v1.1)), proxies to client with proper CORS, caches body in `ASSET_CACHE` KV.
- `GET /assets/polypizza/search?q=...&role=...` — used by an offline build step to expand the catalog; not called at runtime.

## Implementation Phases

Each phase is independently shippable and produces visible improvement.

### Phase 1: Catalog scaffolding + AssetCache (no LLM changes)

**Deliverables:**
- `tools/embed-catalog.js` — Node script that walks `src/world/assets/bundled/`, generates `catalog.json` with metadata + MiniLM embeddings (using SAME `dtype: 'q8'` + pooling + normalize as runtime so vectors match). Runs as `npm run build:catalog` and feeds into the regular build. Dim + model assertions at runtime boot.
- `src/world/AssetCache.js` — GLB loader with module-level Promise-Map cache, full decoder stack: `GLTFLoader + DRACOLoader + KTX2Loader + MeshoptDecoder` configured up front (no Phase 8 deferral; trivial setup, major VRAM savings).
- `public/draco/` + `public/basis/` copied at install time via a Vite postinstall plugin.
- `src/world/MaterialSet.js` — single per-planet material source.
- ~30 hand-curated CC0 assets across Quaternius + Kenney + KayKit (~3 biomes worth as proof).
- **Proof of concept:** a debug command (`__GAME.testAsset('quaternius:nature:tree_oak_01')`) places one asset on the home planet via `AssetCache.get` + place in scene. Validates loader, materials, draw bounds.
- No `Planet.js` refactor yet.

**Success criteria:**
- `__GAME.testAsset(id)` mounts a Draco-compressed GLB onto the home planet, materially consistent with the planet palette.
- Catalog build runs in <30s; output `catalog.json` is &lt;1 MB.
- No measurable FPS regression on the home planet.

**Effort:** ~2 days.

### Phase 2: Embedding pipeline + AssetRetriever + Welcome-Modal warmup

**Deliverables:**
- `src/world/AssetRetriever.js` — hybrid BM25 (`minisearch`) + dense (transformers.js MiniLM) + RRF + MMR + recent-asset demotion.
- `Xenova/all-MiniLM-L6-v2` model with **two load triggers** instead of pure lazy:
  - **First-time visitors:** load begins as soon as the welcome modal mounts. The model is downloaded (~22 MB once) + initialized in parallel while the player reads the onboarding beats.
  - **Returning visitors:** browser Cache API serves the model file from disk (zero network). A `preloadEmbedder()` call fires at game-interactive to do the ~200 ms cache-hit init in the background.
- **Welcome-modal warmup window:** the modal's `START PLAYING` button is initially disabled. A thin amber progress line fills under the third beat as MiniLM (and other warmup assets, see below) load. No MB count, no percentage — ambient progress only. Button enables when warmup completes. Typical first-visit: 15-25 s of background load against 30-45 s of player reading time, so the button is almost always enabled by the time the player wants to click.
- **What gets warmed in parallel during the modal window** (all kicked off concurrently):
  - MiniLM model file (~22 MB, dominates the bar)
  - DRACO + KTX2/Basis decoders (~600 KB combined)
  - Catalog embeddings JSON (~300 KB gzipped)
  - First 2-3 hero GLBs from likely-starter biomes (~3-5 MB)
- **Returning visitors get no progress bar** — they don't see the welcome modal, and the cache-hit init finishes invisibly during normal boot. Fast enough that even an immediate fly-toward-planet rarely catches the embedder uninitialized.
- **Cold-call fallback for the rare returning-fast-player case:** if Tier 2 fires before `preloadEmbedder()` resolves, the first retrieval call awaits the embedder with a generous 4 s ceiling. Past that ceiling, fall back to BM25-only retrieval (still hits the strict-pick LLM with a valid shortlist; just no semantic-similarity signal for that one planet). Subsequent planets are normal.
- Recent-asset ring buffer in `localStorage` keyed by user id (`personalspace:recent-assets:v1`).
- Debug command: `__GAME.testShortlist(["towering obsidian spire"], "hero", 8)` returns asset IDs + scores.

**Success criteria:**
- First-time visitor: model fully loaded within 25 s on a typical broadband connection; START PLAYING button enables before that. Welcome modal does its onboarding job AND its warmup job in the same window.
- Returning visitor: zero network for the model; `preloadEmbedder()` returns within 300 ms; first Tier 2 call hits a warm embedder.
- Slow-connection visitor (3G-equivalent): START PLAYING disabled until ~60 s; player notices the ambient progress fill but isn't blocked from reading the onboarding copy.
- Hand-validated retrieval quality on 20 representative queries (looking for "crystal" returns crystal assets; "tree" returns trees).
- Repeated calls with the same query against a degraded recent list return demoted-but-not-excluded IDs.

**Effort:** ~2.5 days (extra 0.5 for the welcome-modal warmup UX wiring).

### Phase 3: Tier 2 split into direction + pick (Worker + LLM client)

**Deliverables:**
- Worker: `/tier2` becomes `/tier2/direct` returning extended JSON (biome + theme + density + style hints). Cache key unchanged from current `/tier2`.
- Worker: new `/tier2/pick` accepts `{shortlist}` body, returns enum-per-slot picks via **Haiku 4.5 strict tool use** (downgraded from Sonnet per deepen research; 3× cheaper, no quality loss under enum constraint). Cache key `t2pick:seed:sortedShortlistHash:modelId`. `cache_control` on the static system prompt, NOT on the tool block.
- Client: `LLMClient.approach()` orchestrates the two calls + retrieval between them.
- **Retrieval threshold guard:** if top-1 cosine across all slots < 0.3, skip the `/tier2/pick` call entirely and use the biome's pre-decided fallback kit. Log a telemetry event for catalog/prompt tuning. Saves a Sonnet call on garbage shortlists.
- **In-flight Tier 2 cap:** at most 2 concurrent Tier 2 chains. Older speculative call demoted to background priority (still allowed to complete + cache, but not awaited by the gameplay loop).
- Failure path: if `/tier2/pick` 5xx, fall back to top-1 per slot from the shortlist (no LLM taste, but valid IDs). Planet still gets non-primitive visuals.

**Success criteria:**
- End-to-end Tier 2 latency: median ≤ 2.5s (was ~1s with single call); Haiku pick stage typically ≤ 600 ms. Worst case ≤ 6s.
- Strict-tool enum constraint validated: out-of-enum IDs are **impossible by construction**; counter expected to stay at zero.
- Worker cost increase per Tier 2: ~1.3-1.5× (Haiku pick is ~3× cheaper than Sonnet would be).

**Effort:** ~2 days.

### Phase 4: Planet construction refactor — deferred build + cancellation tokens

**Deliverables:**
- `Planet.js` split: eager terrain + collider; deferred `applyVisuals({palette, heroAsset, landmarkAssets, surfaceAssets, density})` rebuilds landmarks + features from selected assets.
- `Planet.visualGen` counter — incremented on construction and on `dispose()`. `applyVisuals()` captures gen at start; loader continuation checks `this.visualGen === gen` before mounting. Stale loads dropped silently. Same token guards mid-flight swerves (player commits to A, swerves to B, A despawns mid-load).
- `Landmarks.js` rewritten to bind GLB clones to existing slot positions (peak/basin/coast/spire), scaled per `scale_range`.
- `Features.js` rewritten to use `InstancedMesh` per surface asset, density per LLM hint.
- Per-asset try/catch in `applyVisuals`: GLB load failures swap to pre-decided biome fallback (resolved at retrieval time, see "Failure modes").
- Existing `applyLLM(meta)` path retained as a thin shim that calls `applyVisuals` with backward-compat defaults.
- `SolarSystem.dispose()` extended to dispose `MaterialSet` materials cleanly.

**Success criteria:**
- Planet construction (eager) completes in same time as today (terrain + collider unchanged).
- `applyVisuals` completes within 1 frame of all asset loads resolving (no perceived stutter; mount in `requestAnimationFrame`).
- Visual: every loaded planet shows LLM-selected GLBs.
- Manual test: approach planet A, then swerve to B before A's load completes. A despawns cleanly; B renders cleanly; no console errors; no orphan meshes (verified via Three.js scene tree inspection).
- Regression: existing claim flow, thumbnail capture, logbook entry creation all work.

**Effort:** ~3 days.

### Phase 5: Reveal-as-you-fly — fade-in shader + atmospheric mask

**Deliverables:**
- `FadeInMaterial` wrapper with **two fade curves**:
  - *Distant arrival* (default): 500 ms alpha ramp, intended for assets that arrive while the player is still on approach silhouette.
  - *Late arrival* (player already at low altitude when mesh lands): ~250 ms crossfade with a 0.9→1.0 scale-up to disguise close-range pop-in.
  - Curve chosen at mount time based on `camera.distanceTo(planet.center)`.
- Atmosphere shader tweak (`src/world/Atmosphere.js`) — distance-based haze that obscures detail beyond ~3 km from camera (no extra geometry; uniform-driven).
- Distance-based LOD: hero asset loads first (visible from approach); surface + landmarks load progressively as player closes.
- Asset prefetch on Tier 2 fire (kick off `AssetCache.get` for all selected IDs immediately, don't wait for player to approach further).
- **Intent gate** (optional, defer if Phase 5 runs long): fire Tier 2 ~2-3s earlier than the existing approach gate, on sustained heading toward planet for N seconds within `radius + APPROACH_DISTANCE * 1.5`. Buys headroom for slow LLM scenarios. Tier 2 cost rises slightly (some speculative fires) but cached for the inevitable hard approach.
- **Thumbnail capture defer:** `ThumbnailCapture.snapshotNow()` waits on `Promise.all([assetsLoaded, fadeComplete])` with a 1.5s ceiling. If ceiling hits, force-snap alpha to 1.0 then capture. Claim UX shows brief "Capturing…" pill.

**Success criteria:**
- Slow-Tier-2 scenario (8s LLM latency): player at low altitude sees terrain + haze; assets late-fade-crossfade in within 250 ms as they arrive; no jarring pops.
- Fast-flyby scenario (player approaches at full throttle): hero asset visible from ≥5 km; surface details fade in within the last 1 km.
- Thumbnail captured at claim: assets fully visible at alpha 1.0; no half-transparent meshes in logbook entry.

**Effort:** ~2-3 days.

### Phase 6: Diversity guardrails + style cohesion enforcement

**Deliverables:**
- Recent-asset ring buffer wired into `AssetRetriever` shortlist generation (multiplicative penalty: 0.3-0.7x score for recently-used IDs; tune in pilot).
- **MMR pass** (Maximum Marginal Relevance, λ=0.7) applied after recency demotion to ensure intra-shortlist diversity. Different problem from recency — MMR prevents "shortlist of 8 nearly-identical crystals" even on a fresh user; recency prevents "every planet looks like the last one I saw."
- Per-planet asset bias: prefer the same `pack` for all slots on a planet (RRF score boost for shared `pack` matches first selected asset).
- Material set enforced — GLBs traversed on load, every `MeshStandardMaterial`/`MeshBasicMaterial` replaced with the planet's `MaterialSet` equivalent.
- Sanity test: load 10 planets in sequence; assert &lt;30% asset reuse and 100% material-set conformance.

**Success criteria:**
- Visible: a player who just claimed 3 crystal planets sees the next planet's hero choice skew away from crystals.
- A planet using 5 GLBs from 3 different creators visually reads as one place (manual review of 10 sample planets).

**Effort:** ~1.5 days.

### Phase 7: Poly Pizza dynamic integration + attribution UX

**Deliverables:**
- `worker/src/routes/assets.js` — Poly Pizza proxy + KV cache.
- Worker-side embed-on-demand: when a new Poly Pizza asset is pulled, generate its embedding via Workers AI (or via a build job), append to a dynamic catalog tier.
- Logbook entry detail view (`src/ui/Logbook.js`) shows "Assets: X by Y (CC-BY)" line for each CC-BY asset on the planet. Satisfies attribution requirement.
- Global credits panel in account drawer linking to a `/credits` static page listing all CC-BY contributors.

**Success criteria:**
- Catalog expanded from ~150 bundled to 500+ effective via Poly Pizza.
- Attribution surfaces correctly for any CC-BY asset present on a claimed planet's logbook entry.
- Poly Pizza fetch latency: ≤ 400ms warm (KV cache hit), ≤ 2s cold.

**Effort:** ~2 days.

### Phase 8: Performance pass (system cap, instancing, Draco, frustum culling, LOD)

**Deliverables:**
- **Hard cap of 2 fully-realized systems** (active + adjacent). Distant streamed systems show seed-default terrain only — no GLB visuals. Reduces 18 potential active planets × 4-6 GLBs each to a tractable ceiling.
- All bundled CC0 GLBs Draco-compressed.
- `KHR_mesh_quantization` extension enabled in loader (smaller, faster).
- Per-asset draw-cost budget enforced in `applyVisuals` (skip surface instances if cumulative > 8000).
- LRU mesh cache (~50 MB ceiling) for GLB instances. Re-approached planets hit cache for instant rebuild.
- Frustum culling re-enabled where safe (currently disabled per `a9caa41`); test under per-planet asset density.
- Worker-thread terrain/noise generation if profiler shows main-thread stalls (off by default; behind `?wt=1` flag).

**Success criteria:**
- 60 fps maintained with 2 fully-realized systems × 5 planets × hero+landmarks+200 surface instances loaded, plus distant seed-default systems streaming in/out.
- Memory ceiling: ≤ 250 MB heap.
- Bundle size growth: ≤ 30 MB gzipped over pre-Phase-1 baseline.
- LRU cache hit rate ≥ 60% on a 10-minute exploration session with mild backtracking.

**Effort:** ~2-3 days.

### Research insights — performance pass

**Frame budget at 60 fps (16.6 ms total) — realistic targets:**

| Slot | Desktop | Laptop |
|---|---|---|
| Rapier physics step | 2-4 ms | 3-5 ms |
| JS update / scene graph / culling | 2-3 ms | 3-4 ms |
| `renderer.render` CPU side | 3-6 ms | 4-7 ms |
| GPU frame | 4-8 ms | 6-10 ms |
| **Headroom** | ~1-3 ms | ~1-2 ms |

**Death-by-thousand-cuts sources (ranked):**
1. Shader compile stalls when a new material first renders → **warm-up pass:** call `renderer.compile(scene, camera)` after `applyVisuals` resolves but before mounting; pre-uploads programs.
2. Texture upload on first draw of a freshly-loaded GLB → call `renderer.initTexture(texture)` after load to pre-upload.
3. Draw-call count creeping above ~300 → **target <250 desktop / <150 laptop**.
4. Per-mesh matrix updates on dirty scene graph → set `instanceMatrix.setUsage(THREE.StaticDrawUsage)` for non-moving instances.

**Concrete targets for Personal Space:**
- Draw calls: <250 desktop / <150 laptop
- Triangles on-screen: <800k desktop / <300k laptop
- Texture VRAM: <250 MB
- Distinct shader programs: <25 (use `customProgramCacheKey` everywhere)

**Frustum culling under floating origin — revised guidance:**
- The blanket `frustumCulled = false` in commit `a9caa41` is over-applied. Three.js culling works correctly under floating origin *if* `geometry.boundingSphere` is recomputed after load.
- **Recommended approach:**
  - Regular `Mesh`: leave `frustumCulled = true`. Call `geometry.computeBoundingSphere()` after load and after any vertex displacement.
  - `InstancedMesh` / `BatchedMesh`: set `frustumCulled = false` and do **chunk-level** manual culling via `Frustum.intersectsBox` against the planet's bounding box. One frustum test per planet skips thousands of instances at once.
  - After every floating-origin rebase: no per-object fix needed — `matrixWorld` recomputes naturally.

**Distance-gated loading beats `THREE.LOD` for streamed worlds.** `THREE.LOD` keeps all levels in memory and toggles visibility — wasteful when 90% of systems are off-screen anyway. Pattern:
- Outer ring (> X km): no GLB load. Billboard/imposter sprite only.
- Mid ring: low-poly variant (~5-15k tris, Draco-compressed).
- Inner ring: hero GLB.
- Use `THREE.LOD` *within* the hero ring (active planet) where switches are frequent and assets are already resident.
- **Hysteresis:** add 10-15% distance margin between load/unload thresholds to prevent thrash near boundaries.

**Texture handling:**
- Always ship GLBs with KTX2/Basis textures via `KHR_texture_basisu` (already in Phase 1 loader stack). 2K RGBA PNG decompresses to 16 MB on GPU; KTX2 cuts to 1-4 MB.
- Target <200 MB texture VRAM desktop, <50 MB laptop.

**Memory ceiling (LRU eviction):** `THREE.Cache` has no eviction. Roll your own:
- `Map<url, { gltf, lastUsed, refCount }>`
- On each system-load: bump `lastUsed`, increment `refCount`
- On system-despawn: decrement `refCount`
- When total tracked VRAM exceeds budget (~300 MB), evict lowest `lastUsed` with `refCount === 0`
- Track via `renderer.info.memory` (`geometries`, `textures`) — should drop after eviction.

**Web Workers for terrain:** worth it when main-thread profile shows >2 ms in noise. Transfer chunk vertex/index buffers as `Transferable ArrayBuffer` (zero-copy). Browser support universal in 2026. Phase-8 optional behind `?wt=1`.

**Profiling toolkit (2026):**
- `stats.js` for FPS / frame-time HUD during dev.
- Chrome DevTools Performance panel with "GPU" track enabled.
- `renderer.info` (`calls`, `triangles`, `geometries`, `textures`) baked into a debug overlay.
- `EXT_disjoint_timer_query_webgl2` for true GPU-side timing — see [figma/webgl-profiler](https://github.com/figma/webgl-profiler) for a clean reference.
- [Spector.js](https://spector.babylonjs.com/) browser extension for frame-by-frame draw-call inspection when chasing "why is my draw count 800."

**Sources:**
- [100 Three.js Tips That Improve Performance (2026)](https://www.utsubo.com/blog/threejs-best-practices-100-tips)
- [BatchedMesh docs](https://threejs.org/docs/pages/BatchedMesh.html)
- [BatchedMesh High-Performance Rendering — Wael Yasmina](https://waelyasmina.net/articles/batchedmesh-for-high-performance-rendering-in-three-js/)
- [When is LOD actually beneficial — three.js forum](https://discourse.threejs.org/t/when-is-it-actually-beneficial-to-use-lod-in-three-js-for-performance/87697)
- [InstancedMesh frustum culling — three.js forum](https://discourse.threejs.org/t/how-to-do-frustum-culling-with-instancedmesh/22633)
- [Faster WebGL/Three.js with OffscreenCanvas + Workers — Evil Martians](https://evilmartians.com/chronicles/faster-webgl-three-js-3d-graphics-with-offscreencanvas-and-web-workers)
- [Three.js Performance Tips — Three.js Journey](https://threejs-journey.com/lessons/performance-tips)
- [Tips on preventing memory leak in Three.js — Roger Chi](https://roger-chi.vercel.app/blog/tips-on-preventing-memory-leak-in-threejs-scene)
- [Draw Calls: The Silent Killer](https://threejsroadmap.com/blog/draw-calls-the-silent-killer)
- [figma/webgl-profiler (EXT_disjoint_timer_query_webgl2 wrapper)](https://github.com/figma/webgl-profiler)

**Total estimated effort: 17-19 days of focused solo work.**

## Alternative Approaches Considered

| Approach | Why rejected |
|---|---|
| **Pure tag-keyword lookup** (no LLM, no embeddings) | Loses the brand-critical "creative LLM director" vibe. Predictable but every crystal planet looks the same. |
| **Pure embedding semantic search** (no BM25) | Production hybrid-search studies show pure dense retrieval fails silently on rare/identifier tokens — exactly what asset slugs are. BM25 catches what semantics miss. |
| **Strict-enum LLM with full catalog inline** | Token cost scales with catalog size. 500-item enum on every Tier 2 call burns prompts and forces the model to do semantic similarity it's not specialized for. Retrieve first, then constrain. |
| **3D AI generation per planet** (text-to-3D) | Brand-perfect ("unique to you forever") but slow (~30-60s per asset on best models in 2026), expensive ($0.50+ per planet), and quality is inconsistent. Revisit in 12-18 months. |
| **All asset selection at Tier 1 (preload on detection)** | Tier 1 fires for every visible planet — most of which the player will never approach. ~5-10x more LLM calls and asset loads wasted. Tier 2 is the right gate. |
| **Generative kit combinations within a single planet** | High novelty but per the research, style drift is the silent killer. One pack per planet (with cross-planet diversity) gives better visual cohesion. |
| **Server-side retrieval** (in Worker) | Adds 100-300 ms network round-trip per shortlist. Per-user galaxies means there's no shared-cache benefit. Browser-side wins on latency and offline resilience. |

## System-Wide Impact

### Interaction graph

```
Player commits toward planet (approach gate, main.js:388-403)
  → tryApproach(planet) (main.js:231-246)
      → llm.approach(seed, {radius})  [single call today]
          ↓ becomes ↓
      → llm.directCall(seed, {radius})  [new]
          → Worker /tier2/direct  → Claude Sonnet (call 1)
              → returns {biome, theme, density, palette, style_hints[]}
      → AssetRetriever.shortlist(style_hints, role, k, recentIds)
          → MiniLM embed query
          → BM25 over catalog
          → RRF fusion + recent demotion
          → returns top-K per slot
      → llm.pickAssets(seed, shortlist)  [new]
          → Worker /tier2/pick  → Claude Sonnet (call 2, strict tool)
              → returns {hero_id, surface_ids[], landmark_ids[]}
      → AssetCache.preload(allSelectedIds)
          → GLTFLoader.loadAsync each
      → planet.applyVisuals({palette, heroAsset, landmarkAssets, surfaceAssets, density})
          → buildMaterialSet(palette)
          → _reTintVertexColors(palette)  [existing]
          → rebuild landmarkGroup from GLB clones + slot positions
          → rebuild featuresGroup as InstancedMeshes
          → mount with FadeInMaterial (500 ms alpha ramp)
      → planetNav.setLabel(seed, name) [existing]
      → hud.setPlanetName(name) if active [existing]
      → AssetRetriever.markUsed([...allSelectedIds])
          → push into recent-asset ring buffer (localStorage)
```

### Error & failure propagation

- **Tier 2 call 1 failure** → planet stays seed-default (current behavior). Recoverable on next approach.
- **Retrieval failure** (catalog corrupt, embeddings missing) → log + fall back to deterministic biome-only lookup. Planet still gets non-primitive visuals.
- **Tier 2 call 2 failure** → fall back to top-1 per slot from the shortlist (no LLM taste, but valid asset IDs). Planet renders cleanly.
- **GLB load failure** (network, 404, Draco decode error) → skip that asset; planet renders the remaining selected assets. Logged via `console.warn`.
- **Strict-tool enum violation** (LLM tries to return ID outside enum) → Anthropic API rejects; client retries once with same shortlist; if persists, falls back to top-1.

### State lifecycle risks

- **Asset cache leaks if planets despawn during load.** Mitigation: cache is module-level by `asset_id` (not `planet_id`); a planet despawn doesn't drop the cache. GLBs stay warm for the next planet that uses them.
- **In-flight LLM call when system despawns** (planet leaves CULL_RADIUS mid-Tier-2). Result still cached on Worker KV; if planet ever re-streams, cache hit returns immediately. Client-side promise is GC'd safely.
- **Recent-asset list grows unboundedly.** Ring buffer caps at 20 entries.
- **Material set leaks** if planet despawned without disposal. Existing `SolarSystem.dispose` walks group tree and disposes geometries/materials (`SolarSystem.js`); extend to dispose MaterialSet materials.

### API surface parity

- **Existing `Planet.applyLLM(meta)`** stays as a thin shim calling `applyVisuals(...)` with biome-only defaults. Any code path calling `applyLLM` (currently main.js Tier 2 callback) gets migrated to `applyVisuals` directly.
- **Worker `/tier2`** stays as an alias for `/tier2/direct` for transition period. Removed in Phase 4 or later.
- **Cache key** changes for Tier 2; old KV entries become orphans (acceptable — 30-day TTL).

### Integration test scenarios

1. **Cold cache, slow network.** Brand-new browser, Tier 2 cold, 30 assets cold. Player approaches planet at full throttle. Expected: terrain visible immediately; haze obscures detail until ≤2 km; hero asset fades in; surface fills in last. Frame rate stays ≥45 fps.
2. **Hot cache repeat visit.** Player flies away from a system and returns. Galaxy.update re-spawns the system; Tier 2 hits Worker KV cache; `AssetCache.get` returns memoized GLBs; planet rebuilds in ≤ 1 frame.
3. **Mid-flight commit switch.** Player aimed at planet A, fires Tier 2, then swerves to planet B before A finishes. Both Tier 2 calls in flight, both asset loads racing. Expected: both planets eventually render correctly; no duplicate `applyVisuals` for the same planet.
4. **Claim mid-fade.** Player claims (surveys 50%) before fade-in completes on a landmark. Thumbnail capture pauses 500 ms; mesh visible at full alpha at capture time.
5. **Diversity stress test.** Player claims 10 planets in sequence; assert ≤30% asset reuse across the 10 planets' selected IDs.

## Acceptance Criteria

### Functional requirements

- [ ] Tier 2 split into two calls (`/tier2/direct` + `/tier2/pick`); both cached in KV.
- [ ] LLM-selected asset IDs are always valid (strict-tool enum enforced; never out-of-catalog).
- [ ] Each planet renders with at least one hero, three landmarks, and surface features when Tier 2 succeeds.
- [ ] Planet renders with seed-default terrain even when Tier 2 fails entirely.
- [ ] Per-planet `MaterialSet` enforced — no GLB's original PBR material appears on any rendered planet.
- [ ] Recent-asset diversity guardrail demotes recently-used IDs in retrieval.
- [ ] CC-BY assets surface attribution in the logbook entry detail view.
- [ ] Logbook thumbnails captured at claim time include the LLM-selected assets at full alpha.
- [ ] Existing flows (claim, logbook sync, lore display, ping HUD) unaffected.
- [ ] GLB load failure on any asset → swap to pre-decided biome fallback; planet renders cleanly; no console error visible to the player.
- [ ] Planet despawn mid-load → no orphan meshes in scene; no console errors; `visualGen` token enforced.
- [ ] Concurrent approach to two planets → both render correctly; in-flight cap at 2 enforced.
- [ ] Low-confidence retrieval (top-1 cosine < 0.3) → `/tier2/pick` skipped; biome fallback used; telemetry event logged.
- [ ] Thumbnail capture at claim → all selected assets at alpha 1.0; "Capturing…" UX shown if fade still in progress.

### Non-functional requirements

- [ ] Bundle growth ≤ 30 MB gzipped over baseline.
- [ ] Cold-Tier-2 end-to-end latency ≤ 6s p95.
- [ ] 60 fps maintained with 3 systems × 5 planets × full visuals loaded.
- [ ] Memory ceiling ≤ 250 MB heap with 18 active planets.
- [ ] First-claim experience: terrain visible within 500 ms of approach gate; full visuals within 5s.
- [ ] CC-BY attribution legally compliant (visible per asset, persistent in the logbook entry).

### Quality gates

- [ ] Hand-curated catalog of ≥ 150 CC0 assets across ≥ 8 biomes + 10 themes.
- [ ] Visual review of 20 sample planets — every one reads as a cohesive place, none feels like a kit mashup.
- [ ] Embedding pre-compute pipeline (`tools/embed-catalog.js`) runs cleanly in CI.
- [ ] No regression in existing test surface (smoke claim flow, thumbnail capture, logbook sync).

## Success Metrics

- **Player engagement:** average planets claimed per session ↑ 30%+ (better visuals → more wanting to claim).
- **Logbook retention:** percentage of users who re-open the logbook within 7 days ↑ (thumbnails worth revisiting).
- **Visual cohesion:** human review score (1-5) on 30 sampled planets ≥ 4.0.
- **Latency:** Tier 2 p50 ≤ 2.5s, p95 ≤ 6s.
- **Diversity:** &lt;30% asset reuse across any 10-planet window for a single player.

## Dependencies & Prerequisites

- `three/addons/loaders/GLTFLoader.js` (already shipped with Three.js).
- `three/addons/loaders/DRACOLoader.js` + `/draco/` decoder static files (~200 KB, fetched once).
- `@xenova/transformers` (~22 MB MiniLM model; can be CDN-loaded or self-hosted).
- `minisearch` (~10 KB) for BM25.
- Hand-curated CC0 asset bundle from Quaternius / Kenney / KayKit.
- Poly Pizza API key (free, registered).
- Anthropic strict-tool-use feature (production-grade across all current Claude models — `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-7`).

## Risk Analysis & Mitigation

| Risk | Severity | Mitigation |
|---|---|---|
| **Style drift across kits** (cluttered planet look) | High | Per-planet `MaterialSet` overrides all GLB materials. Pack-cohesion bonus in retrieval (prefer same-pack assets). Manual review gate per phase. |
| **LLM cost doubling** (extra LLM call per Tier 2) | Low (revised) | Pick stage uses Haiku 4.5 ($1/$5 per M tokens) instead of Sonnet ($3/$15) per deepen research — net ~1.3× cost over single Sonnet call, not 2×. KV cache hit rate ~70% for repeat traffic further amortizes. Per-user galaxies mean new users are cache misses but cost stays ~$0.01-0.02 per first-time-approached planet. |
| **Bundle size blowing client load time** | Medium | Draco compression (3-5x reduction). Lazy-load MiniLM only on first retrieval. Catalog GLBs ship under `/assets/bundled/` and load on demand, not at boot. |
| **Asset pop-in still visible** despite fade-in + haze | Medium | Aggressive prefetch on Tier 2 fire. Distance-LOD hides surface features until close. Acceptance: a frame or two of pop-in on the fastest possible approach is OK if rare. |
| **CC-BY attribution UX hated by players** | Low | Attribution lives only in logbook detail view, not on the HUD. Players who never open an entry never see it. Legally compliant; aesthetically invisible. |
| **GLB load failures cascading** (one bad asset breaks planet) | Low | Per-asset try/catch in `applyVisuals`; failed assets just skip. |
| **Catalog metadata quality** (bad tags → bad retrieval) | Medium | Phase 1 includes a manual curation pass. Future: scrape Poly Pizza tags + augment with LLM-generated tag enrichment (offline build step). |
| **MiniLM inference perf on low-end devices** | Low | Cold start ~800 ms; warm ~10 ms. Acceptable. If issues surface, ship CPU-only fallback skipping dense retrieval (BM25 only). |
| **Player has 50+ logbook entries — old thumbnails look bad next to new ones** | Low | Acceptable historical artifact. Optionally offer a "regenerate thumbnail" affordance in Phase 7+ that re-spawns the planet and re-captures. |

## Resource Requirements

- **Time:** ~17-19 days solo dev. Phases stand alone; can ship Phase 1+2+3 (8 days) for a meaningful first visible improvement, then iterate.
- **Costs (recurring):** ~$0.03 extra per first-time-approached planet (Tier 2 pick call); KV cache + R2 storage negligible.
- **Costs (one-time):** $0 — all dependencies are open source / CC0.
- **External:** none (no paid asset purchases for v1; Synty packs can be considered post-launch).

## Deferred to v2 (explicitly punted)

Captured here so they don't get lost; not blocking v1.

- **Logbook entries created before this plan ships** display generic seed-default terrain in their thumbnails. Leave as historical artifacts; optionally add a subtle "generic terrain" badge in Phase 7+. Player-triggered thumbnail regeneration is a nice-to-have but costs Tier 2 budget retroactively.
- **Offline-claimed entries get `visualsLoaded: false` flag** on the entry record. On next online session, optionally backfill the thumbnail by re-spawning the planet and re-capturing. v1 just stores the flag so data is forward-compatible.
- **Diversity guardrail tuning** ships with a single demotion constant (0.6 multiplier on last 5 used IDs). Sweep + tune by user-segment data later.
- ~~**Welcome modal interaction:** Tier 2 fires on approach (not on system spawn), so the paused-during-welcome-modal state has no impact on asset prefetch. Asset selection benefit from "buy time during welcome modal" does NOT apply — the welcome modal benefits Tier 1 pings only.~~ **Superseded:** Phase 2 elevates the welcome modal to a *real* warmup window — MiniLM model file (~22 MB once), DRACO/KTX2 decoders, catalog embeddings, and 2-3 starter-biome hero GLBs all download in parallel while the player reads. START PLAYING button enables when warmup completes. Progress is a thin ambient amber fill under the third beat — no MB count, no percentage. Returning visitors don't see the modal and don't re-download (browser cache); they get a 200 ms cache-hit init during normal boot.
- **Returning player determinism:** Worker KV cache key for `/tier2/direct` and `/tier2/pick` includes `galaxy_seed`. If two users somehow shared a seed (won't happen with `hashString(user.id)`, but defensive), they'd see the same planet visuals — acceptable.
- **Per-biome fallback kit count.** v1 ships with one fallback kit per biome. If single-fallback planets feel too samey in practice, expand to 2-3 fallbacks per biome in v2.
- **Community-contributed assets** — open submission flow for CC0 GLBs. Manual review for style cohesion; embedding pipeline auto-runs.

## Future Considerations

- **Per-biome curation packs** — once the system is live, can add dedicated "deep sea" or "volcanic" packs without retraining or schema changes.
- **Community-contributed assets** — provide a `/credits` page hook for community submission of CC0 GLBs.
- **Tier 3 visual influence** — currently Tier 3 only writes lore. Could later have Tier 3 select 1-2 "secret" landmarks that appear only after claim (lore-driven post-claim visual reveal).
- **Text-to-3D regen** — when 3D AI generation matures (price + quality), revisit "LLM as full generator" for hero landmarks of especially memorable planets.
- **Player-driven curation** — let players "favorite" assets across their logbook; bias future retrieval toward favorites.
- **AR / mobile** — same catalog + retrieval works in any Three.js context; opens mobile + AR variants later.

## Documentation Plan

- This plan in `docs/plans/2026-05-23-001-feat-planet-visuals-llm-driven-assets-plan.md`.
- Update `plan.md` Phase 3+ "Planet visuals workstream" entry to reference this plan and link.
- Mark "Planet discovery lifecycle review" entry as folded-into this plan.
- Catalog format documented in `src/world/assets/README.md` (added Phase 1).
- Attribution + license handling documented in `docs/licenses.md` (added Phase 7).
- Per-phase: short PR description with success criteria as the test plan.

## Sources & References

### Origin

- **Brainstorm:** in-session conversation 2026-05-23 (settled all major decisions before plan generation). Key decisions carried forward: LLM as creative director with hybrid retrieve-then-constrain; Kenney-vibe aesthetic, multi-source compatible; backdrop biome + thematic overlay; all asset selection at Tier 2 (reveal-as-you-fly); sparse-leaning density; art bar weighted approach > surface > thumbnail; per-planet style cohesion via single MaterialSet.
- **External best-practices research** (in-session 2026-05-23): hybrid retrieve-then-constrain pipeline, transformers.js MiniLM, RRF, strict tool use, style-drift mitigation, catalog options.

### Internal references

- Current planet build chain: `src/world/Galaxy.js:179-192`, `SolarSystem.js:65-111`, `Planet.js:7-74`, `TerrainGen.js:18-92`, `Landmarks.js:8-104`, `Features.js:7-94`.
- LLM tier flow: `src/llm/LLMClient.js:15-65`; `worker/src/routes/llm.js:7,10-14,16-82,84-150`; ping fan-out `src/main.js:193-227`; approach gate `src/main.js:388-403`; Tier 3 at claim `src/main.js:534-559`.
- Style cohesion levers: `src/world/Planet.js:17,20,36,50,94-136`; `src/world/TerrainGen.js:9-16`; `src/world/Landmarks.js:75-104`; `src/world/Features.js:54,75`; `src/world/Atmosphere.js:79-84`.
- Thumbnail capture: `src/logbook/ThumbnailCapture.js:62-69,108-152`; consumer `src/main.js:563-567`.
- Identity tuple: `src/world/Galaxy.js:102-115`.
- Prior plan convention: `docs/plans/2026-05-20-001-feat-logbook-cloud-memoir-plan.md`.
- Roadmap entries this supersedes: `plan.md:167-168`.

### External references

- [Anthropic Structured Outputs (strict tool use, enums)](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Anthropic Tool Use docs](https://docs.anthropic.com/en/docs/build-with-claude/tool-use)
- [transformers.js semantic search docs](https://deepwiki.com/huggingface/transformers.js-examples/3.3-semantic-search-and-embeddings)
- [Xenova/all-MiniLM-L6-v2 (browser-ready ONNX)](https://huggingface.co/Xenova/all-MiniLM-L6-v2)
- [MiniSearch (BM25 lib, ~10 KB)](https://github.com/lucaong/minisearch)
- [Hybrid Search in Production (BM25 + dense)](https://tianpan.co/blog/2026-04-12-hybrid-search-production-bm25-dense-embeddings)
- [Reciprocal Rank Fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)
- [Three.js GLTFLoader docs](https://threejs.org/docs/#examples/en/loaders/GLTFLoader)
- [Three.js DRACOLoader docs](https://threejs.org/docs/#examples/en/loaders/DRACOLoader)
- [Quaternius (CC0 low-poly packs)](https://quaternius.com/)
- [Kenney Assets (CC0 kits)](https://kenney.nl/assets)
- [KayKit on itch.io (CC0)](https://kaylousberg.itch.io/kaykit-adventurers)
- [Poly Pizza (CC0 + CC-BY low-poly)](https://poly.pizza/)
- [Poly Pizza API v1.1](https://poly.pizza/docs/api/v1.1)
- [UnrealLLM: LLM-powered PCG paper](https://aclanthology.org/2025.findings-acl.994/)
- [DB-driven 3D level gen with LLMs](https://arxiv.org/pdf/2508.18533)
- [No Man's Sky procgen overview (biome tagging + rules)](https://nomanssky.fandom.com/wiki/Procedural_generation)

### Related work

- Prior cloud-memoir plan: `docs/plans/2026-05-20-001-feat-logbook-cloud-memoir-plan.md`.
- Recent merged PRs: #5 (per-user galaxy seed), #8 (position persistence) — both rely on identity tuple stability which this plan extends.
