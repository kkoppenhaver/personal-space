// Per-pack + per-asset axis-up override. Most GLBs we ship are Y-up (GLTF
// spec default), but some kits are authored Z-up and convert through
// gltf-transform without a rotation — so they need a one-time
// X(-π/2) correction at mount time to read upright on a Y-up scene.
//
// Two override levels, asset wins over pack:
//   - PACK_AXIS_UP below: every asset in the pack applies the rotation.
//   - `axis_override: 'Z'` on a catalog asset record: stragglers inside an
//     otherwise-correct pack (kit re-exports are inconsistent).
//
// To populate: open `?contactSheet=1`, eyeball the grid (RAW toggle shows
// the authored orientation), mark Z-up cells, and copy the marks into
// PACK_AXIS_UP (whole pack affected) or catalog.source.json (one-offs).

import * as THREE from 'three';

/**
 * Pack ids → axis convention. Default Y-up; only list non-default
 * exceptions. The `pack` value matches the `pack` field on each
 * catalog asset (see `catalog.source.json`).
 */
const PACK_AXIS_UP = {
  // AUDITED 2026-06-10 via ?contactSheet=1: all 13 bundled packs (kenney_*,
  // quaternius_*, kaykit_*) are Y-up — this map is correctly empty. The
  // float/tilt bugs observed in prod were vertical-offset origins
  // (kenney_space authors models ABOVE the origin) and corner pivots
  // (kenney_space, kenney_nature cliffs) — both handled systematically by
  // the signed ground offset + lateral recenter below, not by this map.
  // Keep auditing new packs (Phase 12b creatures!) before they ship.
  // e.g. 'some_future_pack': 'Z',
};

/** Resolve the effective up-axis for an asset: asset override > pack > 'Y'. */
function axisFor(pack, assetMeta = null) {
  return assetMeta?.axis_override || PACK_AXIS_UP[pack] || 'Y';
}

/**
 * Return the cached quaternion that rotates a clone of an asset in `pack`
 * into the Y-up convention. Identity for unlisted packs (Y-up assumed).
 *
 * @param {string|null} pack
 * @param {{ axis_override?: string }|null} [assetMeta] - catalog record; its
 *   `axis_override` beats the pack-level entry.
 */
const _cache = new Map();
export function axisUpQuaternionFor(pack, assetMeta = null) {
  const axis = axisFor(pack, assetMeta);
  if (_cache.has(axis)) return _cache.get(axis);
  let q;
  if (axis === 'Z') {
    // Z-up → Y-up: rotate the asset −π/2 about X so its +Z lands on +Y.
    q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  } else {
    q = new THREE.Quaternion(); // identity
  }
  _cache.set(axis, q);
  return q;
}

/**
 * Given a local-frame bbox (THREE.Box3) and the asset's source axis,
 * return the SIGNED distance to move the asset along the surface normal
 * so its visible base touches terrain.
 *
 * Bbox is computed in the GLB's local frame before any axis-up rotation
 * has been applied — so for a Y-up source we want -bbox.min.y, for a
 * Z-up source -bbox.min.z. The axis-up rotation later realigns either
 * "down" axis to world -Y, which becomes the surface-inward direction.
 *
 * Signed on purpose: a model authored with its base ABOVE the origin
 * (`min > 0` — all of kenney_space) needs to be pulled DOWN. The old
 * `Math.max(0, -min)` clamp could only push up, which is exactly why
 * that kit floated in prod.
 */
export function groundOffsetFor(bbox, pack, assetMeta = null) {
  if (!bbox) return 0;
  const axis = axisFor(pack, assetMeta);
  const min = (axis === 'Z') ? bbox.min.z : bbox.min.y;
  return -min;
}

/**
 * Bbox extent along the asset's effective up axis (post-correction height).
 * Used for embed-factor grounding and bbox-normalized scaling.
 */
export function bboxHeightFor(bbox, pack, assetMeta = null) {
  if (!bbox) return 0;
  const axis = axisFor(pack, assetMeta);
  return (axis === 'Z') ? (bbox.max.z - bbox.min.z) : (bbox.max.y - bbox.min.y);
}

/**
 * Local-frame translation that re-centers the asset's footprint on its
 * origin, so placement anchors (and twist rotation) go through the bbox
 * center instead of wherever the kit author left the pivot. Several kits
 * (kenney_space, kenney_nature cliffs) use corner pivots — without this,
 * a random twist swings the model around its corner and it lands offset
 * from its slot.
 *
 * Lateral only: the ground axis component is zero (vertical is the
 * ground offset's job). Expressed in the asset's pre-rotation local
 * frame; callers apply the instance quaternion before adding.
 */
export function lateralCenterFor(bbox, pack, assetMeta = null, out = null) {
  const v = out || new THREE.Vector3();
  if (!bbox) return v.set(0, 0, 0);
  const axis = axisFor(pack, assetMeta);
  const cx = (bbox.min.x + bbox.max.x) / 2;
  if (axis === 'Z') {
    const cy = (bbox.min.y + bbox.max.y) / 2;
    return v.set(-cx, -cy, 0);
  }
  const cz = (bbox.min.z + bbox.max.z) / 2;
  return v.set(-cx, 0, -cz);
}

/** Exposed for tests / debug overlays. */
export const _axisUpMap = PACK_AXIS_UP;
