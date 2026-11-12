// Single per-planet material source. Today the per-asset color comes from
// the **dual-axis color system** (src/world/ColorSystem.js): an asset's
// `family` (rock, flora, structure, ...) anchors a baseline OKLCH color,
// and the planet's biome shifts that color toward the biome accent by a
// per-family amount. Rocks stay recognizably rocky, flora reads as flora,
// landmarks pop with the accent — all on the same planet.
//
// The MaterialSet here is the *context object* passed to per-mesh color
// resolution: it carries the biome label, the chosen accent hex (from the
// LLM palette), and a few legacy slot templates kept around for the
// terrain mesh and as the "hero" opt-out sentinel.

import * as THREE from 'three';
import { resolveColor, biomeFallbackAccent, gradeCentre, GRADE } from './ColorSystem.js';
import { gradeColors, hexToLinear } from './ColorGrade.js';

/** Strip any "#" / 0x prefix from a hex color string and return an int. */
function hexToInt(c) {
  if (typeof c === 'number') return c >>> 0;
  if (!c) return 0xb0b0b0;
  const s = String(c).replace(/^#/, '').replace(/^0x/i, '');
  return parseInt(s, 16) >>> 0;
}

/**
 * Build a per-planet MaterialSet.
 *
 * @param {{ water:string, low:string, mid:string, high:string, snow:string, sky:string }} palette
 * @param {{ biome?: string|null }} [opts]
 * @returns {{
 *   terrain:  THREE.MeshLambertMaterial,
 *   hero:     null,
 *   sky:      string,
 *   palette:  object,
 *   biome:    string|null,
 *   accent:   number,        // hex int; used as the biome accent for color resolve
 * }}
 */
export function buildMaterialSet(palette, opts = {}) {
  const biome = opts.biome ?? null;
  // The "snow" band reads as the biome's brightest signature — use it as
  // the accent that landmarks and (to lesser degrees) flora/rock blend
  // toward. Fall back to a hard-coded accent if the palette is missing.
  const accent = palette?.snow ? hexToInt(palette.snow) : biomeFallbackAccent(biome);
  return {
    terrain: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
    hero: null,
    sky: palette?.sky,
    palette,
    biome,
    accent,
  };
}

/**
 * Dispose the template materials held by a MaterialSet. Per-mesh cloned
 * materials (created by `applyMaterialSet`) are already disposed by the
 * standard scene-traverse pass in `SolarSystem.dispose`; the templates
 * here aren't on the scene tree, so they need a manual dispose.
 *
 * Safe to call on a partially-built set.
 *
 * @param {ReturnType<typeof buildMaterialSet>|null|undefined} matSet
 */
export function disposeMaterialSet(matSet) {
  if (!matSet) return;
  if (matSet.terrain?.dispose) matSet.terrain.dispose();
}

/**
 * Recolour a cloned GLB for one planet. Every mesh ends up with its own
 * geometry copy carrying a `color` attribute, and one neutral vertex-colour
 * Lambert material:
 *
 *   - Meshes with AUTHORED colours (COLOR_0 from the import bake, or real
 *     material colours; see AuthoredColor.js) keep them, graded toward the
 *     planet palette: the asset's mean colour is re-centred on the biome
 *     (gradeCentre) and each part keeps its offset from that mean. Trunks
 *     stay darker than leaves; roofs stay different from walls.
 *   - Meshes with no authored colour get the old flat family colour, written
 *     into the same attribute. Family comes from (in order):
 *       1. mesh.userData.matSlot — author-tagged at build time
 *       2. the material name ("rock_01", "BirchTree_Bark" → rock, wood)
 *       3. assetMeta.family — the catalog's per-asset family
 *       4. 'default'
 *
 * Because every mesh is vertex-coloured the same way, a multi-part asset
 * merges into ONE instanced draw call (Features.extractMergedGeometry).
 *
 * A matSlot of 'hero' opts out entirely (the GLB's own materials are kept).
 *
 * `root.userData.authoredColor` ({ authored, mean }) is set by
 * AssetCache.loadInstance; without it the asset is treated as unauthored.
 *
 * @param {THREE.Object3D} root
 * @param {ReturnType<typeof buildMaterialSet>} matSet
 * @param {{ family?: string, assetId?: string }} [assetMeta]
 */
export function applyMaterialSet(root, matSet, assetMeta = {}) {
  const assetFamily = assetMeta.family || null;
  const assetId = assetMeta.assetId || '';
  const biome = matSet.biome;
  const accent = matSet.accent;
  const info = root.userData?.authoredColor;
  const authoredAsset = GRADE.enabled && !!info?.authored;
  // One centre for the whole asset, so every part is shifted the same way
  // and their differences survive.
  const centre = authoredAsset
    ? gradeCentre({ family: assetFamily || 'default', biome, biomeAccentHex: accent, assetId, mean: info.mean })
    : null;

  root.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const slot = o.userData?.matSlot
      ?? (o.material?.name?.split(/[_\s-]/)?.[0] || null);
    if (slot === 'hero' || matSet.hero === null && slot === 'hero') return; // opt-out
    if (slot === 'terrain') return; // shouldn't occur on a loaded GLB

    const src = o.geometry;
    const authored = authoredAsset ? src.userData?.authoredColors : null;
    const n = src.attributes.position.count;

    let colors;
    if (authored && authored.length === n * 3) {
      colors = gradeColors(authored, { mean: info.mean, centre, contrast: GRADE.contrast });
    } else {
      // Family preference: explicit author tag → a family named in the
      // material → per-asset family → fallback.
      const family = (slot && isKnownFamily(slot) ? slot : null)
        || familyFromName(o.material?.name)
        || assetFamily || 'default';
      const [r, g, b] = hexToLinear(resolveColor({ family, biome, biomeAccentHex: accent, assetId }));
      colors = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b; }
    }

    // Per-planet geometry copy that owns its colour buffer. The cached
    // source geometry is shared by every planet and must stay untouched.
    const geom = src.clone();
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    o.geometry = geom;

    const m = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true, vertexColors: true });
    m.userData.cloned = true;
    m.userData.vertexColored = true;
    o.material = m;
  });
}

// Known families recognized when reading slot strings. Mirrors the keys
// in ColorSystem.FAMILY_BASE so a `rock_*` material name routes correctly.
const _KNOWN_FAMILIES = new Set([
  'rock', 'stone', 'sand', 'flora', 'wood', 'metal', 'bone', 'crystal', 'structure',
]);
function isKnownFamily(s) { return _KNOWN_FAMILIES.has(s); }

// Part families named anywhere in a material name ("BirchTree_Bark",
// "Pine_Leaves"). Only consulted for meshes with no authored colour, so an
// uncoloured tree still gets a trunk that differs from its canopy.
const _NAME_FAMILIES = [
  [/bark|trunk|wood|log|stump|branch|plank/i, 'wood'],
  [/leaf|leaves|foliage|needle|frond|grass|bush|flower|petal|plant|moss|vine/i, 'flora'],
  [/rock|stone|cliff|boulder|pebble/i, 'rock'],
  [/metal|steel|iron/i, 'metal'],
  [/bone|skull/i, 'bone'],
  [/crystal|gem/i, 'crystal'],
  [/sand|dirt|soil|mud/i, 'sand'],
];
export function familyFromName(name) {
  if (!name) return null;
  for (const [re, family] of _NAME_FAMILIES) if (re.test(name)) return family;
  return null;
}
