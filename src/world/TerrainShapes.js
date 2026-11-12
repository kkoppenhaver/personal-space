import * as THREE from 'three';
import { mulberry32, makeNoise3, fbm } from './Seed.js';

// Terrain shapes + ground patterns (Phase 15a — surfaces).
//
// Before this, every planet was the same two-octave-set noise ball; the
// concept could only move sea level and amplitude. But premises keep
// naming LANDFORMS ("two orchards on opposite sides of a low hill", "a
// volcano", "a valley floor", "opposite shores") — and the terrain is the
// single biggest thing on screen. A shape is a deterministic modifier on
// top of the base noise, chosen by the concept (or rolled from the seed
// when the concept doesn't say). A pattern paints the ground per-triangle
// (crisp low-poly tiles): fields, furrows, rings around the hero.
//
// Shapes with a FOCUS (one-mountain, crater) expose the focal direction
// so the hero lands on the summit / in the bowl — the premise's subject
// sits on the planet's most legible point.

export const TERRAIN_SHAPES = [
  'rolling', 'one-mountain', 'ridge', 'rift', 'crater', 'cratered',
  'terraced', 'mesas', 'spires', 'dunes', 'archipelago', 'plates', 'flat',
];
export const GROUND_PATTERNS = ['none', 'patchwork', 'rows', 'rings', 'spots', 'veins', 'stripes'];

// Fallback roll when the concept doesn't pick (legacy worker / placeholder).
// Weighted toward NOT-rolling: the whole point is that worlds read
// differently from orbit.
const SHAPE_WEIGHTS = {
  rolling: 14, 'one-mountain': 10, ridge: 8, rift: 8, crater: 8, cratered: 7,
  terraced: 8, mesas: 8, spires: 6, dunes: 7, archipelago: 6, plates: 6, flat: 4,
};
const PATTERN_WEIGHTS = { none: 30, patchwork: 16, rows: 12, rings: 10, spots: 12, veins: 8, stripes: 12 };

function weighted(table, rand) {
  const entries = Object.entries(table);
  let roll = rand() * entries.reduce((s, [, w]) => s + w, 0);
  for (const [k, w] of entries) { roll -= w; if (roll <= 0) return k; }
  return entries[0][0];
}

// Weighted sampling WITHOUT replacement, seeded per system: the i-th
// planet of a system gets the i-th draw, so siblings never share a
// landform (independent per-planet rolls clumped — three terraced worlds
// in a row). Same idea as the per-system registers in ConceptSeed.
function dealt(table, systemSeed, salt, index) {
  const rand = mulberry32((systemSeed ^ salt) >>> 0);
  const pool = Object.entries(table);
  const order = [];
  while (pool.length) {
    let roll = rand() * pool.reduce((s, [, w]) => s + w, 0);
    let k = 0;
    for (; k < pool.length - 1; k++) { roll -= pool[k][1]; if (roll <= 0) break; }
    order.push(pool.splice(k, 1)[0][0]);
  }
  return order[index % order.length];
}

export function dealShape(systemSeed, index) { return dealt(SHAPE_WEIGHTS, systemSeed, 0x51a9e, index); }
export function dealPattern(systemSeed, index) { return dealt(PATTERN_WEIGHTS, systemSeed, 0x9a77e, index); }

// Single-planet fallback (no system context — dev benches).
export function rollShape(seed) { return weighted(SHAPE_WEIGHTS, mulberry32((seed ^ 0x51a9e) >>> 0)); }
export function rollPattern(seed) { return weighted(PATTERN_WEIGHTS, mulberry32((seed ^ 0x9a77e) >>> 0)); }

export function normalizeShape(s) { return TERRAIN_SHAPES.includes(s) ? s : null; }
export function normalizePattern(p) { return GROUND_PATTERNS.includes(p) ? p : null; }

function randomUnit(rand) {
  const u = rand() * 2 - 1;
  const t = rand() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return new THREE.Vector3(s * Math.cos(t), s * Math.sin(t), u);
}

function gauss(x, w) { return Math.exp(-(x * x) / (w * w)); }
function sstep(a, b, t) { const x = Math.min(1, Math.max(0, (t - a) / (b - a))); return x * x * (3 - 2 * x); }

/**
 * Build a shaper for one planet. Deterministic from (seed, shape).
 *   raw(dir, base)   — modifies the base noise value (pre-normalization)
 *   above(t)         — reshapes normalized above-sea height 0..1
 *   ampMul           — multiplier on the terrain amplitude
 *   minSea           — floor on the sea-level quantile (archipelago)
 *   focus            — unit Vector3 or null
 */
