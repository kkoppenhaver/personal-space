---
title: Planet visuals Phase 7 — Poly Pizza offline ingestion + CC-BY attribution
type: feat
status: active
date: 2026-05-24
parent: docs/plans/2026-05-23-001-feat-planet-visuals-llm-driven-assets-plan.md
supersedes: Phase 7's original runtime-proxy framing (Worker /assets/polypizza proxy + ASSET_CACHE KV + Workers-AI embed-on-demand)
---

# Planet visuals Phase 7 — Poly Pizza offline ingestion + CC-BY attribution

## Overview

Phase 7 of the [planet-visuals workstream](./2026-05-23-001-feat-planet-visuals-llm-driven-assets-plan.md). Adds **variety** to the asset catalog by ingesting low-poly models from [Poly Pizza](https://poly.pizza) (both CC0 and CC-BY), and ships the **attribution** surfaces that CC-BY legally requires.

**This plan supersedes the original Phase 7 framing.** The parent plan specced a *runtime* Worker proxy (`/assets/polypizza/:id`) + `ASSET_CACHE` KV + Workers-AI embed-on-demand. We're replacing all of that with **build-time offline ingestion** (decided with the user, 2026-05-24): pull + optimize + self-host + pre-embed Poly Pizza models through an extension of the existing asset pipeline. No runtime network dependency, no CORS, no KV, no Workers AI. The catalog is already 555 CC0 assets (Phase 4 hit the original "500+" target), so this is about *variety + new asset families*, not raw count.

Because CC-BY is in scope (also a user decision), we build the attribution data model + UX: snapshot each claimed planet's asset attributions onto its logbook entry (legally durable), show them in the logbook detail view, and ship a `/credits` page. A linked credits page is, per Creative Commons' own guidance, **legally sufficient on its own** for CC-BY 4.0 — per-planet attribution is not required — so the credits page is the load-bearing compliance artifact and the per-entry list is a nice-to-have.

Four workstreams:
- **7A — Offline ingestion.** New `tools/import-polypizza.js`: fetch by category → license-filter → download → optimize → self-host → emit a *separate* catalog source file + a committed `models.lock.json` (frozen attribution).
- **7B — Attribution persistence.** Snapshot resolved `{title, creator, source_url, license}` onto the logbook entry at claim; thread through the client + worker allowlists + a D1 migration; backfill via the existing Tier-3 PATCH.
- **7C — Logbook detail UX.** An "Assets" section in the entry detail view listing CC-BY attributions (linked, escaped).
- **7D — /credits page.** `public/credits.html` generated from the lockfile, grouped by creator, with a "models optimized for web" modified-disclosure; linked from the account drawer.

## Problem Statement

1. **Catalog variety is capped by what we hand-mirrored.** The 555 CC0 assets come from 13 Kenney/Quaternius/KayKit kits via a local mirror (`~/code/3d-modles/assets`). Poly Pizza hosts thousands more low-poly models — new silhouettes, themes, and families the current kits don't cover. More variety directly serves the brand ("each player's galaxy is uniquely theirs and worth remembering") and Phase 6's diversity goals.

2. **The original runtime-proxy design is over-built for the need.** A runtime `/assets/polypizza/:id` proxy + KV cache + Workers-AI embed-on-demand adds a network dependency on the gameplay hot path, CORS surface, KV storage of binary GLBs, and a second (runtime) embedding path that must exactly match the build-time embedder. All of that exists only to fetch assets the static catalog doesn't already know about — but we control the catalog and can just pre-ingest. Offline ingestion reuses the proven Phase 1-4 pipeline (`import` → `embed-catalog` → `augment-catalog`) and ships assets as ordinary static catalog rows.

3. **CC-BY brings a legal obligation we don't currently meet.** All 555 current assets are CC0 (`attribution: null`). The moment a CC-BY model appears on a planet, CC-BY 4.0 requires attribution (author + source + license + modified-disclosure). Today: `selected_assets` isn't persisted to logbook entries, there's no attribution UI, and no `/credits` page. So CC-BY ingestion is blocked on building the attribution surfaces.

## Proposed Solution

### 7A — Offline ingestion (`tools/import-polypizza.js`)

A new, network-fetching importer (distinct from the local-mirror `import-assets.js`):

```
for each target category (Nature, BuildingsAndArchitecture, Objects, ...):
  GET https://api.poly.pizza/v1.1/search?category={Cat}&limit=&page={n}   (X-Auth-Token header, page size 32)
  for each model in results:
    if model.Licence not in {CC0, CC-BY}:  REJECT (fail-closed — see filter below)
    if model.id in models.lock.json with matching sha:  skip (cache hit)
    download model.Download (direct .glb) → cache/{sha256}.glb
    gltf-transform optimize → public/assets/bundled/polypizza/<creatorSlug>/<idSlug>.glb
    derive role + biome + family (see below)
    append row to catalog.polypizza.source.json  (SEPARATE file — see clobber fix)
    append frozen record to models.lock.json
```

**License filter — fail closed.** Accept only `Licence ∈ {"CC0", "CC-BY"}` (note the British spelling the API uses). Reject *and loudly fail the import* on any other value — including unknown, empty, null, or a future `CC-BY-NC`/`CC-BY-SA`. Poly Pizza only hosts CC0 + CC-BY today, but the guard protects against mislabels and future additions. NC matters: personalspace.fun is a live product, so NC assets would be a licensing breach.

**The clobber fix (P0 from SpecFlow).** `import-assets.js` rewrites `catalog.source.json` *wholesale every run* — so it would wipe Poly Pizza rows. Fix: `import-polypizza.js` writes a **separate** `src/world/assets/catalog.polypizza.source.json`. `embed-catalog.js` reads **both** `catalog.source.json` + `catalog.polypizza.source.json`, concatenates, dedups by id, and emits the unified `catalog.json`. The two importers never touch each other's files. `augment-catalog.js` augments both source files (or the unified one) the same way.

**id slugging (P1 from SpecFlow).** The catalog id is `creator:pack:stem` and `augment-catalog.stemFromId` splits on `:`. Poly Pizza IDs/usernames are opaque and may contain `:` or odd chars. So slug all three segments to `[a-z0-9_-]`: id = `polypizza:<creatorSlug>:<idSlug>`. Assert `id.split(':').length === 3` and fail loudly otherwise. Same slug guards the `public/assets/bundled/polypizza/...` filename.

**role + biome + family for kit-less models (P0 from SpecFlow).** Poly Pizza models match no kit role/biome patterns, so without explicit derivation they'd import as unselectable dead assets. Derive from the API's `Category` + `Tags`:
- **role:** heuristic on `Tri Count` + category (e.g. large architecture/towers → `landmark`/`hero`; small props/rocks/plants → `surface`), with a `models.lock.json` per-id override for hand-tuning.
- **biome_affinity:** map `Category`/`Tags` → the LLM biome enum (`Nature`→forest, etc.), reusing the `BIOME_OVERRIDES` regex spirit from `import-assets.js`.
- **family:** `resolveFamily(title)` (existing); falls through to `'default'` — confirmed safe (ColorSystem.FAMILY_BASE has a `default` entry from Phase 10). Allow a lockfile override.

**Reproducibility — `models.lock.json` (committed).** One record per ingested model: `{id, title, creator_username, creator_url, source_url, license, sha256, downloaded_at, poly_attribution}`. This (a) makes builds reproducible, (b) **freezes attribution even if the upstream model is edited/deleted**, (c) drives the `/credits` generator, (d) is the idempotency key (skip re-download on sha match). A normal build never hits the network — only `import-polypizza.js --refresh` does.

**gltf-transform.** Reuse the existing `optimize --compress draco --texture-compress webp`. Poly Pizza models are generally not pre-Draco'd, so a first-pass compression is safe (don't double-quantize; the importer skips re-optimize on cache hits).

