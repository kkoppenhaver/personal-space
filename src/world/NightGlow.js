// Which parts of a model light up at night (roadmap 1b, night side).
//
// Bundled models are baked to one vertex-coloured primitive (Phase 1a): no
// textures, no UVs, no part names at runtime. So the lit parts are found
// from what the model still carries, once per mounted clone:
//
//   role      from the catalog id and family:
//               building  houses, towers, hangars, mills, landers, crypts
//               lamp      lamp posts, lanterns, torches, "lights"
//               crystal   crystal rocks
//   windows   (buildings) the model's own window panes where it has them:
//             dark, near-neutral parts well below the model's mean
//             brightness (Kenney castle and pirate towers model their panes
//             this way). Models without panes (most kits paint the walls
//             one colour) get a procedural grid of windows on their walls,
//             drawn in the shader (NightLights.js). `mode` says which.
//   bulbs     (lamps) the warm, bright, saturated parts: the glass of a
//             lamp post, the bulbs of a light mast, a light-tree's fruit.
//
// The result is a per-vertex `nightMask` attribute (x = window pane,
// y = bulb / crystal) plus `material.userData.night` (role, mode, the bulb
// centroid in the mesh's space) for NightLights to patch the material and
// place pools of light. Pure functions below are unit-tested.

import * as THREE from 'three';

// Ids are `pack:kit:name`. Buildings: something you could live or work in.
// Ships are left out on purpose (their sails are vertical walls too), and so
// are landers and vehicles: legs and tanks are not walls.
const BUILDING_RE = /house|tower|hangar|watermill|windmill|(^|:)structure(_detailed)?$|cabin|hut\b|cottage|church|chapel|tavern|inn\b|barn|shop|castle|keep|fort\b|building|habitat|station|lighthouse|crypt/i;
// Pieces of a building kit that are not themselves inhabited.
const NOT_BUILDING_RE = /terrain_|platform|fountain|pillar|column|statue|road|ramp|chimney|gate|arch|wall|debris|-door$/i;
// Crypts have a door but no windows: panes only, never the procedural grid.
const PANES_ONLY_RE = /crypt/i;
const LAMP_RE = /lamp|lantern|lightpost|torch|candle|brazier|campfire|bonfire|beacon|(^|[:_-])lights?($|[_-])|tree_light/i;

/**
 * @param {{ assetId?: string, family?: string }} meta
 * @returns {'building'|'lamp'|'crystal'|null}
 */
export function nightRoleFor(meta = {}) {
  const id = meta.assetId || '';
  if (LAMP_RE.test(id)) return 'lamp';
  if (meta.family === 'crystal' || /crystal/i.test(id)) return 'crystal';
  if (BUILDING_RE.test(id) && !NOT_BUILDING_RE.test(id)) return 'building';
  return null;
}

/** Linear RGB → sRGB (0..1) for one channel. */
const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055);
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Window-pane test for one vertex colour (linear RGB) against the model's
 * mean luminance (linear). Panes are dark and close to grey.
 */
export function isPane(r, g, b, meanLuma) {
  const y = luma(r, g, b);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const sat = mx > 1e-4 ? (mx - mn) / mx : 0;
  return y < meanLuma * 0.3 && sat < 0.45;
}

/** Bulb test for one vertex colour (linear RGB): warm, bright, saturated. */
export function isBulb(r, g, b) {
  const R = toSrgb(r), G = toSrgb(g), B = toSrgb(b);
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
  if (mx < 0.6) return false;
  const s = (mx - mn) / mx;
  if (s < 0.45) return false;
  let h;
  const d = mx - mn || 1;
  if (mx === R) h = 60 * (((G - B) / d) % 6);
  else if (mx === G) h = 60 * ((B - R) / d + 2);
  else h = 60 * ((R - G) / d + 4);
  if (h < 0) h += 360;
  return h >= 20 && h <= 70;
}

/**
 * Per-vertex masks for one model.
 *
 * @param {Array<{ colors: Float32Array|null, count: number, areas?: Float32Array }>} parts
 *   authored linear colours per mesh (null = none)
 * @param {'building'|'lamp'|'crystal'} role
 * @returns {{ masks: Float32Array[], mode: 'panes'|'grid'|null, paneShare: number, bulbShare: number }}
 */
