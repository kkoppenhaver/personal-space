// Arrangement motifs (Phase 14b) — the placement engine's expressive
// vocabulary. The concept call picks a motif by name; these helpers turn
// it into transforms. Two families:
//
//   ORIENTATION motifs modify how instances stand/face (uniform-lean,
//   all-facing-point, shared-heading). Placement stays cluster-driven.
//
//   LAYOUT motifs replace cluster sampling with generated positions
//   (grid-rows, procession).
//
// Everything is seeded and pure — same concept, same arrangement.

import * as THREE from 'three';
import { mulberry32 } from './Seed.js';

export const ORIENTATION_MOTIFS = new Set(['uniform-lean', 'all-facing-point', 'shared-heading']);
export const LAYOUT_MOTIFS = new Set(['grid-rows', 'procession']);

// How far uniform-lean tilts off plumb (~9°, the leaning-pines amount).
const LEAN_AMOUNT = 0.16;

/** Deterministic unit vector for a seed — the global lean/heading direction. */
export function seededDirection(seed) {
  const rand = mulberry32((seed ^ 0x3d1f) >>> 0);
  const theta = rand() * Math.PI * 2;
  const z = rand() * 2 - 1;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return new THREE.Vector3(r * Math.cos(theta), z, r * Math.sin(theta));
}

/**
 * Tilt an up-vector toward the global lean direction (uniform-lean).
 * Mutates and returns `up`.
 */
export function leanUp(up, leanDir) {
  return up.addScaledVector(leanDir, LEAN_AMOUNT).normalize();
}

/**
 * The twist angle (radians, around `up`) that turns an instance's default
 * forward toward `targetDir` — used by all-facing-point (target = the hero
 * slot) and shared-heading (target = one global direction for the group).
 *
 * The instance's default forward after the surface-up rotation is local +Z
 * carried through quat(Y→up); the desired forward is `targetDir` projected
 * onto the tangent plane of `up`. Returns 0 when the target is degenerate
 * (directly above/below).
 */
const _q = new THREE.Quaternion();
const _f0 = new THREE.Vector3();
const _d = new THREE.Vector3();
const _c = new THREE.Vector3();
const _Y = new THREE.Vector3(0, 1, 0);
const _Z = new THREE.Vector3(0, 0, 1);
export function twistToFace(up, targetDir) {
  _d.copy(targetDir).addScaledVector(up, -targetDir.dot(up));
  if (_d.lengthSq() < 1e-8) return 0;
  _d.normalize();
  _q.setFromUnitVectors(_Y, up);
  _f0.copy(_Z).applyQuaternion(_q);
  _c.crossVectors(_f0, _d);
  return Math.atan2(_c.dot(up), _f0.dot(_d));
}

/**
 * grid-rows: planted-in-measured-lines positions around an anchor
 * direction. Returns direction-space entries `{ dir, along }` (`along` =
 * the row axis tangent at that point, for orientation). The caller
 * resolves heights via the terrain sampler and applies its own water
 * policy (the drowned-orchard rows are allowed to walk into the sea).
 *
 * @param {object} args
 * @param {THREE.Vector3} args.anchorDir - unit; grid center
 * @param {number} args.radius           - planet radius (world units)
 * @param {number} args.count            - target member count
 * @param {number} args.seed
 * @param {number} [args.rowGap=4]       - world units between rows
 * @param {number} [args.memberGap=2.6]  - world units along a row
 */
export function gridRowPositions({ anchorDir, radius, count, seed, rowGap = 4, memberGap = 2.6 }) {
  const rand = mulberry32((seed ^ 0x960c) >>> 0);
  const [t1, t2] = tangentBasis(anchorDir, rand() * Math.PI * 2);
  const rows = Math.max(2, Math.round(Math.sqrt(count / 2)));
  const cols = Math.ceil(count / rows);
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let cIdx = 0; cIdx < cols && out.length < count; cIdx++) {
      const x = (cIdx - (cols - 1) / 2) * memberGap;
      const y = (r - (rows - 1) / 2) * rowGap;
      const dir = anchorDir.clone().multiplyScalar(radius)
        .addScaledVector(t1, x)
        .addScaledVector(t2, y)
        .normalize();
      out.push({ dir, along: t1.clone() });
    }
  }
  return out;
}

/**
 * procession: two parallel lines of instances along the great-circle arc
 * from `fromDir` to `toDir` (the lowlands up to the crypt door). Returns
 * `{ dir, along }` entries; `along` is the path tangent so members can
 * face down the line.
 *
 * @param {object} args
 * @param {THREE.Vector3} args.fromDir
 * @param {THREE.Vector3} args.toDir
 * @param {number} args.radius
 * @param {number} args.count          - total across both lanes
 * @param {number} [args.laneOffset=2] - world units off the centerline
 * @param {number} [args.memberGap=3]  - world units between members
 */
export function processionPositions({ fromDir, toDir, radius, count, laneOffset = 2, memberGap = 3 }) {
  const angle = fromDir.angleTo(toDir);
  if (angle < 1e-3) return [];
  const arcLength = angle * radius;
  const perLane = Math.max(2, Math.min(Math.floor(count / 2), Math.floor(arcLength / memberGap)));
  const out = [];
  const a = new THREE.Vector3();
  for (let lane = -1; lane <= 1; lane += 2) {
    for (let i = 0; i < perLane; i++) {
      // Margins keep the lines clear of both endpoints' landmark bases.
      const t = 0.12 + 0.76 * (i / (perLane - 1));
      a.copy(fromDir).lerp(toDir, t).normalize();
      // Path tangent + perpendicular (in the tangent plane at this point).
      const along = toDir.clone().addScaledVector(a, -toDir.dot(a)).normalize();
      const side = new THREE.Vector3().crossVectors(a, along).normalize();
      const dir = a.multiplyScalar(radius).addScaledVector(side, lane * laneOffset).normalize();
      out.push({ dir: dir.clone(), along: along.clone() });
    }
  }
  return out;
}

/** Orthonormal tangent basis at `dir`, rotated by `spin` around it. */
function tangentBasis(dir, spin) {
  const ref = Math.abs(dir.y) < 0.95 ? _Y : _Z;
  const t1 = new THREE.Vector3().crossVectors(dir, ref).normalize();
  const t2 = new THREE.Vector3().crossVectors(dir, t1).normalize();
  const q = new THREE.Quaternion().setFromAxisAngle(dir, spin);
  return [t1.applyQuaternion(q), t2.applyQuaternion(q)];
}