export function makeShaper(seed, shape = 'rolling') {
  const rand = mulberry32((seed ^ 0x3ae71) >>> 0);
  const focus = randomUnit(rand);
  const axis = randomUnit(rand);
  const wob = makeNoise3((seed ^ 0x77e1) >>> 0);
  const wobble = (d, f = 2.2) => fbm(wob, d.x * f, d.y * f, d.z * f, 3, 2.0, 0.5);

  const S = { raw: (d, b) => b, above: (t) => t, ampMul: 1, minSea: 0, focus: null, shape };

  switch (shape) {
    case 'one-mountain':
      // One colossal peak; the rest of the world gentled so it dominates.
      S.focus = focus;
      S.raw = (d, b) => b * 0.45 + 1.5 * gauss(Math.acos(Math.min(1, d.dot(focus))), 0.55);
      S.ampMul = 3.6;
      break;
    case 'ridge': {
      // A single spine around the world — two halves facing each other.
      S.raw = (d, b) => {
        const lat = Math.asin(Math.max(-1, Math.min(1, d.dot(axis)))) + wobble(d) * 0.18;
        return b * 0.5 + 0.9 * gauss(lat, 0.2);
      };
      S.ampMul = 2.4;
      break;
    }
    case 'rift': {
      // One great canyon splitting the planet.
      S.raw = (d, b) => {
        const lat = Math.asin(Math.max(-1, Math.min(1, d.dot(axis)))) + wobble(d) * 0.12;
        return b * 0.7 + 0.25 - 1.3 * gauss(lat, 0.1);
      };
      S.ampMul = 2.0;
      break;
    }
    case 'crater': {
      // One enormous impact bowl; the hero sits in the middle.
      S.focus = focus;
      const r0 = 0.75;
      S.raw = (d, b) => {
        const a = Math.acos(Math.min(1, d.dot(focus)));
        const rim = 0.75 * gauss(a - r0, 0.13);
        const bowl = -0.8 * (1 - sstep(0, r0, a));
        const peak = 0.35 * gauss(a, 0.09); // central uplift
        return b * 0.55 + rim + bowl + peak;
      };
      S.ampMul = 2.2;
      break;
    }
    case 'cratered': {
      const craters = [];
      const n = 11 + Math.floor(rand() * 7);
      for (let i = 0; i < n; i++) craters.push({ c: randomUnit(rand), r: 0.12 + rand() * 0.28 });
      S.raw = (d, b) => {
        let v = b * 0.6;
        for (const { c, r } of craters) {
          const a = Math.acos(Math.min(1, d.dot(c)));
          if (a > r * 1.6) continue;
          v += 0.45 * gauss(a - r, r * 0.25) - 0.55 * (1 - sstep(0, r, a));
        }
        return v;
      };
      break;
    }
    case 'terraced':
      // Stepped fields — rice paddies, amphitheatres, a staircase world.
      S.above = (t) => {
        const n = 7;
        const x = t * n;
        return (Math.floor(x) + sstep(0.78, 1.0, x - Math.floor(x))) / n;
      };
      S.ampMul = 2.0;
      break;
    case 'mesas':
      // Flat-topped plateaus with cliff sides.
      S.above = (t) => 0.12 * t + 0.88 * sstep(0.32, 0.42, t) * (0.8 + 0.2 * sstep(0.7, 1, t));
      S.ampMul = 2.2;
      break;
    case 'spires': {
      // A field of needle peaks out of a low plain.
      const needles = [];
      const count = 22 + Math.floor(rand() * 14);
      for (let i = 0; i < count; i++) needles.push({ c: randomUnit(rand), h: 0.5 + rand() * 0.9, w: 0.035 + rand() * 0.04 });
      S.raw = (d, b) => {
        let v = b * 0.3;
        for (const { c, h, w } of needles) {
          const k = d.dot(c);
          if (k < 0.97) continue;
          v += h * gauss(Math.acos(Math.min(1, k)), w);
        }
        return v;
      };
      S.ampMul = 3.4;
      break;
    }
    case 'dunes': {
      // Long parallel ridges, all on one heading.
      S.raw = (d, b) => {
        const lat = Math.asin(Math.max(-1, Math.min(1, d.dot(axis))));
        const w = Math.sin(lat * 26 + wobble(d, 3.0) * 2.5);
        return b * 0.35 + 0.35 * Math.pow(0.5 + 0.5 * w, 2.2);
      };
      S.ampMul = 1.2;
      break;
    }
    case 'archipelago':
      // Many small islands in one sea.
      S.raw = (d, b) => b * 0.5 + 0.6 * wobble(d, 7.0);
      S.minSea = 0.6;
      S.ampMul = 1.6;
      break;
    case 'plates': {
      // Voronoi plates at different heights — basalt columns, tiled ground.
      const cells = [];
      for (let i = 0; i < 46; i++) cells.push({ c: randomUnit(rand), h: rand() });
      S.raw = (d, b) => {
        let d1 = -2, d2 = -2, h = 0;
        for (const cell of cells) {
          const k = d.dot(cell.c);
          if (k > d1) { d2 = d1; d1 = k; h = cell.h; } else if (k > d2) d2 = k;
        }
        const crack = (d1 - d2) < 0.012 ? -0.35 : 0;
        return b * 0.2 + h * 0.9 + crack;
      };
      S.ampMul = 1.7;
      break;
    }
    case 'flat':
      S.above = (t) => t * 0.3;
      S.ampMul = 0.5;
      break;
    default:
      break;
  }
  return S;
}

