// Per-family placement rules (Phase 13a).
//
// Three knobs, all keyed by the catalog `family` field:
//
//   TERRAIN_ALIGN — how much an instance's up-vector leans from the radial
//     direction (plumb, gravity-up) toward the local terrain normal.
//     A rock tumbles to match the hillside (≈1); a windmill stands plumb
//     no matter what (0); a tree splits the difference, mostly plumb with
//     a hint of slope conformity, like real trees.
//
//   MAX_SLOPE — steepest terrain an instance may occupy, measured as
//     `1 - dot(radialDir, terrainNormal)` (0 = flat, grows with grade).
//     Structures demand flats; rocks go anywhere.
//
//   EMBED_FRACTION — fraction of the instance's scaled bbox height sunk
//     below the surface point. The terrain is faceted (icosa subdivisions=5,
//     flatShading); an exactly-grounded base hovers over neighboring faces.
//     Sinking a little reads as "settled into the ground" instead of
//     "balanced on it". Phase 8's subdivision bump will let these shrink.
//
// Families come from catalog.source.json (rock / stone / sand / flora /
// wood / metal / bone / crystal / structure); `default` covers null/unknown
// (procedural fallbacks, future packs). `creature` lands in Phase 12b.

import * as THREE from 'three';

const TERRAIN_ALIGN = {
  rock: 0.9, stone: 0.9, bone: 0.8, sand: 0.6,
  crystal: 0.3, flora: 0.25, wood: 0.15,
  metal: 0.0, structure: 0.0, creature: 0.0,
  default: 0.35,
};

const MAX_SLOPE = {
  structure: 0.05, metal: 0.05, creature: 0.07, wood: 0.10,
  flora: 0.14, crystal: 0.20, sand: 0.30, bone: 0.30,
  stone: 1.0, rock: 1.0,
  default: 0.22,
};

const EMBED_FRACTION = {
  rock: 0.12, stone: 0.12, sand: 0.10, bone: 0.08,
  flora: 0.06, crystal: 0.05, wood: 0.04,
  structure: 0.02, metal: 0.02, creature: 0.01,
  default: 0.06,
};

// Where each family scatters, as fractions of the above-sea elevation
// range: flora hugs the lowlands and mid-slopes, rocks favor the heights,
// sand and bones collect near the waterline. Loose on purpose — bands
// overlap broadly; this biases placement, it doesn't zone the planet.
const SURFACE_BAND = {
  flora: [0.02, 0.55], wood: [0.02, 0.55],
  structure: [0.02, 0.40], metal: [0.02, 0.40], creature: [0.02, 0.50],
  sand: [0.00, 0.35], bone: [0.00, 0.60],
  crystal: [0.30, 1.0], stone: [0.25, 1.0], rock: [0.25, 1.0],
  default: [0.02, 0.80],
};

/** Absolute elevation band [lo, hi] for a family on a planet with this sea level. */
export function surfaceBandFor(family, seaLevel) {
  const [lo, hi] = SURFACE_BAND[family] ?? SURFACE_BAND.default;
  const land = 1 - seaLevel || 1;
  return [seaLevel + lo * land, seaLevel + hi * land];
}

export function terrainAlignFor(family) {
  return TERRAIN_ALIGN[family] ?? TERRAIN_ALIGN.default;
}

export function maxSlopeFor(family) {
  return MAX_SLOPE[family] ?? MAX_SLOPE.default;
}

export function embedFractionFor(family) {
  return EMBED_FRACTION[family] ?? EMBED_FRACTION.default;
}

/**
 * Slope at a surface point: 0 on flat ground, ~0.13 at 30°, ~0.29 at 45°.
 * Both args must be normalized.
 */
export function slopeOf(radialDir, terrainNormal) {
  return 1 - radialDir.dot(terrainNormal);
}

// ── Bbox-normalized scale targeting (Phase 13b) ─────────────────────
//
// Kits disagree about what 1 unit means (most Kenney props are ~1 unit,
// the pirate ships are ~11), so multiplying authored units by a kit-level
// scale_range produced dollhouses next to kaiju. Instead, target a world
// HEIGHT per role and derive the multiplier from the asset's actual bbox.

// Per-role target world height in meters [lo, hi].
const TARGET_HEIGHT = {
  hero: [12, 22],
  landmark: [5, 11],
  surface: [0.8, 3.2],
  creature: [0.7, 1.5],
  default: [1, 4],
};

// The catalog's kit-level scale_range midpoints, per role, as authored for
// the legacy multiplier system. A record's own scale_range mid relative to
// this becomes a soft size bias (a "small rock" trends small) without
// reintroducing trust in authored units.
const ROLE_RANGE_MID = { hero: 9, landmark: 4.5, surface: 1.0, creature: 1.0, default: 1.0 };

/**
 * Resolve the world-space scale multiplier for an asset instance.
 *
 * - `scale_override` (absolute multiplier) wins unchanged — it's the
 *   hand-tuned escape hatch.
 * - Otherwise: pick a target height for the role, bias it by the record's
 *   scale_range (clamped 0.5-1.6x so catalog data nudges, never dominates),
 *   and divide by the asset's actual bbox height.
 * - No bbox (procedural fallback) → legacy multiplier behavior.
 *
 * @param {object} args
 * @param {'hero'|'landmark'|'surface'|'creature'} args.role
 * @param {[number,number]|number|null} [args.scaleRange]    - catalog scale_range
 * @param {[number,number]|number|null} [args.scaleOverride] - catalog scale_override
 * @param {number} args.bboxHeight - asset height along its up axis, in authored units
 * @param {function} args.rand     - seeded PRNG ( () => [0,1) )
 * @param {number} [args.boost=1]  - archetype hero boost etc.
 */
export function resolveScale({ role, scaleRange = null, scaleOverride = null, bboxHeight, rand, boost = 1 }) {
  const pickIn = (range) => Array.isArray(range)
    ? range[0] + (range[1] - range[0]) * rand()
    : (typeof range === 'number' ? range : 1);

  if (scaleOverride != null) return pickIn(scaleOverride) * boost;

  if (!bboxHeight || bboxHeight <= 0) {
    // No bbox to normalize against — legacy multiplier semantics.
    return pickIn(scaleRange ?? TARGET_HEIGHT.default) * boost;
  }

  const target = pickIn(TARGET_HEIGHT[role] ?? TARGET_HEIGHT.default);
  let bias = 1;
  if (Array.isArray(scaleRange)) {
    const mid = (scaleRange[0] + scaleRange[1]) / 2;
    bias = Math.min(1.6, Math.max(0.5, mid / (ROLE_RANGE_MID[role] ?? ROLE_RANGE_MID.default)));
  }
  return (target * bias * boost) / bboxHeight;
}

/**
 * The up-vector an instance of `family` should stand along at this surface
 * point: radial direction leaned toward the terrain normal by the family's
 * TERRAIN_ALIGN factor. nlerp, not slerp — the angle between the two is
 * small (≤ ~35° even on the steepest facets), where they're equivalent.
 *
 * @returns {THREE.Vector3} `out` (or a fresh vector), normalized
 */
export function blendedUp(radialDir, terrainNormal, family, out = new THREE.Vector3()) {
  const t = terrainAlignFor(family);
  if (t <= 0) return out.copy(radialDir);
  if (t >= 1) return out.copy(terrainNormal);
  return out.copy(radialDir).lerp(terrainNormal, t).normalize();
}
