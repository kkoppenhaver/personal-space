// The sky's colours (roadmap 1c), derived from one planet sky colour.
//
// A planet has a single `palette.sky`. From it this module derives every
// colour the sky needs, in linear light (what the shaders and THREE.Color
// work in):
//
//   zenith       day, straight up: deeper and more saturated than the palette
//   horizon      day, at the horizon: paler (toward its own grey)
//   duskWarm     the band toward a setting sun (warm, tinted by the star)
//   duskCool     the side away from it (blue-violet, tinted by the palette)
//   duskZenith   overhead at dusk: the day zenith, much darker
//   night        a near-black tinted toward the palette
//
// The atmosphere shader blends these by the sun's elevation; main.js reads
// `horizonAt()` for the fog so distant ground melts into the horizon colour.
// Levels are absolute fractions of the palette colour and are multiplied by
// the look's `skyGain` (Looks.js), so the sky never gets brighter than the
// pre-1c shell (which drew about skyGain × palette everywhere).

import * as THREE from 'three';

/** Settings used when a look has no `sky` key (benches, the `now` look). */
export const DEFAULT_SKY = {
  zenithDeepen: 0.6,
  zenithLevel: 0.62,
  horizonPale: 0.35,
  horizonLevel: 0.82,
  duskWarm: 0xff7a3c,
  duskCool: 0x4a5c9c,
  duskWarmLevel: 0.75,
  duskCoolLevel: 0.32,
  duskZenithLevel: 0.16,
  night: 0x0a1020,
  nightTint: 0.35,
  nightLevel: 0.06,
  limbLevel: 1.1,
  // Atmosphere shell (Atmosphere.js).
  limbHeight: 0.07,     // scale height of the visible layer, × planet radius
  limbStrength: 0.25,   // optical depth → opacity
  faceHaze: 0.25,       // haze over the planet's face, relative to the limb
  skyFullBelow: 0.25,   // full sky below this fraction of ATM_TOP
  nightAlpha: 0.25,     // night sky opacity overhead (stars show through)
  glare: 1,             // glow around the sun in the day sky
  lowSunDim: 0.55,      // the day sky's level with the sun at the horizon
  sunGlowDay: 0.35,     // the star's glow sprite under a daytime sky (main.js)
  sunDiscDay: 0.3,      // and its disc
};

const _c = new THREE.Color();

function lum(c) { return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }

/**
 * Every sky colour for one planet. `skyHex` is the planet's palette sky
 * (an sRGB hex string or number), `sunColor` a THREE.Color (the star),
 * `gain` the look's skyGain, `s` the look's `sky` settings.
 * Returns THREE.Colors in linear light.
 */
export function skyPalette(skyHex, { sunColor = null, gain = 1, s = DEFAULT_SKY } = {}) {
  const S = new THREE.Color(skyHex ?? 0x8bb8dc);
  const L = Math.max(lum(S), 0.02);
  const grey = new THREE.Color(L, L, L);

  // Deeper overhead: square the colour (more saturated, darker), then put
  // its brightness back to the palette's before applying the level, so the
  // zenith keeps the palette's hue family instead of going black.
  const deep = new THREE.Color(S.r * S.r, S.g * S.g, S.b * S.b);
  deep.multiplyScalar(L / Math.max(lum(deep), 1e-4));
  const zenith = S.clone().lerp(deep, s.zenithDeepen).multiplyScalar(s.zenithLevel * gain);
  const horizon = S.clone().lerp(grey, s.horizonPale).multiplyScalar(s.horizonLevel * gain);

  // Dusk: a warm band toward the sun, tinted by the star (and a little by
  // the palette, so a red-sky planet sets redder), cooler tones opposite.
  const duskWarm = new THREE.Color(s.duskWarm);
  if (sunColor) duskWarm.multiply(_c.copy(sunColor).lerp(new THREE.Color(1, 1, 1), 0.4));
  duskWarm.lerp(S.clone().multiplyScalar(1 / L * 0.5), 0.15).multiplyScalar(s.duskWarmLevel * gain);
  const duskCool = new THREE.Color(s.duskCool).lerp(S, 0.3).multiplyScalar(s.duskCoolLevel * gain);
  const duskZenith = zenith.clone().multiplyScalar(s.duskZenithLevel / s.zenithLevel);

  const night = new THREE.Color(s.night).lerp(S.clone().multiplyScalar(0.12), s.nightTint)
    .multiplyScalar(s.nightLevel / 0.06);

  // The lit limb seen from space: the horizon colour, a little brighter.
  const limb = S.clone().lerp(grey, 0.2).multiplyScalar(s.limbLevel * gain);

  return { sky: S, zenith, horizon, duskWarm, duskCool, duskZenith, night, limb, lowSunDim: s.lowSunDim };
}

const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * How day, dusk and night mix at a sun elevation `e` (sine of the angle
 * above the horizon, -1..1). Mirrored in the atmosphere shader.
 */
export function skyWeights(e) {
  const day = smooth(-0.03, 0.28, e);
  const night = 1 - smooth(-0.32, -0.06, e);
  return { day, night, dusk: Math.max(0, 1 - day - night) };
}

/**
 * The horizon colour averaged around the compass at sun elevation `e`:
 * what the fog takes, so distant ground melts into the sky. `out` is
 * written and returned.
 */
export function horizonAt(pal, e, out = new THREE.Color()) {
  const w = skyWeights(e);
  // Around the compass the dusk horizon is half warm, half cool.
  _c.copy(pal.duskCool).lerp(pal.duskWarm, 0.4);
  _d.copy(pal.horizon).multiplyScalar(dayDim(pal, e));
  out.copy(_c).lerp(_d, w.day).lerp(pal.night, w.night);
  return out;
}

/** The day sky's level at sun elevation `e`: it dims as the sun gets low. */
export function dayDim(pal, e) {
  return pal.lowSunDim + (1 - pal.lowSunDim) * smooth(0, 0.5, e);
}

const _d = new THREE.Color();
