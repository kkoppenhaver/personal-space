---
title: Planet visuals Phase 13 — placement engine (orientation, grounding, clustering)
type: feat
status: completed
date: 2026-06-10
parent: docs/plans/2026-05-23-001-feat-planet-visuals-llm-driven-assets-plan.md
---

> **13b shipped (2026-06-10).** Bbox-normalized scale targeting
> (`PlacementRules.resolveScale`: per-role TARGET_HEIGHT, scale_range as a
> clamped bias, scale_override absolute escape hatch — the pirate ships'
> interim override removed); clustered band-aware scatter (per-asset cluster
> centers with angular spread, ~10° grove radius, 80/20 cluster/stray mix,
> per-family SURFACE_BAND elevation bands with thin-band relax, global
> used-vertex dedupe, landmark-footprint exclusion zones); multi-mesh merge
> for scatter instancing (`mergeGeometries` with material groups +
> attribute normalization — trees finally render their canopies). Material
> arrays handled in reveal patching, disposal, and the material audit.

# Planet visuals Phase 13 — placement engine

> **13a shipped (2026-06-10).** Audit verdict from the contact sheet: **all 13
> packs are Y-up** — `PACK_AXIS_UP` stays empty and the "models mount
> sideways" hypothesis was wrong. The real defects were (1) the ground-snap
> clamp `Math.max(0, -min)` which could push assets up but never pull them
> down — kenney_space is authored entirely *above* its origins and floated
> wholesale; and (2) corner pivots (kenney_space, kenney_nature cliffs)
> making twist rotation swing models around their corner. Both fixed
> systematically: **signed ground offset** + **lateral pivot recenter**
> (`AxisUp.js`), no per-asset curation needed. Also shipped in 13a:
> per-family terrain-normal blend + slope gates + embed (`PlacementRules.js`),
> slot flatness preference + exact-vertex slot heights (`Landmarks.js`),
> `?contactSheet=1`, and a minimal `?placementLab=1` (pulled forward from
> 13b as the verification bench). 13b (bbox-normalized scale, clustering,
> multi-mesh merge) remains.

## Overview

Phase 13 of the [planet-visuals workstream](2026-05-23-001-feat-planet-visuals-llm-driven-assets-plan.md). Phase 10 shipped the placement *infrastructure* — bbox ground-snap, the per-pack axis-up override map, `scale_override`, the `__GAME.debugPlacement` overlay — but left the *content work* and several geometric gaps unfinished. The result in prod: models lying on their sides, props leaning out of hillsides, multi-part assets rendering only their first mesh, and a uniform round-robin scatter that makes every planet's dressing feel like the same wallpaper.

Five workstreams:

1. **Contact-sheet audit** — a dev tool to eyeball all 555 assets at once; use it to populate the empty `PACK_AXIS_UP` map and per-asset overrides.
2. **Terrain-normal orientation + slope rules** — per-family alignment blending and slope gating.
3. **Grounding fixes** — embed factor + true surface-height snap, killing float-on-facets.
4. **Bbox-normalized scale** — stop trusting kit-authored units.
5. **Clustered, band-aware scatter** — groves, debris fields, and shoreline wrecks instead of uniform confetti.

## Problem Statement

All confirmed in code:

1. **The axis-up map is empty.** `PACK_AXIS_UP = {}` (`AxisUp.js:21-24`) — the Phase 10 mechanism shipped with zero entries and no pack was ever audited. Any Z-up-authored kit mounts lying on its side, and `groundOffsetFor` reads the wrong bbox axis for those packs (`AxisUp.js:55-64`), so they're misgrounded *and* misoriented.

2. **Orientation uses the radial direction, not the terrain.** Both placement paths build "up" as the normalized vertex position (`Features.js:82`, landmark binding in `Landmarks.js`). On a slope, the visual ground plane is the terrain face, not the sphere tangent — trees and towers lean out of hillsides. There's also no per-family distinction: a rock *should* tumble to the terrain normal; a windmill should stand plumb but only on flat ground.

3. **No slope or band intelligence.** Scatter candidates are simply `elevations[i] >= 0.46` (`Features.js:54-56`): trees spawn on snowcaps and cliff faces, structures on 40° slopes. Landmark slots pick by elevation band only — a `peak` slot can sit on a knife-edge facet.