**API key + cost.** `X-Auth-Token` from `POLYPIZZA_TOKEN` env — **build-time only, never committed, never shipped to client/worker**. Commercial use is pay-as-you-go, so the importer takes `--limit N` and `--dry-run`, and the lockfile makes re-runs cache hits (no runaway fetch cost). Politeness: small concurrency (3-5), exponential backoff on HTTP 429 (rate limits are real but unpublished — verify from response headers on first run).

### 7B — Attribution persistence (snapshot onto the entry)

**Snapshot, not resolve-later** (legal durability — if the catalog changes, a published logbook entry must still show correct attribution). At claim (`src/main.js:636`), resolve `meta.selected_assets` IDs via `getAssetById` and snapshot:

```js
entryInput.attributions = selectedAssetIds(p.meta?.selected_assets)
  .map(getAssetById).filter(Boolean)
  .filter(a => a.license && a.license !== 'CC0')   // only CC-BY needs display; see note
  .map(a => ({ id: a.id, title: a.name, creator: a.creator, source_url: a.attribution_url || null, license: a.license }));
```

(We store CC-BY for display; CC0 needs no attribution. Cap the array at the 6 slot count, ~2KB, mirroring the server-side lore cap.)

**The four allowlists + migration (P0 — miss one and attribution silently vanishes):**
1. `src/logbook/LogbookSync.js` `toServerPayload` (~L127) — add `attributions` (miss = never sent, silent).
2. `worker/src/routes/logbook.js` `validateEntryInput` (~L237) — allow `attributions` (miss = stripped, silent).
3. `worker/src/routes/logbook.js` INSERT column list + `.bind()` (~L51-67) — add the column (miss = bind arity throw, **loud** — the safe one).
4. `worker/src/routes/logbook.js` `GET` SELECT explicit column list (~L22) + `decodeEntry` (~L211, `JSON.parse`) — add `attributions` (miss = silent read drop — **the most dangerous**, since GET hydrates the list).
5. **D1 migration `worker/migrations/0003_entry_attributions.sql`:** `ALTER TABLE entries ADD COLUMN attributions TEXT;` (JSON-in-TEXT, nullable — matches the `0002` `last_position` pattern). Store via `JSON.stringify`, read via `JSON.parse` in `decodeEntry` (mirror `palette`/`landmarks`).
6. `LogbookStore.add` (field-by-field) + `mergeForDedupe` — add the field. IndexedDB is schemaless (no migration).

