import * as THREE from 'three';
import { mulberry32 } from './Seed.js';
import { axisUpQuaternionFor, groundOffsetFor, bboxHeightFor, lateralCenterFor } from './AxisUp.js';
import { blendedUp, embedFractionFor, resolveScale } from './PlacementRules.js';
import { twistToFace } from './Motifs.js';

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

// Elevation band thresholds, derived from the planet's sea level (an
// archetype-driven quantile since Phase 12a — no longer a constant 0.42).
// Land bands are expressed as fractions of the above-sea range so an
// ocean world's thin land sliver still has peaks; at the long-time default
// seaLevel=0.42 these reproduce the historical absolute constants
// (coast 0.42-0.46, basin 0.46-0.55, peak 0.78, spire 0.90).
function bandsFor(seaLevel) {
  const land = 1 - seaLevel || 1;
  return {
    COAST_LO: seaLevel,
    COAST_HI: seaLevel + 0.04,
    BASIN_LO: seaLevel + 0.04,
    BASIN_HI: seaLevel + 0.13,
    PEAK_LO:  seaLevel + 0.62 * land,
    SPIRE_LO: seaLevel + 0.83 * land,
  };
}

// Greedy angular-spread filter. ~70° apart between any two slots.
const MIN_ANGULAR_DOT = 0.35;

// Flatness preference: candidates are bucketed by slope (1 - dot(radial,
// terrain normal)) in steps of this size, and flatter buckets win. Within
// a bucket the shuffled order survives (Array#sort is stable), so equally
// flat candidates still vary per seed. Landmark slots host structures and
// hero GLBs — a knife-edge facet under a windmill reads as a glitch.
const SLOPE_BUCKET = 0.04;

