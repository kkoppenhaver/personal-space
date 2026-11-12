# Planet visuals — asset catalog

This directory holds the curated 3D asset library that drives planet visuals (per the [planet visuals plan](../../../docs/plans/2026-05-23-001-feat-planet-visuals-llm-driven-assets-plan.md)).

## Layout

```
src/world/assets/
├── README.md              ← this file
├── catalog.source.json    ← hand-curated metadata (committed; no embeddings)
└── catalog.json           ← generated; metadata + embeddings (committed)

public/assets/bundled/     ← committed, colour-baked GLBs (served at /assets/bundled/…)
├── quaternius/<pack>/*.glb
├── kenney/<pack>/*.glb
└── kaykit/<pack>/*.glb
```

## Adding a new asset

1. **Download the GLB** from one of the supported CC0 sources (see [Sourcing](#sourcing) below). Drop it under the appropriate `bundled/<pack>/<theme>/` subdirectory.
2. **Bake it.** Kit imports go through `tools/import-assets.js`, which runs the colour bake (see [Colour bake](#colour-bake-vertex-colours)): authored colours → `COLOR_0`, one primitive, Draco. Don't hand-optimize bundled files with `gltfpack`/`gltf-transform optimize`; that drops the vertex-colour contract. Poly Pizza assets are fetched at runtime and not bundled.
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

- **`tools/import-assets.js`** walks the raw mirror (`~/code/3d-modles/assets`), picks the allowlisted models per kit, and writes each one through the colour bake below into `public/assets/bundled/<creator>/<pack>/`. Existing files are skipped; `--no-opt` copies raw files instead of baking.
- **`tools/bake-colors.mjs`** (the colour bake; see next section). Re-bake every bundled file from its mirror source with `node tools/bake-colors.mjs` (or `node tools/bake-colors.mjs kenney_pirate quaternius_nature` for some kits; add `--report` to rewrite `tools/bake-report.json`). File names and the bundled set never change, so the catalog does not need rebuilding.
- **`tools/verify-bake.mjs <beforeDir>`** checks a re-bake against a copy of the previous bundled files: same file set, `COLOR_0` everywhere, no textures/UVs, bbox within 0.5%, triangle and primitive counts, byte totals. `--colors N` prints the baked colours of N assets per pack.
- **`tools/embed-catalog.js`** reads `catalog.source.json`, generates `catalog.json` with embeddings.
- **`tools/copy-decoders.js`** (postinstall) copies Three.js DRACO + Basis decoders to `public/draco/` and `public/basis/` so the loader can fetch them at runtime.
- Both are idempotent; safe to re-run.

## Colour bake (vertex colours)

Every bundled GLB carries its authored colours as **vertex colours** and nothing else, so the runtime can grade one shared material instead of fetching textures:

- every primitive has `COLOR_0` (float VEC3, **linear** RGB, as glTF requires): texel colour (sRGB → linear, nearest texel at the vertex's `TEXCOORD_0`, sampler wrap and `KHR_texture_transform` offset/scale honoured, top-left UV origin) × `baseColorFactor`. A material without a texture contributes its factor;
- one neutral material named `baked` (white, metallic 0, roughness 1, `doubleSided` if any source material was); no images, textures, `TEXCOORD_*`, animations or skins;
- node transforms are baked into the vertices and all primitives are joined, so every asset is **one primitive** (one draw call). Static pose and bounding box are unchanged; triangle counts equal the authored source (the old `gltf-transform optimize` pass also simplified meshes, so counts are a few % higher than before the bake);
- Draco: positions 14 bit, normals 10 bit, colours 12 bit (max colour error measured at 0.1/255 in sRGB, no banding).

An asset whose colour cannot be recovered is still baked, but without `COLOR_0`; the runtime then falls back to the flat family colour. Today there are none.

### Colour source per pack

| Pack | Source |
|---|---|
| kenney/nature, kenney/space, quaternius/crops, quaternius/animals, quaternius/farm_animals | material `baseColorFactor`s in the source GLB |
| kaykit/forest, kaykit/space_base | embedded atlas texture sampled at the UVs (two untextured KayKit grass meshes use the name palette) |
| kenney/castle, kenney/graveyard, kenney/pirate, kenney/fantasy_town | the kit's `Textures/colormap.png` sampled at the UVs. **Not in the raw mirror**; see below |
| quaternius/space | `Ultimate Space Kit - March 2023/Atlas.png` sampled at the source UVs (the exported material was unlinked default grey) |
| quaternius/nature | the pack's `glTF/` textures, matched to materials by name (`Rock` → `Rocks.jpg`). Opaque detail textures (bark, rock) → whole-texture mean of linear texels; alpha-cut sheets (leaves, flowers, petals) → mean of the opaque texels each UV island covers, so a pink flower card stays pink next to its green leaf card. `Grass_Large` (material `None`) uses the name palette |
| quaternius/stylized_trees | the name palette: the pack ships no textures anywhere in the mirror |
| quaternius/ruins | material factors; the unlinked default-grey `Texture_Leaves`/`Leaf_Texture`/`Green` materials use the name palette |

### Name palette (`tools/part-palette.json`)

Used only for a material with no texture whose factor is Blender's unlinked default grey (0.64 or 0.8), in kits that opt in (`namePalette: true` in `BAKE_CONFIG`). Each rule is a case-insensitive regex tested against `<assetName>/<materialName>`; first match wins, colours are sRGB hex. Species rules come first (birch bark pale cream `#d8d2c4`, birch leaves `#9cc15a`, pine needles dark `#2f5e3c`, maple warm `#d0682e`, dead wood grey-brown `#6e6052`, …), then generic bark `#6b4a2f` / foliage `#4e8f3a` / grass / rock. Edit the JSON and re-run the bake for the affected kits.

### Kenney colormap atlases (needed for a re-import)

The castle, graveyard, pirate and fantasy-town kits reference an external `Textures/colormap.png` that the raw mirror does not include. The bake reads them from `$KENNEY_COLORMAP_DIR` (default `~/code/kenney-colormaps`):

```
~/code/kenney-colormaps/castle-kit/colormap.png        # Castle Kit 2.0
~/code/kenney-colormaps/graveyard-kit/colormap.png     # Graveyard Kit 5.0
~/code/kenney-colormaps/pirate-kit/colormap.png        # Pirate Kit 2.1
~/code/kenney-colormaps/fantasy-town-kit/colormap.png  # Fantasy Town Kit 2.0
```

They come from Kenney's own uploads on OpenGameArt (`opengameart.org/content/<kit>`, file `Models/GLB format/Textures/colormap.png` in the zip). Every mirror GLB of those kits is byte-identical to the GLB in the same zip, so the atlas is the one the models were authored against. If an atlas is missing, `bake-colors.mjs` skips that kit and leaves its files untouched. The atlases are not shipped; the bake makes them unnecessary at runtime.

## Sanity checks

The first time `AssetCache` loads at runtime (Phase 2), `catalog.json`'s `dim` and `model` fields are asserted against the runtime embedder config. Mismatch → build fails loudly rather than silently producing bad shortlists.