export function computeNightMasks(parts, role) {
  // Mean luminance over every authored vertex (unweighted is close enough:
  // the bake welds vertices, so counts follow surface detail, not area).
  let sum = 0, n = 0;
  for (const p of parts) {
    if (!p.colors) continue;
    for (let i = 0; i < p.count; i++) { sum += luma(p.colors[i * 3], p.colors[i * 3 + 1], p.colors[i * 3 + 2]); n++; }
  }
  const meanLuma = n ? sum / n : 0;
  let panes = 0, bulbs = 0, total = 0;
  const masks = parts.map((p) => {
    const m = new Float32Array(p.count * 2);
    total += p.count;
    if (!p.colors) return m;
    for (let i = 0; i < p.count; i++) {
      const r = p.colors[i * 3], g = p.colors[i * 3 + 1], b = p.colors[i * 3 + 2];
      if (role === 'building' && isPane(r, g, b, meanLuma)) { m[i * 2] = 1; panes++; }
      if (role === 'lamp' && isBulb(r, g, b)) { m[i * 2 + 1] = 1; bulbs++; }
      if (role === 'crystal') m[i * 2 + 1] = 1;
    }
    return m;
  });
  const paneShare = total ? panes / total : 0;
  const bulbShare = total ? bulbs / total : 0;
  let mode = null;
  if (role === 'building') {
    // Real panes when the model has a few dark parts (2-15% of it: not
    // none, and not a dark model where "dark" is its legs and trim).
    // Otherwise windows are drawn.
    mode = paneShare >= 0.02 && paneShare <= 0.15 && meanLuma > 0.12 ? 'panes' : 'grid';
  }
  return { masks, mode, paneShare, bulbShare };
}

/**
 * Tag a freshly recoloured model clone (AssetCache.loadInstance, after
 * applyMaterialSet) with its night masks. No-op for models that have no
 * night role. Each mesh gets its own geometry and material from
 * applyMaterialSet, so writing to them is safe.
 *
 * @param {THREE.Object3D} root
 * @param {{ assetId?: string, family?: string }} meta
 */
export function prepareNightGlow(root, meta = {}) {
  const role = nightRoleFor(meta);
  if (!role) return null;
  const meshes = [];
  root.traverse((o) => { if (o.isMesh && o.geometry?.attributes?.position && o.material && !Array.isArray(o.material)) meshes.push(o); });
  if (!meshes.length) return null;
  const parts = meshes.map((o) => ({
    colors: o.geometry.userData?.authoredColors || null,
    count: o.geometry.attributes.position.count,
  }));
  const { masks, mode, paneShare, bulbShare } = computeNightMasks(parts, role);
  let panesOnly = PANES_ONLY_RE.test(meta.assetId || '');
  const finalMode = panesOnly && mode === 'grid' ? 'none' : mode;

  // Bulb centroid in the root's space (lamps): where the halo and the pool
  // go. Falls back to the top of the model when no part reads as a bulb.
  root.updateMatrixWorld(true);
  const bulb = new THREE.Vector3();
  let bulbN = 0;
  const v = new THREE.Vector3();
  const box = new THREE.Box3();
  meshes.forEach((o, k) => {
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      box.expandByPoint(v);
      if (role === 'lamp' && masks[k][i * 2 + 1] > 0) { bulb.add(v); bulbN++; }
    }
  });
  if (bulbN) bulb.multiplyScalar(1 / bulbN);
  else bulb.set((box.min.x + box.max.x) / 2, box.min.y + (box.max.y - box.min.y) * 0.9, (box.min.z + box.max.z) / 2);

  const info = {
    role,
    mode: role === 'building' ? finalMode : null,
    paneShare, bulbShare,
    bulb,                         // root space
    box,                          // root space
  };
  meshes.forEach((o, k) => {
    o.geometry.setAttribute('nightMask', new THREE.BufferAttribute(masks[k], 2));
    o.material.userData.night = info;
  });
  root.userData.night = info;
  return info;
}