export function pickLandmarkSlots({ geometry, elevations, radius, seed, count = 5, seaLevel = 0.42 }) {
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  const vCount = pos.count;
  const rand = mulberry32(seed ^ 0xdeadbeef);
  const { COAST_LO, COAST_HI, BASIN_LO, BASIN_HI, PEAK_LO, SPIRE_LO } = bandsFor(seaLevel);
  // A waterless world has no shoreline — its near-bottom band shouldn't
  // masquerade as "coast".
  const hasWater = seaLevel > 0.01;

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
    else if (hasWater && e >= COAST_LO && e < COAST_HI) band = coastCandidates;
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

  // ── Ensure minimum slots ──────────────────────────────────────────
  // If banding+spread didn't yield enough, relax the angular constraint
  // and try peaks again, then basins, then coasts. The historical floor
  // was 3; archetypes may ask for fewer on purpose (a monolith world is
  // count=1), so the floor never exceeds the requested count. With
  // pathologically smooth terrain we may still come up short; the caller
  // copes by reusing a procedural marker (see Planet.applyVisuals fallback).
  const minSlots = Math.min(3, count);
  if (picks.length < minSlots) {
    const relaxed = 0.65; // ~50° apart, more permissive
    const tryAddRelaxed = (idx, kind) => {
      if (picks.length >= minSlots) return false;
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

/**
 * Pick a single deep-water slot for archetypes whose hero floats (ocean
 * world, shipwreck graveyard). Water vertices are flattened to the sea
 * surface in TerrainGen, so the vertex position IS the waterline; the
 * normal is radial (water is flat). Prefers genuinely open water (well
 * below the coast band) and angular distance from `avoidDirs`.
 *
 * Returns a slot-shaped object (kind 'open-water') or null on a planet
 * with no deep water.
 */
export function pickOpenWaterSlot({ geometry, elevations, seed, seaLevel = 0.42, avoidDirs = [] }) {
  if (seaLevel <= 0.05) return null;
  const pos = geometry.attributes.position;
  const rand = mulberry32(seed ^ 0x0cea);
  const deep = [];
  const margin = Math.min(0.05, seaLevel * 0.5);
  for (let i = 0; i < pos.count; i++) {
    if (elevations[i] < seaLevel - margin) deep.push(i);
  }
  if (!deep.length) return null;
  shuffleInPlace(deep, rand);

  const tmp = new THREE.Vector3();
  let pick = null;
  for (const idx of deep) {
    tmp.fromBufferAttribute(pos, idx).normalize();
    if (avoidDirs.every((d) => tmp.dot(d) < MIN_ANGULAR_DOT)) { pick = idx; break; }
  }
  if (pick == null) pick = deep[0];   // crowded sky — take any deep vertex

  const direction = new THREE.Vector3().fromBufferAttribute(pos, pick).normalize();
  return {
    slotId: -1,                        // caller assigns
    kind: 'open-water',
    direction,
    normal: direction.clone(),         // water is flat: up is radial
    position: new THREE.Vector3().fromBufferAttribute(pos, pick),
    name: 'Open-Water',
  };
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
 * @param {[number, number]} [args.scaleRange]  - fallback bias range when the catalog record has none
 * @param {string} [args.pack]                  - catalog pack id for axis-up override
 * @param {string} [args.family]                - catalog family for placement rules
 * @param {object} [args.assetMeta]             - catalog record (axis/scale overrides)
 * @param {'hero'|'landmark'} [args.role]       - drives the target world height
 * @param {number} [args.scaleBoost]            - concept hero boost
 * @param {{ dir: THREE.Vector3 }|null} [args.orient] - motif facing: twist toward this
 *   direction instead of random (shared-heading / all-facing-point, Phase 14b)
 * @param {number} [args.embedBias=0]           - singular-tier embed override (max vs family)
 * @param {number} args.seed                    - planet seed for deterministic per-slot scale
 * @returns {THREE.Object3D} the same clone, now positioned + scaled
 */
export function buildLandmarkInstance({ slot, gltfClone, scaleRange = [4, 8], pack = null, family = null, assetMeta = null, role = 'landmark', scaleBoost = 1, orient = null, embedBias = 0, seed }) {
  // Deterministic per-slot scale so repeat visits to the same planet pick
  // the same scale (no LLM call needed to re-derive). Bbox-normalized
  // (Phase 13b): the target is a world HEIGHT for the role; authored kit
  // units cancel out.
  const rand = mulberry32((seed ^ 0xC0DE) >>> 0 ^ (slot.slotId * 73856093 >>> 0));
  const scale = resolveScale({
    role,
    scaleRange: assetMeta?.scale_range ?? scaleRange,
    scaleOverride: assetMeta?.scale_override ?? null,
    bboxHeight: bboxHeightFor(gltfClone.userData?.bbox, pack, assetMeta),
    rand,
    boost: scaleBoost,
  });

  // Up-vector: plumb for structures, terrain-conforming for rocks,
  // blended in between (PlacementRules.TERRAIN_ALIGN). Floating assets
  // (ships, buoys — catalog `placement: 'float'`) always stand plumb:
  // hulls don't conform to waves.
  const floats = assetMeta?.placement === 'float';
  const up = floats
    ? slot.direction.clone()
    : blendedUp(slot.direction, slot.normal || slot.direction, family);

  // Compose: axisUp (asset-local fix) → surfaceUp (slot orientation) → twist.
  // Multiplications apply right-to-left, so we want quaternion = twist * surface * axisUp.
  const axisUp = axisUpQuaternionFor(pack, assetMeta);
  const surfaceUp = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
  // Motif facing (Phase 14b): the fleet shares a heading, the gravestones
  // face the crypt. Otherwise a random per-slot twist.
  const twistAngle = orient?.dir ? twistToFace(up, orient.dir) : rand() * Math.PI * 2;
  const twist = new THREE.Quaternion().setFromAxisAngle(up, twistAngle);
  gltfClone.quaternion.copy(twist).multiply(surfaceUp).multiply(axisUp);
  gltfClone.scale.setScalar(scale);

  // Grounding: move along the up-vector by the SIGNED bbox base offset
  // (down-pull included — kits authored above their origin land instead of
  // hovering), then sink by the family's embed fraction so the base reads
  // settled into the faceted terrain rather than balanced on one facet.
  // Floating assets sit hull-deep in the water (the slot position is the
  // waterline); grounded assets settle by their family's embed fraction.
  // embedBias (singular tier, Phase 14b) deepens either — hull-down ships
  // in the dunes, monuments buried to the shoulders.
  const FLOAT_DRAFT = 0.12;
  const bbox = gltfClone.userData?.bbox;
  const groundOffset = groundOffsetFor(bbox, pack, assetMeta) * scale;
  const embedFrac = Math.max(floats ? FLOAT_DRAFT : embedFractionFor(family), embedBias);
  const embed = embedFrac * bboxHeightFor(bbox, pack, assetMeta) * scale;
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