/**
 * Per-face ground pattern. Returns a function (centroidDir, above) →
 * { mix: 0..1, which: 0|1 } telling the colorizer to blend toward one of
 * two pattern colors. Water (above < 0) is left alone except for stripes.
 */
// Patterns that are smooth bands evaluate per VERTEX (soft gradients);
// the rest evaluate per FACE (crisp low-poly tiles).
export function patternIsSoft(pattern) { return pattern === 'rows' || pattern === 'stripes'; }

export function makePattern(seed, pattern, focus) {
  const rand = mulberry32((seed ^ 0x6b2d1) >>> 0);
  const axis = randomUnit(rand);
  const center = focus || randomUnit(rand);
  const n = makeNoise3((seed ^ 0x1f3b) >>> 0);
  // which: 0 = field A (lighter/warmer sibling of the ground),
  //        1 = accent (a vivid mark someone made),
  //        2 = field B (darker sibling).
  const out = { mix: 0, which: 0 };
  const none = () => { out.mix = 0; return out; };
  const latOf = (d) => Math.asin(Math.max(-1, Math.min(1, d.dot(axis))));
  const frac = (x) => ((x % 1) + 1) % 1;

  switch (pattern) {
    case 'patchwork': {
      const cells = [];
      for (let i = 0; i < 110; i++) cells.push({ c: randomUnit(rand), k: rand() });
      return (d, above) => {
        if (above < 0 || above > 0.75) return none();
        let best = -2, k = 0;
        for (const cell of cells) { const v = d.dot(cell.c); if (v > best) { best = v; k = cell.k; } }
        if (k < 0.3) return none();
        out.mix = 0.85;
        out.which = k < 0.62 ? 0 : k < 0.94 ? 2 : 1;
        return out;
      };
    }
    case 'rows':
      // Furrows ~6m apart on one heading — reads from low flight.
      return (d, above) => {
        if (above < 0 || above > 0.7) return none();
        // Soft (per-vertex) triangle wave — hard per-face stripes this
        // narrow alias into a checkerboard.
        const f = frac(latOf(d) * 9);
        out.mix = 0.75 * sstep(0.2, 0.5, Math.abs(f - 0.5) * 2);
        out.which = 2;
        return out;
      };
    case 'rings':
      // Concentric bands around the focus (the hero, when there is one).
      return (d, above) => {
        if (above < 0) return none();
        const a = Math.acos(Math.min(1, d.dot(center)));
        out.mix = frac(a * 7) < 0.4 ? 0.8 : 0;
        out.which = 1;
        return out;
      };
    case 'spots':
      return (d, above) => {
        if (above < 0) return none();
        const v = fbm(n, d.x * 8, d.y * 8, d.z * 8, 2, 2.0, 0.5);
        out.mix = v > 0.24 ? 0.85 : 0;
        out.which = 1;
        return out;
      };
    case 'veins': {
      const cells = [];
      for (let i = 0; i < 55; i++) cells.push(randomUnit(rand));
      return (d, above) => {
        if (above < 0) return none();
        let d1 = -2, d2 = -2;
        for (const c of cells) {
          const k = d.dot(c);
          if (k > d1) { d2 = d1; d1 = k; } else if (k > d2) d2 = k;
        }
        out.mix = (d1 - d2) < 0.025 ? 1 : 0;
        out.which = 1;
        return out;
      };
    }
    case 'stripes':
      // Banded latitudes, wobbling — land AND sea.
      return (d) => {
        const w = latOf(d) * 4.5 + fbm(n, d.x * 2, d.y * 2, d.z * 2, 3, 2.0, 0.5) * 1.2;
        const f = frac(w);
        out.mix = 0.7 * sstep(0.15, 0.45, Math.abs(f - 0.5) * 2);
        out.which = f < 0.5 ? 0 : 2;
        return out;
      };
    default:
      return none;
  }
}
