// Single per-planet material source. Derives a set of slotted materials from
// the planet's palette so terrain, rocks, flora, landmarks, and hero assets
// all read as one cohesive place even when the underlying meshes come from
// different creators (Quaternius, Kenney, KayKit, etc).
//
// The cohesion principle (see Astroneer / No Man's Sky): vary VALUE and
// SATURATION more than HUE within a single planet. Flora gets a contrasting
// hue slot; rocks get a desaturated/darker terrain; landmarks get the accent.

import * as THREE from 'three';

// Multiply each RGB channel by a scalar without mutating the source color.
function shaded(hex, factor) {
  const c = new THREE.Color(hex);
  c.multiplyScalar(factor);
  return c;
}

/**
 * Build a per-planet MaterialSet from the LLM/seed-derived palette.
 *
 * @param {{ water:string, low:string, mid:string, high:string, snow:string, sky:string }} palette
 * @returns {{
 *   terrain:  THREE.MeshLambertMaterial,
 *   rock:     THREE.MeshLambertMaterial,
 *   flora:    THREE.MeshLambertMaterial,
 *   landmark: THREE.MeshLambertMaterial,
 *   hero:     null,                       // sentinel: keep GLB's original PBR
 *   default:  THREE.MeshLambertMaterial,
 *   sky:      string,                     // hex; consumed by Atmosphere shader
 *   palette:  object                      // pass-through for downstream code
 * }}
 */
export function buildMaterialSet(palette) {
  const flat = true;
  return {
    // Terrain uses vertex colors (already banded by elevation in TerrainGen);
    // material color stays white so VC isn't tinted.
    terrain:  new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: flat }),
    // Rocks read as "darker terrain" — same family, lower value.
    rock:     new THREE.MeshLambertMaterial({ color: shaded(palette.high, 0.9), flatShading: flat }),
    // Flora gets a distinct hue slot — the palette's "low" band is usually the
    // contrasting choice (greens/blues against terrain warms, etc).
    flora:    new THREE.MeshLambertMaterial({ color: shaded(palette.low, 0.85), flatShading: flat }),
    // Landmarks get the accent — pop against terrain, but still palette-bound.
    landmark: new THREE.MeshLambertMaterial({ color: new THREE.Color(palette.snow), flatShading: flat }),
    // Hero opts out — keep the GLB's hand-crafted PBR. Tied into biome via
    // the global post-process LUT (Phase 7) rather than direct override.
    hero:     null,
    // Catch-all for assets with unknown matSlot tag.
    default:  new THREE.MeshLambertMaterial({ color: shaded(palette.mid, 1.0), flatShading: flat }),
    sky:      palette.sky,
    palette,
  };
}

/**
 * Override every Mesh material in a GLB scene with the corresponding entry
 * from the MaterialSet, preserving baked vertex colors and falling back to
 * the matSlot tag's default when an unknown slot is present.
 *
 * - mesh.userData.matSlot wins when present (set at build time via
 *   gltf-transform from Blender custom properties).
 * - Otherwise the material's name prefix (e.g. "rock_01" → "rock") is used.
 * - matSet.hero === null means "keep original material" — opt out.
 *
 * @param {THREE.Object3D} root
 * @param {ReturnType<typeof buildMaterialSet>} matSet
 */
export function applyMaterialSet(root, matSet) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const slot =
      o.userData?.matSlot
      ?? (o.material?.name?.split(/[_\s-]/)?.[0] || null)
      ?? 'default';
    const base = matSet[slot];
    if (base === null) return;             // hero opt-out
    const template = base ?? matSet.default;
    const hasVC = !!o.geometry?.attributes?.color;
    // Clone so per-planet edits (vertexColors flag, color) don't leak.
    const m = template.clone();
    m.vertexColors = hasVC;
    if (hasVC) m.color.setHex(0xffffff);    // multiplier-neutral; let VC drive
    // Keep the GLB's baked texture (if any) when the override has none.
    if (o.material?.map && !m.map) m.map = o.material.map;
    // Tag so disposal logic can identify cloned-per-planet materials.
    m.userData.cloned = true;
    o.material = m;
  });
}
