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
