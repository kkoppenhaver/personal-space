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
import { resolveColor, biomeFallbackAccent } from './ColorSystem.js';

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
 * Override every Mesh material in a GLB scene with a freshly-built
 * dual-axis-colored material. Family for the color comes from (in order):
 *   1. mesh.userData.matSlot — author-tagged at build time
 *   2. mesh.material.name prefix (e.g. "rock_01" → "rock")
 *   3. assetMeta.family — the catalog's per-asset family (covers most cases)
 *   4. 'default'
 *
 * A matSlot of 'hero' opts out entirely (the GLB's hand-crafted PBR is
 * preserved — landmark-cohesion responsibility for hero assets falls to
 * the future post-process LUT, not this pass).
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

  root.traverse((o) => {
    if (!o.isMesh) return;
    const slot = o.userData?.matSlot
      ?? (o.material?.name?.split(/[_\s-]/)?.[0] || null);
    if (slot === 'hero' || matSet.hero === null && slot === 'hero') return; // opt-out
    if (slot === 'terrain') return; // shouldn't occur on a loaded GLB

    // Family preference: explicit author tag → name prefix that matches a
    // family → per-asset family → fallback. Slot strings happen to align
    // with family names for the common cases (rock, flora, structure).
    const family = slot && isKnownFamily(slot) ? slot
                : (assetFamily || 'default');

    const hasVC = !!o.geometry?.attributes?.color;
    const colorHex = resolveColor({ family, biome, biomeAccentHex: accent, assetId });

    const m = new THREE.MeshLambertMaterial({
      color: colorHex,
      flatShading: true,
      vertexColors: hasVC,
    });
    if (hasVC) m.color.setHex(0xffffff);    // multiplier-neutral; let VC drive
    if (o.material?.map && !m.map) m.map = o.material.map;
    m.userData.cloned = true;
    o.material = m;
  });
}

// Known families recognized when reading slot strings. Mirrors the keys
// in ColorSystem.FAMILY_BASE so a `rock_*` material name routes correctly.
const _KNOWN_FAMILIES = new Set([
  'rock', 'stone', 'sand', 'flora', 'wood', 'metal', 'bone', 'crystal', 'structure',
]);
function isKnownFamily(s) { return _KNOWN_FAMILIES.has(s); }
