import * as THREE from 'three';
import { mulberry32 } from './Seed.js';
import { axisUpQuaternionFor, groundOffsetFor } from './AxisUp.js';

// Pick 3..6 hero landmark slots from the terrain mesh.
//
// Slot kinds (matching the LLM pick schema's landmark_a/b/c targets):
//   - peak:   high-elevation prominence; common
//   - spire:  rare top-elevation outlier (only one per planet, the highest)
//   - basin:  enclosed low-elevation land (above sea level, below midlands)
//   - coast:  vertex just above sea level (read as shoreline)
//
// We aggregate candidates across all four bands, then run a single
// greedy angular-spread pass so the picks visually frame the planet
// rather than clustering. Spire takes priority within the high band so
// the "tallest thing on the planet" always gets the spire kind even if
// nearby peaks would otherwise crowd it out.

// Elevation thresholds — `elevations` is normalized [0..1] in TerrainGen
// with seaLevel = 0.42.
const COAST_LO = 0.42;
const COAST_HI = 0.46;
const BASIN_LO = 0.46;
const BASIN_HI = 0.55;
const PEAK_LO  = 0.78;
const SPIRE_LO = 0.90;

// Greedy angular-spread filter. ~70° apart between any two slots.
const MIN_ANGULAR_DOT = 0.35;

export function pickLandmarkSlots({ geometry, elevations, radius, seed, count = 5 }) {
  const pos = geometry.attributes.position;
  const vCount = pos.count;
  const rand = mulberry32(seed ^ 0xdeadbeef);

  // ── Gather banded candidates ──────────────────────────────────────
  const peakCandidates = [];   // { idx, e }
  const spireCandidates = [];
  const basinCandidates = [];
  const coastCandidates = [];

  for (let i = 0; i < vCount; i++) {
    const e = elevations[i];
    if (e >= SPIRE_LO) spireCandidates.push({ idx: i, e });
    else if (e >= PEAK_LO) peakCandidates.push({ idx: i, e });
    else if (e >= BASIN_LO && e < BASIN_HI) basinCandidates.push({ idx: i, e });
    else if (e >= COAST_LO && e < COAST_HI) coastCandidates.push({ idx: i, e });
  }

  // Shuffle peaks/basins/coasts so we don't always pick the first one
  // in vertex-index order. Spires we keep sorted descending so the
  // tallest wins.
  shuffleInPlace(peakCandidates, rand);
  shuffleInPlace(basinCandidates, rand);
  shuffleInPlace(coastCandidates, rand);
  spireCandidates.sort((a, b) => b.e - a.e);

  // ── Priority order: spire → peaks → basins → coasts ───────────────
  // Spire first so the highest point always gets the rare kind even if
  // nearby peaks would crowd it. Peaks are the bread-and-butter, the
  // greedy filter naturally limits crowding. Basin + coast round out
  // the lower-elevation slots.
  const picks = [];
  const dirs = [];
  const tmp = new THREE.Vector3();

  const tryAdd = (idx, kind, elevationFactor) => {
    if (picks.length >= count) return false;
    tmp.fromBufferAttribute(pos, idx).normalize();
    for (const d of dirs) {
      if (tmp.dot(d) > MIN_ANGULAR_DOT) return false;
    }
    const dir = tmp.clone();
    dirs.push(dir);
    const slotId = picks.length;
    picks.push({
      slotId,
      kind,
      direction: dir,
      position: dir.clone().multiplyScalar(radius * elevationFactor),
      name: `${capitalize(kind)}-${slotId + 1}`,
    });
    return true;
  };

  // Spire — at most one. Slightly higher mount factor reads as "pokes out further."
  if (spireCandidates[0]) tryAdd(spireCandidates[0].idx, 'spire', 1.10);

  // Peaks — fill up to ~half of count.
  const peakBudget = Math.max(2, Math.ceil(count * 0.55));
  let peakAdds = 0;
  for (const c of peakCandidates) {
    if (peakAdds >= peakBudget) break;
    if (tryAdd(c.idx, 'peak', 1.08)) peakAdds++;
  }

  // Basin — at most one.
  for (const c of basinCandidates) {
    if (tryAdd(c.idx, 'basin', 1.02)) break;
  }

  // Coast — at most one. Mount near surface (slightly above water).
  for (const c of coastCandidates) {
    if (tryAdd(c.idx, 'coast', 1.01)) break;
  }

  // ── Ensure minimum 3 slots ────────────────────────────────────────
  // If banding+spread didn't yield ≥3, relax angular constraint and try
  // peaks again, then basins, then coasts. With pathologically smooth
  // terrain we may still come up short; the caller copes by reusing a
  // procedural marker (see Planet.applyVisuals fallback).
  if (picks.length < 3) {
    const relaxed = 0.65; // ~50° apart, more permissive
    const tryAddRelaxed = (idx, kind, factor) => {
      if (picks.length >= 3) return false;
      tmp.fromBufferAttribute(pos, idx).normalize();
      for (const d of dirs) {
        if (tmp.dot(d) > relaxed) return false;
      }
      const dir = tmp.clone();
      dirs.push(dir);
      const slotId = picks.length;
      picks.push({
        slotId,
        kind,
        direction: dir,
        position: dir.clone().multiplyScalar(radius * factor),
        name: `${capitalize(kind)}-${slotId + 1}`,
      });
      return true;
    };
    for (const c of peakCandidates) tryAddRelaxed(c.idx, 'peak', 1.08);
    for (const c of basinCandidates) tryAddRelaxed(c.idx, 'basin', 1.02);
    for (const c of coastCandidates) tryAddRelaxed(c.idx, 'coast', 1.01);
  }

  return picks;
}

