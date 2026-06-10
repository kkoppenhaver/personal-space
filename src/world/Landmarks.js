import * as THREE from 'three';
import { mulberry32 } from './Seed.js';
import { axisUpQuaternionFor, groundOffsetFor, bboxHeightFor, lateralCenterFor } from './AxisUp.js';
import { blendedUp, embedFractionFor } from './PlacementRules.js';

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

// Flatness preference: candidates are bucketed by slope (1 - dot(radial,
// terrain normal)) in steps of this size, and flatter buckets win. Within
// a bucket the shuffled order survives (Array#sort is stable), so equally
// flat candidates still vary per seed. Landmark slots host structures and
// hero GLBs — a knife-edge facet under a windmill reads as a glitch.
const SLOPE_BUCKET = 0.04;

export function pickLandmarkSlots({ geometry, elevations, radius, seed, count = 5 }) {
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  const vCount = pos.count;
  const rand = mulberry32(seed ^ 0xdeadbeef);

  // ── Gather banded candidates (with slope) ─────────────────────────
  const peakCandidates = [];   // { idx, e, slope }
  const spireCandidates = [];
  const basinCandidates = [];
  const coastCandidates = [];

  const tmpD = new THREE.Vector3();
  const tmpN = new THREE.Vector3();
  for (let i = 0; i < vCount; i++) {
    const e = elevations[i];
    let band = null;
    if (e >= SPIRE_LO) band = spireCandidates;
    else if (e >= PEAK_LO) band = peakCandidates;
    else if (e >= BASIN_LO && e < BASIN_HI) band = basinCandidates;
    else if (e >= COAST_LO && e < COAST_HI) band = coastCandidates;
    if (!band) continue;
    tmpD.fromBufferAttribute(pos, i).normalize();
    tmpN.fromBufferAttribute(nor, i).normalize();
    band.push({ idx: i, e, slope: 1 - tmpD.dot(tmpN) });
  }

  // Shuffle peaks/basins/coasts so we don't always pick the first one in
  // vertex-index order, then stable-sort by slope bucket so flat ground
  // is preferred but ties stay seed-varied. Spire candidates are all in
  // the top elevation band already, so preferring a flat crown among them
  // still reads as "the planet's highest point" — height breaks ties.
  const slopeBucketOf = (c) => Math.min(4, Math.floor(c.slope / SLOPE_BUCKET));
  for (const band of [peakCandidates, basinCandidates, coastCandidates]) {
    shuffleInPlace(band, rand);
    band.sort((a, b) => slopeBucketOf(a) - slopeBucketOf(b));
  }
  spireCandidates.sort((a, b) => (slopeBucketOf(a) - slopeBucketOf(b)) || (b.e - a.e));

  // ── Priority order: spire → peaks → basins → coasts ───────────────
  // Spire first so the highest point always gets the rare kind even if
  // nearby peaks would crowd it. Peaks are the bread-and-butter, the
  // greedy filter naturally limits crowding. Basin + coast round out
  // the lower-elevation slots.
  const picks = [];
  const dirs = [];
  const tmp = new THREE.Vector3();

  // Slot position is the ACTUAL displaced vertex — i.e. exactly on the
  // terrain. (It used to be `dir * radius * elevationFactor`, a band-level
  // approximation that floated peak mounts up to ~2% of radius above the
  // real surface; GLB ground-snap then inherited the error.) `normal` is
  // the smoothed vertex normal, used for per-family up-vector blending.
  const tryAdd = (idx, kind) => {
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
      normal: new THREE.Vector3().fromBufferAttribute(nor, idx).normalize(),
      position: new THREE.Vector3().fromBufferAttribute(pos, idx),
      name: `${capitalize(kind)}-${slotId + 1}`,
    });
    return true;
  };

  // Spire — at most one.
  if (spireCandidates[0]) tryAdd(spireCandidates[0].idx, 'spire');

  // Peaks — fill up to ~half of count.
  const peakBudget = Math.max(2, Math.ceil(count * 0.55));
  let peakAdds = 0;
  for (const c of peakCandidates) {
    if (peakAdds >= peakBudget) break;
    if (tryAdd(c.idx, 'peak')) peakAdds++;
  }

  // Basin — at most one.
  for (const c of basinCandidates) {
    if (tryAdd(c.idx, 'basin')) break;
  }

  // Coast — at most one.
  for (const c of coastCandidates) {
    if (tryAdd(c.idx, 'coast')) break;
  }

  // ── Ensure minimum 3 slots ────────────────────────────────────────
  // If banding+spread didn't yield ≥3, relax angular constraint and try
  // peaks again, then basins, then coasts. With pathologically smooth
  // terrain we may still come up short; the caller copes by reusing a
  // procedural marker (see Planet.applyVisuals fallback).
  if (picks.length < 3) {
    const relaxed = 0.65; // ~50° apart, more permissive
    const tryAddRelaxed = (idx, kind) => {
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
        normal: new THREE.Vector3().fromBufferAttribute(nor, idx).normalize(),
        position: new THREE.Vector3().fromBufferAttribute(pos, idx),
        name: `${capitalize(kind)}-${slotId + 1}`,
      });
      return true;
    };
    for (const c of peakCandidates) tryAddRelaxed(c.idx, 'peak');
    for (const c of basinCandidates) tryAddRelaxed(c.idx, 'basin');
    for (const c of coastCandidates) tryAddRelaxed(c.idx, 'coast');
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
  // Tag so the MaterialSet audit exempts these — procedural fallbacks build
  // their materials ad-hoc by design, they're not matSet-sourced.
  group.userData.procedural = true;
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

  // Slot positions sit exactly on the terrain (post-Phase-13a) and these
  // primitives have center origins — lift each by a bit under half its
  // height so it pokes out of the ground with its base embedded.

  if (lm.kind === 'peak') {
    const g = new THREE.ConeGeometry(2.0, 12.0, 5);
    const m = new THREE.MeshLambertMaterial({ color: new THREE.Color(palette.snow).multiplyScalar(0.95), flatShading: true });
    const mesh = new THREE.Mesh(g, m);
    mesh.position.copy(lm.position).addScaledVector(up, 5.0);
    mesh.quaternion.copy(yToUp);
    return mesh;
  }
  if (lm.kind === 'spire') {
    // Taller + thinner than a peak so the "rarest, tallest" reads from a distance.
    const g = new THREE.ConeGeometry(1.5, 22.0, 5);
    const m = new THREE.MeshLambertMaterial({ color: new THREE.Color(palette.snow), flatShading: true });
    const mesh = new THREE.Mesh(g, m);
    mesh.position.copy(lm.position).addScaledVector(up, 10.0);
    mesh.quaternion.copy(yToUp);
    return mesh;
  }
  if (lm.kind === 'basin') {
    const g = new THREE.TorusGeometry(4.5, 0.5, 6, 16);
    const m = new THREE.MeshLambertMaterial({ color: new THREE.Color(palette.high).multiplyScalar(1.1), flatShading: true });
    const mesh = new THREE.Mesh(g, m);
    mesh.position.copy(lm.position).addScaledVector(up, 0.3);
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
    mesh.position.copy(lm.position).addScaledVector(up, 1.0);
    mesh.quaternion.copy(yToUp);
    return mesh;
  }
  return null;
}