4. **Multi-mesh GLBs break in scatter.** `extractFirstMeshGeometry` (`Features.js:130-141`) instances only the first descendant mesh — a tree-with-canopy renders as a bare trunk — while ground-snap uses the *whole-model* bbox (`AssetCache.js`), so the offset doesn't even match the rendered fragment. The README says "re-export merged" but nothing enforces or detects it.

5. **Scale trusts authored units.** `scale_range` is kit-level (`catalog.source.json`); kits disagree about what 1 unit means. Phase 10's `scale_override` exists for hand-tuned outliers but nothing systematically normalizes, so some props read dollhouse and others kaiju.

6. **Uniform scatter reads as noise.** Round-robin assignment over shuffled candidates (`Features.js:78-87`) produces statistically uniform sprinkle. Real places cluster: groves, rock fields, settlements. Uniformity is a big contributor to "same-y" even when assets differ.

## Proposed Solution

### 1. Contact-sheet audit tool → populate the maps

`?contactSheet=1` dev route (client-side, reuses the existing loader stack): renders the catalog as a paged grid — each asset on a 1m ground plane with its bbox (yellow), origin axes (RGB), and a 1m scale ruler; labels show `id`, `pack`, bbox dims. Click-to-copy a `catalog.source.json` patch line.

With it, do the one-time pass Phase 10 deferred:

- Populate `PACK_AXIS_UP` for any Z-up packs (15-min eyeball per the `AxisUp.js` header comment, now actually done across all 13 packs).
- Add a per-asset `axis_override` field for stragglers inside otherwise-correct packs (kit re-exports are inconsistent; pack-level alone won't cover it). `axisUpQuaternionFor(pack)` gains an `(pack, assetMeta)` signature, asset override wins.
- Flag assets whose origin is laterally off-center (bbox center xz far from origin) — these spin around the wrong pivot when twisted; add `pivot_offset` to catalog or re-export.
- Audit the new creature packs from Phase 12b before they ship.

Heuristic pre-pass to focus the eyeball time: a script that sorts the contact sheet by "suspicion" (bbox depth > 1.5× height for things tagged tower/tree/spire ⇒ probably Z-up; `|bbox.center.xz|` large ⇒ bad pivot).

### 2. Terrain-normal orientation + slope rules

- **Surface normal lookup:** terrain geometry already computes vertex normals (`TerrainGen.js:88`). Build placement-time `getSurfaceNormal(vertexIndex)` reading the normal attribute — no raycast needed for vertex-anchored placement.
- **Per-family alignment blend** — slerp between radial up and terrain normal:

```js
// 0 = plumb (radial up), 1 = conform to terrain
const TERRAIN_ALIGN = {
  rock: 0.9, stone: 0.9, bone: 0.8,
  flora: 0.25, crystal: 0.3,
  wood: 0.15, structure: 0.0, metal: 0.0,
  creature: 0.0,
};
```

  Composition stays `spin ∘ surfaceUp ∘ axisUp` (`Features.js:112-115`) with `surfaceUp` now targeting the blended up-vector.
- **Slope gating** — `slope = 1 - dot(terrainNormal, radialDir)`; reject candidates above a per-family max:

```js
const MAX_SLOPE = { structure: 0.04, metal: 0.04, flora: 0.12, crystal: 0.18, rock: 1.0, creature: 0.06 };
```

  Landmark slots additionally prefer the *flattest* candidate within their elevation band (score = band fit − slope penalty) instead of pure elevation, so the windmill stops landing on a knife-edge.

### 3. Grounding: embed factor + true-height snap

- **Embed factor.** Ground-snap currently places `bbox.min` exactly at the vertex height — on faceted terrain the base hovers over neighboring faces. Sink each instance by a per-family fraction of its (scaled) bbox height: rocks 12%, flora 6%, structures 2%, creatures 1%. Cheap and kills the float without waiting for Phase 8's subdivision bump (note coordination: Phase 8's smoother terrain will let these constants shrink).
- **Sample height at the actual point, not the vertex.** For clustered scatter (workstream 5) positions fall *between* vertices; use `makeTerrainSampler` (`TerrainGen.js:101`) for height — already the cheap path used for altitude — instead of vertex height, with the embed factor absorbing residual error.

### 4. Bbox-normalized scale

Replace trust-the-units with size-targeting:

```js
// Per-role target world height (meters), modulated by catalog scale_range as a ±bias
const TARGET_HEIGHT = { hero: [12, 22], landmark: [5, 11], surface: [0.8, 3.2], creature: [0.7, 1.5] };
scale = lerp(...TARGET_HEIGHT[role], rand()) / bboxHeightFor(asset);   // bbox along the asset's up axis
```