function shuffleInPlace(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Build hero marker meshes for picked landmarks. Each gets a small low-poly
// shape that pokes out of the surface, so the player can visually identify
// them. This is the procedural fallback used when no GLB selection landed
// for the slot (empty catalog, GLB load failure, etc).
export function buildLandmarkMeshes(landmarks, palette) {
  const group = new THREE.Group();
  for (const lm of landmarks) {
    const mesh = buildProceduralLandmarkMesh(lm, palette);
    if (mesh) {
      mesh.userData.slotId = lm.slotId;
      mesh.userData.kind = lm.kind;
      group.add(mesh);
    }
  }
  return group;
}

function buildProceduralLandmarkMesh(lm, palette) {
  const up = lm.direction.clone();
  const yToUp = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);

  if (lm.kind === 'peak') {
    const g = new THREE.ConeGeometry(2.0, 12.0, 5);
    const m = new THREE.MeshLambertMaterial({ color: new THREE.Color(palette.snow).multiplyScalar(0.95), flatShading: true });
    const mesh = new THREE.Mesh(g, m);
    mesh.position.copy(lm.position);
    mesh.quaternion.copy(yToUp);
    return mesh;
  }
  if (lm.kind === 'spire') {
    // Taller + thinner than a peak so the "rarest, tallest" reads from a distance.
    const g = new THREE.ConeGeometry(1.5, 22.0, 5);
    const m = new THREE.MeshLambertMaterial({ color: new THREE.Color(palette.snow), flatShading: true });
    const mesh = new THREE.Mesh(g, m);
    mesh.position.copy(lm.position);
    mesh.quaternion.copy(yToUp);
    return mesh;
  }
  if (lm.kind === 'basin') {
    const g = new THREE.TorusGeometry(4.5, 0.5, 6, 16);
    const m = new THREE.MeshLambertMaterial({ color: new THREE.Color(palette.high).multiplyScalar(1.1), flatShading: true });
    const mesh = new THREE.Mesh(g, m);
    mesh.position.copy(lm.position);
    // Torus's default plane is XY, so rotate so its normal aligns with up.
    const zToUp = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), up);
    mesh.quaternion.copy(zToUp);
    return mesh;
  }
  if (lm.kind === 'coast') {
    // Low cairn — short stack that reads as a shoreline marker.
    const g = new THREE.CylinderGeometry(1.4, 1.8, 2.4, 6);
    const m = new THREE.MeshLambertMaterial({ color: new THREE.Color(palette.mid).multiplyScalar(1.05), flatShading: true });
    const mesh = new THREE.Mesh(g, m);
    mesh.position.copy(lm.position);
    mesh.quaternion.copy(yToUp);
    return mesh;
  }
  return null;
}

/**
 * Bind a single GLB clone to a landmark slot. Scales it to the asset's
 * declared `scale_range` (deterministic per-slot via the planet seed),
 * applies the per-pack axis-up correction if any, orients its +Y to the
 * slot's surface-up direction, and ground-snaps using the clone's bbox
 * so the visible base touches terrain instead of the origin floating
 * above.
 *
 * The clone is mutated in place (position, scale, quaternion) and returned
 * so the caller can add it to the planet group.
 *
 * @param {object} args
 * @param {object} args.slot                    - from pickLandmarkSlots
 * @param {THREE.Object3D} args.gltfClone       - clone from AssetCache.loadInstance (userData.bbox carried)
 * @param {[number, number]} [args.scaleRange]  - min/max meters; default [4,8]
 * @param {string} [args.pack]                  - catalog pack id for axis-up override
 * @param {number} args.seed                    - planet seed for deterministic per-slot scale
 * @returns {THREE.Object3D} the same clone, now positioned + scaled
 */
export function buildLandmarkInstance({ slot, gltfClone, scaleRange = [4, 8], pack = null, seed }) {
  const [minS, maxS] = scaleRange;
  // Deterministic per-slot scale so repeat visits to the same planet pick
  // the same scale (no LLM call needed to re-derive).
  const rand = mulberry32((seed ^ 0xC0DE) >>> 0 ^ (slot.slotId * 73856093 >>> 0));
  const scale = minS + (maxS - minS) * rand();

  // Compose: axisUp (asset-local fix) → surfaceUp (slot orientation) → twist.
  // Multiplications apply right-to-left, so we want quaternion = twist * surface * axisUp.
  const axisUp = axisUpQuaternionFor(pack);
  const surfaceUp = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), slot.direction);
  const twist = new THREE.Quaternion().setFromAxisAngle(slot.direction, rand() * Math.PI * 2);
  gltfClone.quaternion.copy(twist).multiply(surfaceUp).multiply(axisUp);
  gltfClone.scale.setScalar(scale);

  // Ground-snap: push the asset outward along surface normal by the
  // distance from origin to the bbox's "down" extent (scaled). Without
  // this the origin sits on the surface point but a model whose origin
  // is at center floats by half its height.
  const groundOffset = groundOffsetFor(gltfClone.userData?.bbox, pack) * scale;
  gltfClone.position.copy(slot.position).addScaledVector(slot.direction, groundOffset);

  gltfClone.userData.slotId = slot.slotId;
  gltfClone.userData.kind = slot.kind;
  return gltfClone;
}