**Claim-before-Tier-2 → backfill via the existing PATCH (P2).** `selected_assets` is filled by the same Tier-2 pass as `landmarks`; a fast claim can POST before it resolves (`attributions: []`). The Tier-3 lore PATCH (`PATCH /api/logbook/:id`) already backfills `landmarks` — add `attributions` to that PATCH allowlist (~L96-110) and re-snapshot there. Detail view tolerates empty until backfill.

**Deploy ordering:** apply migration `0003` to **remote** D1 *before* deploying the worker that SELECTs the new column (else GET throws "no such column"). Runbook: `wrangler d1 migrations apply personal-space --remote` → then `wrangler deploy`.

### 7C — Logbook detail view

`src/ui/Logbook.js` `_renderDetail` is innerHTML-templated. Add an "Assets" block (mirroring the existing `landmarksHtml` map, before `detail-ts`), rendering each CC-BY attribution as an escaped, linked line:

> *"Pine Tree" by [creator](profile) — CC BY 4.0*

Hidden entirely when `attributions` is empty/null (CC0-only or pre-backfill planets). Use the existing `esc()` helper for all interpolation.

### 7D — /credits page

`public/credits.html` (static passthrough like `public/privacy.html` — served at `/credits.html`, **no Vite config change** since `public/` files copy verbatim). **Generated at build** from `models.lock.json` by a small script (`tools/build-credits.js`, run in the build chain) so it's never stale:
- Lead sentence: *"Personal Space uses 3D models from Poly Pizza, created by the artists below, licensed under CC0 and CC BY 4.0. Models were optimized for web delivery."* (the blanket **modified-disclosure** CC-BY 4.0 §3.a requires).
- **Grouped by creator** (IGDA crediting convention), each linking the creator profile + each model's source page + the CC BY 4.0 deed.
- Account-drawer link: add a `Credits →` `<a>` sibling to the existing "What we store →" link in `index.html:167`.