- `scale_range` becomes a relative bias (e.g. a "small rock" trends toward the low end) rather than an absolute multiplier; `scale_override` (absolute) still wins for hand-tuned cases.
- This also future-proofs Phase 7 (Poly Pizza dynamic assets arrive with arbitrary units).

### 5. Clustered, band-aware scatter

Replace round-robin (`Features.js:78-87`) with a two-level sampler, still fully seeded/deterministic:

- **Cluster centers:** per surface asset, pick `nClusters ≈ ceil(count / 12)` centers from the candidate pool with a minimum angular separation (same greedy dot-product trick as `pickLandmarkSlots`, `Landmarks.js:71`).
- **Members:** sample within a geodesic radius of each center with density falloff toward the edge; positions are direction-space jitter around the center (not vertex-locked), heights via workstream 3's sampler. ~20% of the budget stays globally uniform so the space between clusters isn't sterile.
- **Band assignment per family** replaces the flat `e >= 0.46` filter: flora in the mid band, rocks mid-high, structures on low flats, `placement: 'coast'` assets hug `|e − seaLevel| < 0.03`, `placement: 'float'` (Phase 12) on water. Bands derive from the planet's actual `seaLevel` (Phase 12 makes it variable).
- **Exclusion zones** around mounted landmark/hero bases (radius from their scaled bbox) so scatter stops clipping through landmarks — the existing `excludeZone` mechanism (`Features.js:155`) generalizes from one zone to a list.
- **Multi-mesh fix:** replace `extractFirstMeshGeometry` with `BufferGeometryUtils.mergeGeometries` over all descendant meshes (preserving material groups → one `InstancedMesh` with a material array). Assets that can't merge (mixed transparency) fall back to per-submesh InstancedMeshes sharing the transform list. Either way the rendered thing matches the bbox used to ground it.

### Verification

- Contact sheet doubles as the regression tool: after orientation/scale changes, re-render and eyeball per pack.
- `?placementLab=1` dev scene: one planet, forced asset list + archetype, orbit camera — for screenshot-diffing slope/embed/cluster tuning without flying there.
- `__GAME.debugPlacement` extended to draw the blended up-vector (vs radial) and slope-rejection heatmap on the terrain.

## Phasing / PR split

- **13a — audit + orientation correctness** (workstreams 1-3): contact sheet, axis-up population, normal blending, slope gates, embed. Fixes "orientation isn't always correct" end-to-end.
- **13b — scale + clustering** (workstreams 4-5): normalization, cluster sampler, band assignment, multi-mesh merge. Fixes "feels very same-y" at the placement layer.

## Success criteria

- Zero assets mount sideways across the full contact sheet (all 13 packs + Phase 12 creature packs audited).
- No visible base-float on a `?placementLab=1` sweep across 5 seeds × 3 biomes at default subdivisions.
- Structures never spawn above the slope gate; rocks conform to hillsides; trees stand near-plumb.
- Multi-mesh surface assets render complete (tree-with-canopy shows its canopy).
- Two planets with the same surface assets read differently (clusters land elsewhere); scatter visibly groups into groves/fields.
- Frame cost unchanged: same instance budget, merged geometry keeps draw calls ≤ today's per-asset count.

## Risks

| Risk | Mitigation |
|---|---|
| Contact-sheet eyeball pass is tedious / gets skipped | Suspicion-sorted ordering; it's a one-time ~1-2h pass with click-to-copy patches |
| Terrain-normal blending fights the reveal shader's assumptions | Orientation is set at mount, before reveal; no shader interaction — verify with fade-in active |
| Cluster sampler creates bald planets at low candidate counts (high sea level) | Floor: if candidates < budget × 0.5, fall back to uniform sampling |
| Geometry merge breaks matSet color resolution (per-mesh families) | Merge happens *after* `applyMaterialSet`; material array preserves per-group colors |
| Sampler height ≠ mesh height (known approximation, `TerrainGen.js:106-107`) | Embed factor absorbs small error; clamp sampled height to ±amp of vertex height |

## Effort

~3 days: 13a ≈ 1.5 days (tool ~0.5, audit pass ~0.25, orientation/grounding ~0.75), 13b ≈ 1.5 days (clustering is the design-heavy part).
