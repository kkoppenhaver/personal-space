// Per-pack axis-up override. Most GLBs we ship are Y-up (GLTF spec
// default), but some kits are authored Z-up and convert through
// gltf-transform without a rotation — so they need a one-time
// X(-π/2) correction at mount time to read upright on a Y-up scene.
//
// This map is the single source of truth for those corrections. Adding
// an entry here makes every asset in that pack apply the rotation
// automatically; no per-asset metadata change needed.
//
// To populate: load an asset with `__GAME.debugPlacement = true`, look
// at the axis gizmo in scene, and add the pack id here if its "up"
// reads as forward/backward.

import * as THREE from 'three';

/**
 * Pack ids → axis convention. Default Y-up; only list non-default
 * exceptions. The `pack` value matches the `pack` field on each
 * catalog asset (see `catalog.source.json`).
 */
const PACK_AXIS_UP = {
  // (empty — populate as packs are identified)
  // e.g. 'quaternius_space': 'Z',
};

/**
 * Return the cached quaternion that rotates a clone of an asset in `pack`
 * into the Y-up convention. Identity for unlisted packs (Y-up assumed).
 */
const _cache = new Map();
export function axisUpQuaternionFor(pack) {
  if (_cache.has(pack)) return _cache.get(pack);
  const axis = PACK_AXIS_UP[pack] || 'Y';
  let q;
  if (axis === 'Z') {
    // Z-up → Y-up: rotate the asset −π/2 about X so its +Z lands on +Y.
    q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  } else {
    q = new THREE.Quaternion(); // identity
  }
  _cache.set(pack, q);
  return q;
}

/**
 * Given a local-frame bbox (THREE.Box3) and the asset's source axis,
 * return the magnitude to push the asset outward along the surface
 * normal so its visible base touches terrain.
 *
 * Bbox is computed in the GLB's local frame before any axis-up rotation
 * has been applied — so for a Y-up source we want -bbox.min.y, for a
 * Z-up source -bbox.min.z. The axis-up rotation later realigns either
 * "down" axis to world -Y, which becomes the surface-inward direction.
 */
export function groundOffsetFor(bbox, pack) {
  if (!bbox) return 0;
  const axis = PACK_AXIS_UP[pack] || 'Y';
  const min = (axis === 'Z') ? bbox.min.z : bbox.min.y;
  // Negative bbox.min means origin is above the base — push outward by
  // that magnitude so the base touches terrain. Positive (origin below
  // the base) means the model's anchor is already below floor; clamp
  // to 0 to avoid sinking it further.
  return Math.max(0, -min);
}

/** Exposed for tests / debug overlays. */
export const _axisUpMap = PACK_AXIS_UP;