/**
 * Bind a single GLB clone to a landmark slot. Scales it to the asset's
 * declared `scale_range` (deterministic per-slot via the planet seed),
 * applies the per-pack/per-asset axis-up correction if any, stands it
 * along the family's blended up-vector (radial leaned toward the terrain
 * normal — see PlacementRules), ground-snaps using the clone's bbox, and
 * settles it into the terrain by the family's embed fraction.
 *
 * The clone is mutated in place (position, scale, quaternion) and returned
 * so the caller can add it to the planet group.
 *
 * @param {object} args
 * @param {object} args.slot                    - from pickLandmarkSlots
 * @param {THREE.Object3D} args.gltfClone       - clone from AssetCache.loadInstance (userData.bbox carried)
 * @param {[number, number]} [args.scaleRange]  - min/max meters; default [4,8]
 * @param {string} [args.pack]                  - catalog pack id for axis-up override
 * @param {string} [args.family]                - catalog family for placement rules
 * @param {object} [args.assetMeta]             - catalog record (axis_override)
 * @param {number} args.seed                    - planet seed for deterministic per-slot scale
 * @returns {THREE.Object3D} the same clone, now positioned + scaled
 */
export function buildLandmarkInstance({ slot, gltfClone, scaleRange = [4, 8], pack = null, family = null, assetMeta = null, seed }) {
  const [minS, maxS] = scaleRange;
  // Deterministic per-slot scale so repeat visits to the same planet pick
  // the same scale (no LLM call needed to re-derive).
  const rand = mulberry32((seed ^ 0xC0DE) >>> 0 ^ (slot.slotId * 73856093 >>> 0));
  const scale = minS + (maxS - minS) * rand();

  // Up-vector: plumb for structures, terrain-conforming for rocks,
  // blended in between (PlacementRules.TERRAIN_ALIGN).
  const up = blendedUp(slot.direction, slot.normal || slot.direction, family);

  // Compose: axisUp (asset-local fix) → surfaceUp (slot orientation) → twist.
  // Multiplications apply right-to-left, so we want quaternion = twist * surface * axisUp.
  const axisUp = axisUpQuaternionFor(pack, assetMeta);
  const surfaceUp = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
  const twist = new THREE.Quaternion().setFromAxisAngle(up, rand() * Math.PI * 2);
  gltfClone.quaternion.copy(twist).multiply(surfaceUp).multiply(axisUp);
  gltfClone.scale.setScalar(scale);

  // Grounding: move along the up-vector by the SIGNED bbox base offset
  // (down-pull included — kits authored above their origin land instead of
  // hovering), then sink by the family's embed fraction so the base reads
  // settled into the faceted terrain rather than balanced on one facet.
  const bbox = gltfClone.userData?.bbox;
  const groundOffset = groundOffsetFor(bbox, pack, assetMeta) * scale;
  const embed = embedFractionFor(family) * bboxHeightFor(bbox, pack, assetMeta) * scale;
  gltfClone.position.copy(slot.position).addScaledVector(up, groundOffset - embed);

  // Corner-pivot fix: re-center the footprint on the slot so the twist
  // above pivots through the model's middle, not the author's pivot.
  const recenter = lateralCenterFor(bbox, pack, assetMeta)
    .multiplyScalar(scale)
    .applyQuaternion(gltfClone.quaternion);
  gltfClone.position.add(recenter);

  gltfClone.userData.slotId = slot.slotId;
  gltfClone.userData.kind = slot.kind;
  return gltfClone;
}