## Technical Approach

### Architecture

```
BUILD TIME (offline)
  tools/import-polypizza.js   (NEW) — fetch/filter/download/optimize/host; writes:
    ├── public/assets/bundled/polypizza/<creator>/<id>.glb   (optimized GLBs)
    ├── src/world/assets/catalog.polypizza.source.json       (SEPARATE source rows)
    └── models.lock.json                                     (committed; frozen attribution)
  tools/embed-catalog.js      (EDIT) — read BOTH source files → merge/dedup → catalog.json
  tools/augment-catalog.js    (EDIT) — augment both sources
  tools/build-credits.js      (NEW) — models.lock.json → public/credits.html

RUNTIME (client) — unchanged asset path; Poly Pizza rows are ordinary static catalog entries
  src/main.js:636             (EDIT) — snapshot attributions onto entryInput at claim
  src/logbook/LogbookSync.js  (EDIT) — toServerPayload allowlist + attributions
  src/logbook/LogbookStore.js (EDIT) — add/dedupe field
  src/ui/Logbook.js           (EDIT) — detail-view "Assets" section
  index.html:167              (EDIT) — "Credits →" link

WORKER
  worker/migrations/0003_entry_attributions.sql  (NEW) — ADD COLUMN attributions TEXT
  worker/src/routes/logbook.js (EDIT) — INSERT, validateEntryInput, GET SELECT, decodeEntry, PATCH allowlist
```

### Data model — entry attributions (ERD-ish)

```
entries (D1)                          logbook entry (client / synced)
  ... existing columns ...              ... existing fields ...
  attributions TEXT  ◀── JSON ──▶       attributions: [
                                          { id, title, creator, source_url, license }   // ≤6, CC-BY only
                                        ] | null
```

### Failure modes & resilience

