---
title: Planet visuals Phase 12 — world archetypes + seed-derived sparks
type: feat
status: planned
date: 2026-06-10
parent: docs/plans/2026-05-23-001-feat-planet-visuals-llm-driven-assets-plan.md
---

# Planet visuals Phase 12 — world archetypes + seed-derived sparks

## Overview

Phase 12 of the [planet-visuals workstream](2026-05-23-001-feat-planet-visuals-llm-driven-assets-plan.md). Phases 1-10 built a pipeline where the LLM directs each world's look — but in practice the worlds it directs all feel like cousins. There is no planet ruled by cats. There is no all-water planet dotted with deserted ships. This phase attacks **why**, with a mechanism that keeps determinism and cache-friendliness: a **seed-derived archetype roll** that constrains the LLM instead of hoping it gets weird on its own.

Three changes, in dependency order:

1. **Archetype tables** (`src/world/Archetypes.js`) — a deterministic weighted roll from the planet seed over curated world archetypes (*ocean world, shipwreck graveyard, ruled-by-creatures, ruin field, monolith world, …*), each carrying terrain parameters, composition rules, and a prompt fragment for Tier 2.
2. **Parametric terrain** — `TerrainGen.buildPlanetGeometry` accepts `seaLevelQuantile` / `ampScale` so an ocean-world archetype produces actual 90%-water terrain, not a green continent labeled "ocean".
3. **Creature role + catalog expansion** — import CC0 animal packs and add a `creature` slot to retrieval, the pick schema, and placement. This is what unlocks "planet ruled by cats".

## Problem Statement

Four root causes, all confirmed in code:

1. **LLM mode collapse.** `/tier2/direct` receives `{ seed, context: { radius } }` (`worker/src/routes/llm.js:254-270`). The seed integer doesn't meaningfully steer a language model — given near-identical prompts, Sonnet converges on its modal outputs. Worse, the system prompt's own theme examples (`"abandoned observatory", "cat sanctuary", "crystal cathedral", "overgrown ruin"` — `worker/src/routes/llm.js:32`) act as anchors. Players see paraphrases of those four forever. (Ironically, "cat sanctuary" is an example the model *can't* fulfill — see #3.)

2. **Terrain ignores the direction.** Sea level is hard-coded to the 42% elevation quantile (`TerrainGen.js:56-57`), and the elevation-band constants downstream assume it: landmark bands `COAST_LO = 0.42 … SPIRE_LO = 0.90` (`Landmarks.js:20-26`), surface-scatter candidate filter `e >= 0.46` (`Features.js:55`), terrain sampler default (`TerrainGen.js:101`). An "ocean" biome planet still renders ~58% land. "Entirely water" is unreachable no matter what the LLM asks for.

3. **Catalog gaps.** Of 555 assets: 133 trees, 47 rocks, **zero creatures**. The only animals-adjacent content is 8 Kenney pirate ships (hero role, ocean/forest affinity). The retrieval layer can't shortlist what doesn't exist; strict-tool pick can't select outside the shortlist. A cat planet is impossible by construction.

4. **Fixed composition.** Every planet is exactly 1 hero + 3 landmarks + 2 surface scatter types (pick schema, `worker/src/routes/llm.js:176-190`), scattered round-robin at near-uniform density. Even with different assets, every world has the same *sentence structure*.

## Proposed Solution

### 1. Archetype module (`src/world/Archetypes.js`)

A pure, deterministic roll — `rollArchetype(seed)` via `mulberry32(seed ^ 0xA2C4)` over a weighted table. Because it derives from the seed **client-side**, terrain params are known at planet construction time, *before* (and independent of) the Tier 2 round-trip. Same seed → same archetype → stable across sessions and cache-coherent.

Each entry:

```js
{
  id: 'ocean-world',
  weight: 6,                       // relative roll weight
  label: 'ocean world',
  // Prompt fragment injected into the Tier 2 user message:
  spark: 'an endless water world — whatever stands here floats, drifts, or wrecked long ago',
  biomes: ['ocean', 'ice'],        // allowed biome subset (null = any)
  terrain: { seaLevelQuantile: [0.85, 0.95], ampScale: 0.6 },
  composition: { landmarks: [0, 1], surface: [1, 2], creatures: [0, 0] },
}
```

**Initial table (~14 entries; weights keep "standard" worlds at ~40-50% so archetypes read as discoveries, not a slot machine):**

| Archetype | Terrain | What it unlocks (existing assets) |
|---|---|---|
| `standard` (w≈12) | defaults | current behavior, no constraints |
| `ocean-world` | sea 85-95% | pirate ships (8, incl. `ship-wreck`) as floating heroes |
| `archipelago` | sea 65-75%, amp 1.2× | island-hopping coastlines |
| `desert-sea` | sea 0%, amp 0.8× | waterless dune worlds |
| `shipwreck-graveyard` | sea 55-70% | multiple wrecks at coasts |
| `ruled-by-creatures` | defaults | **requires workstream 4** — one species everywhere |
| `ruin-field` | defaults | quaternius_ruins (21), kenney_castle (25) |
| `necropolis` | sea ≤ 20% | kenney_graveyard (30) |
| `fortress-world` | amp 1.3× | kenney_castle, kenney_fantasy_town |
| `launch-site` | defaults | kenney_space (80), kaykit_space_base (25) |
| `garden-world` | sea 30-40% | quaternius_crops, flowers, density=dense |
| `monolith-world` | amp 0.5× | 1 colossal hero (scale 1.5×), nothing else |
| `frozen-ocean` | sea 85-95%, biome ice | ice palette over flat "sea" |
| `overgrown-world` | defaults, density=dense | 133 trees finally earn their keep |

A second optional **twist roll** (~25% chance, prompt-only — no engine semantics): *"everything oversized", "recently abandoned", "bioluminescent", "split by a single canyon", …* Twists append to the spark text and cost nothing.

**Distribution control is the point**: when the table is data, "too many ocean worlds" is a weight edit, not a prompt-engineering séance.

### 2. Parametric terrain

- `buildPlanetGeometry({ seed, radius, palette, subdivisions, seaLevelQuantile = 0.42, ampScale = 1.0 })` — replace the literal at `TerrainGen.js:57`; return the actual quantile used.
- `makeTerrainSampler` takes the same params (it independently re-derives heights for altitude checks — must agree with the mesh).
- **Unhardcode the 0.42 couplings:** `pickLandmarkSlots` band constants become functions of `seaLevel` (coast band = `[seaLevel, seaLevel + 0.04]`, etc. — `Landmarks.js:20-26`); `Features.js:55` candidate filter becomes `e >= seaLevel + 0.04`. At sea 0.92 there's almost no land — composition rules (workstream 3) handle that, but slot-picking must not crash on empty bands (it already has a relax-and-retry fallback; extend it to return fewer slots gracefully).
- **Water placement mode.** Ocean worlds need heroes ON the water. Water vertices flatten to `radius * 0.995` (`TerrainGen.js:70`), so placement is trivial: a new catalog flag `placement: 'float'` (ships, buoys) mounts at sea-surface height with radial up + random twist, skipping ground-snap. Landmark slot-picking gains an `open-water` kind for these archetypes (any water vertex far from coast, angular-spread filtered as today).
- Planet construction threads `archetype.terrain` through `Planet` → `buildPlanetGeometry` (rolled values seeded from planet seed so a range like `[0.85, 0.95]` is deterministic per planet).

### 3. Worker + prompt integration

- Client sends `context: { radius, archetype: { id, label, spark, biomes } }` on `/tier2/direct`. The KV cache key already hashes context (`hashContext`, `worker/src/routes/llm.js:256`) → new keys roll out naturally; old entries age out via the 30-day TTL. Bump the client localStorage cache (`LS_CACHE_KEY` → `v3`, `LLMClient.js:20`) so returning players re-roll.
- **System prompt changes** (`worker/src/routes/llm.js:26-38`):
  - Add: *"You will be given a world ARCHETYPE rolled by the engine. It is a hard creative constraint: theme, palette, landmarks, and hints must all be a specific interpretation of it. Do not generalize back toward a default planet."*
  - **Delete the four example themes** — they're anchors. If examples are needed, describe the *shape* of a good theme ("a 2-4 word noun phrase a location scout would write") instead of instances.
  - When `archetype.biomes` is non-null, instruct the model to pick from that subset (schema keeps the full enum; this is soft, and fine — worst case is an off-biome palette, not a crash).
- `composition` does **not** go to the LLM — it's engine-side (workstream 5 wiring) so a degraded/fallback pick still honors archetype structure.

### 4. Creature role + catalog expansion

- **Import CC0 animal packs** via the existing `tools/import-assets.js` + `tools/embed-catalog.js` flow:
  - Quaternius **Ultimate Animated Animals** (~30 species incl. cat, fox, wolf, pig — CC0)
  - Kenney **Animal Pack** (~20 species — CC0)
  - During import, **strip skeletons/animations** (gltf-transform prune) and bake a neutral standing pose if the bind pose reads poorly — scatter placement uses `InstancedMesh`, which can't skin. Static low-poly quadrupeds read fine at our art bar.
- Catalog schema: `role: 'creature'`, `family: 'creature'`, biome affinities per species (penguin → ice, camel → desert, cat → anywhere because cats), `scale_range` ~`[0.6, 1.4]`.
- Retrieval: `SHORTLIST_K.creature = 10` (`LLMClient.js:38`); query built from a new Tier 2 hint field `inhabitant_hints` (added to the world_describe schema as optional — backward-compatible like the Phase 3 fields).
- Pick schema: add `creature_a`, `creature_b` (enum-per-slot like the rest, `worker/src/routes/llm.js:176-190`). **Schema-versioning note:** include slots only when the request carries a creature shortlist, so old clients hit the old tool shape; cache key already covers it (sorted shortlist IDs).
- Placement: creatures scatter like surface features but in **small clusters near landmarks** (they gather where the interesting things are), flat-ground only, count from `archetype.composition.creatures` × density. `ruled-by-creatures` sets a single species at elevated counts (15-30 instances) — that's what "ruled by cats" looks like from a paper airplane.
- ColorSystem: `creature` family entry with low biome-blend (~15%) so cats stay cat-colored on a purple planet.

### 5. Composition + retrieval flexibility

- `Planet.applyVisuals` consumes `archetype.composition`: landmark mount count clamps to the range, surface scatter kind count likewise, creature instancing per above. The pick schema keeps requesting 3 landmarks (cheap); the engine just mounts fewer when composition says so.
- **Biome pre-filter softening** (`AssetRetriever.js` shortlist): today `biome_affinity` is a hard pre-filter. With sparse per-biome coverage, every ocean world shortlists the same ~10 things. Change to: hard filter, but if it yields `< 2K` candidates, re-run unfiltered with a `0.5×` score penalty for off-biome candidates. Diversity beats purity at this catalog size.

## Phasing / PR split

- **12a — archetypes + terrain + prompts** (no new assets). Ships ocean worlds, ruin fields, necropoli, monolith worlds using the existing 555. Independently valuable.
- **12b — creatures** (catalog import + role + placement + pick-schema slots). Ships `ruled-by-creatures`.

## Success criteria

- Approaching 10 fresh planets yields ≥4 distinct archetypes and no two near-identical themes (manual eyeball, then a `__GAME.rollStats(n)` dev hook that prints archetype distribution for n simulated seeds).
- An `ocean-world` seed renders ≥85% water with a floating/wrecked hero; a `desert-sea` seed renders zero water.
- A `ruled-by-creatures` seed renders 15+ instances of one species, ground-snapped, biome-appropriate.
- Same seed re-rolls identically across sessions (archetype, terrain params, composition).
- Worker deploy + client deploy are order-independent (archetype context is additive; old worker ignores it, old client sends nothing).

## Risks

| Risk | Mitigation |
|---|---|
| Near-all-water worlds break landmark slot-picking / claim flow assumptions | Extend slot relax-fallback to return fewer slots; `open-water` slot kind; test sea=0.95 explicitly |
| `makeTerrainSampler` drifts from mesh at non-default quantiles (it approximates range) | Already approximate today; verify altitude behavior at extremes, clamp `seaLevelQuantile` to [0, 0.95] |
| Animal bind poses look broken when de-skinned | Audit in the Phase 13 contact sheet before shipping 12b; bake poses where needed |
| Archetype spark overwhelms biome variety (every ocean world identical) | Spark text stays one clause; twist roll adds spread; weights tunable per prod observation |
| New pick-schema slots invalidate KV cache broadly | Cache key already includes shortlist hash; creature-less requests keep old shape/keys |

## Effort

~3-4 days: 12a ≈ 2 days (archetype module + terrain threading + prompt/worker + tests), 12b ≈ 1.5-2 days (asset import/curation is the long pole).
