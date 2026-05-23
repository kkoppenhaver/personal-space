# Planet visuals — asset catalog

This directory holds the curated 3D asset library that drives planet visuals (per the [planet visuals plan](../../../docs/plans/2026-05-23-001-feat-planet-visuals-llm-driven-assets-plan.md)).

## Layout

```
src/world/assets/
├── README.md              ← this file
├── catalog.source.json    ← hand-curated metadata (committed; no embeddings)
├── catalog.json           ← generated; metadata + embeddings (committed)
└── bundled/               ← committed GLB files, organized by pack
    ├── quaternius/
    │   └── nature/
    │       ├── tree_oak_01.glb
    │       └── ...
    ├── kenney/
    │   ├── space/
    │   └── pirate/
    └── kaykit/
        └── adventurers/
```

## Adding a new asset

1. **Download the GLB** from one of the supported CC0 sources (see [Sourcing](#sourcing) below). Drop it under the appropriate `bundled/<pack>/<theme>/` subdirectory.
2. **Optional: optimize the GLB** with `gltfpack -cc -tc input.glb output.glb` — Draco + Meshopt compression + texture quantization. ~3-8× smaller for low-poly assets with negligible visual loss. Skip for Poly Pizza-fetched assets (already optimized).
3. **Add metadata** to `catalog.source.json`:
   ```jsonc
   {
     "id": "quaternius:nature:tree_oak_01",     // <pack>:<theme>:<asset>; short + readable
     "name": "Tall oak tree",                    // human-readable; goes into embedder input
     "pack": "quaternius_nature",
     "creator": "Quaternius",
     "license": "CC0",                           // or "CC-BY" (attribution required)
     "attribution": null,                        // required string for CC-BY
     "url": "/assets/bundled/quaternius/nature/tree_oak_01.glb",
     "role": "surface",                          // hero | landmark | surface | decor
     "tags": ["tree", "oak", "deciduous", "tall"],
     "biome_affinity": ["jungle", "temperate_forest", "ruined_city"],
     "theme_affinity": ["ancient", "overgrown"],
     "scale_range": [2.0, 6.0]                   // min/max meters
   }
   ```
4. **Tag the matSlot on GLB meshes** (optional, recommended). Either set `mesh.userData.matSlot = "flora"` via `gltf-transform`, or use Blender-style name prefixes (`tree_*` → `tree`, `rock_*` → `rock`). The MaterialSet uses this to pick the right per-planet material.
5. **Rebuild embeddings:** `npm run build:catalog`. This reads `catalog.source.json`, runs MiniLM over each asset's metadata, and writes the runtime `catalog.json`.

## Sourcing (CC0 unless noted)

Visually compatible packs that fit the Kenney-vibe chunky low-poly aesthetic:

- **[Quaternius](https://quaternius.com/)** — CC0, no attribution. Nature, animals, dinosaurs, modular kits.
- **[Kenney.nl](https://kenney.nl/assets?q=3d)** — CC0, no attribution. Pirate, city, space, dungeon, modular kits.
- **[KayKit (Kay Lousberg)](https://kaylousberg.itch.io/)** — CC0, no attribution. Characters, dungeons, adventure kits.
- **[Poly Pizza](https://poly.pizza/)** — mixed CC0 + CC-BY. Bigger variety; CC-BY requires attribution. v1 of the catalog ships CC0-only; Poly Pizza integration arrives in Phase 7 of the plan.
- **[Synty (paid)](https://syntystore.com/)** — POLYGON packs. Stylistically adjacent but commercial; not included v1.

## Roles

| Role | Count per planet | Notes |
|---|---|---|
| `hero` | 1 | Visible from approach silhouette. Big, distinctive. Hand-crafted PBR material kept (MaterialSet sentinel = `null` → opt out of override). |
| `landmark` | 3-5 | Anchors for Tier 3 lore; frame the claim thumbnail. Material overridden to the planet's accent. |
| `surface` | populated densely (10-200 instances) | Trees, rocks, small structures. `InstancedMesh` per asset. |
| `decor` | scattered | Small detail meshes. Material override applies. |

## Build pipeline

- **`tools/embed-catalog.js`** reads `catalog.source.json`, generates `catalog.json` with embeddings.
- **`tools/copy-decoders.js`** (postinstall) copies Three.js DRACO + Basis decoders to `public/draco/` and `public/basis/` so the loader can fetch them at runtime.
- Both are idempotent; safe to re-run.

## Sanity checks

The first time `AssetCache` loads at runtime (Phase 2), `catalog.json`'s `dim` and `model` fields are asserted against the runtime embedder config. Mismatch → build fails loudly rather than silently producing bad shortlists.