- **Import: model 404 / download fail / decode fail** → skip that model, log, continue (don't fail the whole import for one bad asset). Lockfile only records successful ingests.
- **Import: unknown license** → fail the run loudly (fail-closed; never silently include).
- **Import re-run** → lockfile + content cache = cache hits, no re-download, no API cost.
- **`import-assets.js` run after `import-polypizza.js`** → separate source files mean no clobber (the core fix).
- **Claim before Tier-2** → `attributions: []`; Tier-3 PATCH backfills.
- **Catalog drops an asset later** → persisted entry still shows correct attribution (snapshot, not id-resolve).
- **Worker deployed before migration** → GET throws "no such column"; mitigated by the migrate-remote-first runbook + a deploy checklist.
- **Account deletion / galaxy reset** → `attributions` lives in the entries row, cleaned up for free by existing DELETE/reset flows (no side table).

### Integration test scenarios

1. **Round-trip attribution.** Claim a planet with a CC-BY asset → entry POSTed with `attributions` → GET hydrates it → detail view shows the linked credit. (Guards all 4 allowlists, esp. the GET SELECT.)
2. **CC0-only planet.** Claim a planet with only CC0 assets → `attributions: []` → no "Assets" section rendered, no error.
3. **Claim-before-resolve.** Force claim before Tier-2 picks resolve → entry POSTs `attributions: []` → Tier-3 PATCH backfills → detail view updates on next open.
4. **Importer idempotency.** Run `import-polypizza.js` twice → second run is all cache hits (no downloads, no API calls beyond search), `catalog.polypizza.source.json` + `models.lock.json` byte-stable.
5. **Importer clobber-safety.** Run `import-polypizza.js`, then `import-assets.js`, then `embed-catalog.js` → Poly Pizza rows survive in `catalog.json`.
6. **License fail-closed.** Importer fed a fixture model with `Licence: "CC-BY-NC"` (or empty) → import fails loudly, nothing written.
7. **/credits freshness.** Add a model → rebuild → `credits.html` lists the new creator/model with working source + license links.

## Alternative Approaches Considered

| Approach | Why rejected |
|---|---|
| **Runtime Worker proxy + KV + embed-on-demand** (original Phase 7) | Network dependency on the gameplay path, CORS surface, binary GLBs in KV, a runtime embedder that must exactly match the build-time one. All to fetch assets we can just pre-ingest. *(User decision: offline.)* |
| **CC0-only ingestion** (drop attribution work) | Simpler, but the user explicitly wants CC-BY content for the variety. The attribution surfaces are a bounded, one-time build. *(User decision: include CC-BY.)* |
| **Store asset IDs on the entry, resolve at render** | Cheaper, but if the catalog drops/repoints an asset the published entry shows wrong/no attribution — a license breach on a published record. Snapshot is legally durable. |
| **Merge Poly Pizza rows into `catalog.source.json`** | `import-assets.js` rewrites that file wholesale → clobber. Separate `catalog.polypizza.source.json` decouples the importers. |
| **Per-planet on-screen attribution (HUD/overlay)** | Not required by CC-BY 4.0 (a linked credits page suffices) and would clutter the HUD. Detail-view + /credits is compliant and unobtrusive. |
| **Clean `/credits` URL via rewrite** | `public/credits.html` → `/credits.html` matches the existing `privacy.html` with zero config. A clean URL needs a rewrite rule; not worth it for parity. |

## Acceptance Criteria

### Functional — ingestion (7A)
- [ ] `tools/import-polypizza.js` fetches by category via `X-Auth-Token` (env `POLYPIZZA_TOKEN`), supports `--limit` + `--dry-run`, and never writes the token to any file.
- [ ] License filter accepts only `{CC0, CC-BY}` and **fails the run loudly** on any other/unknown/empty value.
- [ ] Downloaded GLBs are content-cached by sha256, optimized (draco/webp), and written to `public/assets/bundled/polypizza/<creatorSlug>/<idSlug>.glb`.
- [ ] Writes a **separate** `catalog.polypizza.source.json`; `embed-catalog.js` merges both source files (dedup by id) into `catalog.json`; running `import-assets.js` does not wipe Poly Pizza rows.
- [ ] Catalog ids are `polypizza:<creatorSlug>:<idSlug>`, all `[a-z0-9_-]`, exactly 3 `:`-segments (asserted).
- [ ] role + biome_affinity + family derived for kit-less models (from Category/Tags + Tri Count), with `models.lock.json` per-id overrides.
- [ ] `models.lock.json` committed, freezes `{id,title,creator,creator_url,source_url,license,sha256}`, and makes re-runs cache hits.

### Functional — attribution (7B/7C/7D)
- [ ] At claim, CC-BY asset attributions are snapshotted onto `entryInput.attributions` (≤6, ~2KB cap) via `getAssetById`.
- [ ] `attributions` round-trips POST → D1 → GET → detail view (all four allowlists + migration `0003`).
- [ ] Tier-3 PATCH backfills `attributions` for claim-before-resolve.
- [ ] Logbook detail view renders an escaped, linked "Assets" section for CC-BY entries; hidden when empty.
- [ ] `public/credits.html` generated from `models.lock.json`, grouped by creator, with source + CC BY 4.0 deed links + the "models optimized for web" modified-disclosure.
- [ ] Account drawer links to `/credits.html`.

### Non-functional / quality gates
- [ ] D1 migration `0003` applied remote **before** worker deploy (runbook + checklist).
- [ ] No client/worker runtime dependency on Poly Pizza (assets are static catalog rows).
- [ ] `npm run build` clean; `catalog.json` regenerates with Poly Pizza rows + embeddings.
- [ ] All 7 integration scenarios pass.
- [ ] `docs/licenses.md` documents the license handling + attribution approach.

## Success Metrics
- **Variety:** catalog grows by a meaningful, curated set of Poly Pizza models across biomes/families not well-covered by the current kits (target a few hundred, hand-curated for quality).
- **Compliance:** every CC-BY asset that can appear on a planet is credited on `/credits`; spot-check 10 CC-BY models resolve to correct author + source + license links.
- **Durability:** a logbook entry's attribution still renders correctly after the asset is removed from the catalog (snapshot test).
- **No regressions:** existing CC0 planets/claims/thumbnails unaffected; entry sync round-trips unchanged for CC0-only entries.

## Dependencies & Prerequisites
- **Poly Pizza API key** (free for hobby; **commercial = pay-as-you-go** — flag, since personalspace.fun is live). Register at poly.pizza/settings/api.
- Phases 1-4 pipeline (`import` → `embed-catalog` → `augment-catalog`) — shipped.
- Phase 10 ColorSystem (`family` incl. `default`) — shipped.
- D1 + the logbook entry sync (cloud-memoir plan) — shipped; this adds one nullable column.
- `gltf-transform` CLI — already a dev dependency.

## Risk Analysis & Mitigation

| Risk | Severity | Mitigation |
|---|---|---|
| **Silent attribution drop** (one of 4 allowlists missed) | High | Integration test #1 round-trips through all 4; the GET SELECT (explicit columns) is the dangerous one — call it out in the PR checklist. |
| **Importer clobber** (`import-assets.js` wipes Poly Pizza rows) | High | Separate `catalog.polypizza.source.json`; `embed-catalog` merges. Test #5. |
| **Kit-less models import as dead assets** (no role/biome) | High | Explicit Category/Tags → role/biome derivation + lockfile overrides; assert every imported row has a role. |
| **Commercial API cost runaway** | Medium | `--limit` + `--dry-run` + lockfile cache; one-time curated ingest, not a loop. |
| **License mislabel / contamination** | Medium | Fail-closed filter; test #6 with a poisoned fixture. |
| **Migration/deploy ordering** | Medium | Migrate-remote-before-deploy runbook; deploy checklist. |
| **id slug collisions / `:` in creator names** | Medium | Slug all 3 segments to `[a-z0-9_-]`, assert 3 segments, fail loudly. |
| **Attribution link rot** (model deleted upstream) | Low | Snapshot + lockfile freeze the URLs at ingest; CC-BY only requires the link "to the extent reasonably practicable." |

## Resource Requirements
- **Time:** ~3-4 days. 7A ingestion importer (~1.5d, the bulk — API client, filter, optimize, role/biome derivation, lockfile, embed-merge). 7B persistence (~1d, the 4 allowlists + migration + PATCH). 7C detail view (~0.25d). 7D /credits generator + page (~0.5d). Curation of which models to pull (~0.5d, manual taste).
- **Costs:** Poly Pizza commercial API usage (small, build-time, capped). Self-hosting adds GLB bytes to the bundle/`public` (curate for size).
- **External:** Poly Pizza account + API key.

## Future Considerations
- **Community-contributed CC0 assets** (parent plan v2) — the same offline-ingest + lockfile + /credits machinery extends to a submission flow.
- **Per-asset thumbnails** on /credits (the API returns `Thumbnail`) — nicer credits page.
- **Catalog size management** — if Poly Pizza ingestion balloons the bundle, revisit lazy/region-gated asset loading (overlaps Phase 8).
- **Runtime dynamic tier** — if we ever need assets beyond a curated pre-ingest, the original Worker-proxy design is still viable as an additive tier; this plan doesn't preclude it.

## Documentation Plan
- This plan: `docs/plans/2026-05-24-003-...md`.
- `docs/licenses.md` (NEW) — license handling, attribution format, the lockfile, how to re-run ingestion.
- Update parent plan Phase 7 row → reference this sub-plan; note the runtime-proxy framing is superseded.
- `src/world/assets/README.md` — document the second source file + the two-importer split.

## Sources & References

### Origin
- **Parent plan:** `docs/plans/2026-05-23-001-feat-planet-visuals-llm-driven-assets-plan.md` — Phase 7 row (line 21), license handling (lines 207-210), Worker-changes (lines 595-598), deferred-to-v2 attribution/community (lines 979-985). **Superseded:** the runtime proxy + ASSET_CACHE KV + embed-on-demand framing.
- **User decisions (2026-05-24):** offline ingestion (not runtime proxy); include CC-BY + attribution (not CC0-only).
- **Research synthesis (this turn):** four parallel agents (repo ground truth; learnings; external CC-BY/Poly-Pizza best practices; r-version API/Vite/D1 facts) + SpecFlow gap analysis.

### Internal references
- Pipeline: `tools/import-assets.js` (KITS, `runOptimize`, wholesale rewrite at L9, role/biome L122-147), `tools/family.js` (`resolveFamily`, `stemFromId` split-on-`:`), `tools/embed-catalog.js` (reads `catalog.source.json`), `tools/augment-catalog.js`.
- Catalog: `src/world/assets/Catalog.js` (`getAssetById`), `catalog.source.json` (`attribution`/`license` fields).
- Claim + entry: `src/main.js:636` (entryInput), `selectedAssetIds` helper, `meta.selected_assets` shape.
- Persistence: `src/logbook/LogbookStore.js` (`add`, `mergeForDedupe`), `src/logbook/LogbookSync.js:127` (`toServerPayload`), `worker/src/routes/logbook.js` (INSERT L51-67, `validateEntryInput` L237, GET SELECT L22, `decodeEntry` L211, PATCH L96-110), `worker/migrations/0001_init.sql` + `0002_user_position.sql`.
- UI: `src/ui/Logbook.js` `_renderDetail`, `src/ui/AccountDrawer.js`, `index.html:167` (privacy link), `public/privacy.html`, `vite.config.js` (single-page; `public/` static passthrough).

### External references
- [Poly Pizza API v1.1](https://poly.pizza/docs/api/v1.1) · [API key settings](https://poly.pizza/settings/api) · [Poly Pizza ToS](https://poly.pizza/docs/tos) · model schema via [Chikanz/pizzabox client](https://github.com/Chikanz/pizzabox) (`Title`, `Creator{Username,DPURL}`, `Licence`, `Attribution`, `Download`).
- [CC attribution best practices (CC wiki)](https://wiki.creativecommons.org/wiki/Recommended_practices_for_attribution) · [CC BY 4.0 legal code §3.a](https://creativecommons.org/licenses/by/4.0/legalcode) · [uOttawa attribution guide](https://www.uottawa.ca/library/copyright/what-is-copyright/how-attribute-creative-commons-licensed-content-best-practices)
- [IGDA Game Crediting Guidelines 10.1](https://igda.org/wp-content/uploads/2021/11/IGDA-Game-Crediting-Guidelines-10.1-March-2023.pdf) · [OpenGameArt: crediting many assets](https://opengameart.org/forumtopic/best-practices-on-crediting-a-large-amount-of-assets)
- [gltf-transform CLI](https://gltf-transform.dev/cli) · [Vite multi-page build](https://vite.dev/guide/build.html) · [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/) · [D1 SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/)

### Related work
- Phase 4 (catalog seed, 555 CC0), Phase 6 (PR #16, diversity), Phase 10 (PR #15, ColorSystem `family`), cloud-memoir plan `docs/plans/2026-05-20-001-...` (entry schema, two-phase save, D1).
