import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { mulberry32, makeNoise3, fbm, noise3Tables } from '../../src/world/Seed.js';
import { makePattern, patternParams, GROUND_PATTERNS } from '../../src/world/TerrainShapes.js';
import { PATTERN_CODES } from '../../src/world/GroundMaterial.js';

// The ground shader (src/world/GroundMaterial.js) draws the patterns per
// pixel. GLSL cannot run here, so these tests pin the parts that can go
// wrong in the port:
//   1. patternParams (the seeded layout the shader uploads) reproduces the
//      pre-1d CPU pattern exactly (makePattern is now built on it);
//   2. a line-for-line JS transliteration of the shader's pattern code,
//      with the anti-aliasing width at zero, picks the same colour and
//      weight as the CPU reference — including the noise read from the
//      uploaded table with float mod() instead of bitwise &.

function sstep(a, b, t) { const x = Math.min(1, Math.max(0, (t - a) / (b - a))); return x * x * (3 - 2 * x); }
function randomUnit(rand) {
  const u = rand() * 2 - 1;
  const t = rand() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return new THREE.Vector3(s * Math.cos(t), s * Math.sin(t), u);
}

// ── The pre-1d CPU pattern, verbatim (git show 82b89fa:src/world/TerrainShapes.js) ──
function originalMakePattern(seed, pattern, focus) {
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

// ── Transliteration of GroundMaterial.js's GLSL (keep in step with it) ──
const fract = (x) => x - Math.floor(x);
const mod = (x, y) => x - y * Math.floor(x / y);
const step0 = (edge, x) => (x < edge ? 0 : 1);   // smoothstep(e - 0, e + 0, x)

function shaderNoise(tex) {
  const perm = (i) => tex[i * 4 + 3];
  const gradDot = (ix, iy, iz, fx, fy, fz) => {
    const idx = perm(mod(ix + perm(mod(iy + perm(iz), 256)), 256));
    return tex[idx * 4] * fx + tex[idx * 4 + 1] * fy + tex[idx * 4 + 2] * fz;
  };
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const mix = (a, b, t) => a + (b - a) * t;
  const noise = (x, y, z) => {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = x - ix, fy = y - iy, fz = z - iz;
    const u = fade(fx), v = fade(fy), w = fade(fz);
    const ax = mod(ix, 256), ay = mod(iy, 256), az = mod(iz, 256);
    const bx = mod(ix + 1, 256), by = mod(iy + 1, 256), bz = mod(iz + 1, 256);
    return mix(
      mix(mix(gradDot(ax, ay, az, fx, fy, fz), gradDot(bx, ay, az, fx - 1, fy, fz), u),
          mix(gradDot(ax, by, az, fx, fy - 1, fz), gradDot(bx, by, az, fx - 1, fy - 1, fz), u), v),
      mix(mix(gradDot(ax, ay, bz, fx, fy, fz - 1), gradDot(bx, ay, bz, fx - 1, fy, fz - 1), u),
          mix(gradDot(ax, by, bz, fx, fy - 1, fz - 1), gradDot(bx, by, bz, fx - 1, fy - 1, fz - 1), u), v), w);
  };
  return (x, y, z, octaves) => {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) { sum += amp * noise(x * freq, y * freq, z * freq); norm += amp; amp *= 0.5; freq *= 2; }
    return sum / norm;
  };
}

function textureOf(seed) {
  const { grad, perm } = noise3Tables(seed);
  const tex = new Float32Array(256 * 4);
  for (let i = 0; i < 256; i++) { tex.set([grad[i * 3], grad[i * 3 + 1], grad[i * 3 + 2], perm[i]], i * 4); }
  return tex;
}

// Returns { mix, which } like the CPU reference (which = the colour index
// the shader ends up on), for a point on land.
function shaderPattern(params, d, above) {
  const code = PATTERN_CODES[params.pattern];
  const fbm3 = (code === 4 || code === 6) ? shaderNoise(textureOf(params.noiseSeed)) : null;
  const patch = (k) => (k < 0.3 ? { mix: 0, which: 0 } : { mix: 0.85, which: k < 0.62 ? 0 : (k < 0.94 ? 2 : 1) });
  switch (code) {
    case 1: {
      let d1 = -2, d2 = -2, k1 = 0;
      for (const { c, k } of params.cells) {
        const v = d.dot(c);
        if (v > d1) { d2 = d1; d1 = v; k1 = k; } else if (v > d2) d2 = v;
      }
      const r = patch(k1);   // t = 1 away from a cell edge
      return { mix: r.mix * (1 - step0(0.75, above)), which: r.which };
    }
    case 2: {
      const lat = Math.asin(Math.min(1, Math.max(-1, d.dot(params.axis))));
      const f = fract(lat * 9);
      return { mix: 0.75 * sstep(0.2, 0.5, Math.abs(f - 0.5) * 2) * (1 - step0(0.7, above)), which: 2 };
    }
    case 3: {
      const x = Math.acos(Math.min(1, d.dot(params.center))) * 7;
      const dist = Math.abs(fract(x - 0.2 + 0.5) - 0.5);
      return { mix: 0.8 * (1 - step0(0.2, dist)), which: 1 };
    }
    case 4: {
      const v = fbm3(d.x * 8, d.y * 8, d.z * 8, 2);
      return { mix: 0.85 * step0(0.24, v), which: 1 };
    }
    case 5: {
      let d1 = -2, d2 = -2;
      for (const { c } of params.cells) { const v = d.dot(c); if (v > d1) { d2 = d1; d1 = v; } else if (v > d2) d2 = v; }
      return { mix: 1 - step0(0.025, d1 - d2), which: 1 };
    }
    case 6: {
      const s = Math.asin(Math.min(1, Math.max(-1, d.dot(params.axis)))) * 4.5 + fbm3(d.x * 2, d.y * 2, d.z * 2, 3) * 1.2;
      const f = fract(s);
      const t = step0(0, f > 0.5 ? f - 1 : f);   // 1 → colour 0, 0 → colour 2
      return { mix: 0.7 * sstep(0.15, 0.45, Math.abs(f - 0.5) * 2), which: t > 0.5 ? 0 : 2 };
    }
    default: return { mix: 0, which: 0 };
  }
}

const SEEDS = [1, 101, 202, 4242, 0x7fffffff, 3000000000];
const randomDirs = (n, seed) => { const r = mulberry32(seed); return Array.from({ length: n }, () => randomUnit(r)); };

describe('pattern layout (patternParams)', () => {
  it('reproduces the pre-1d CPU patterns exactly', () => {
    const focus = new THREE.Vector3(0.3, -0.5, 0.81).normalize();
    for (const pattern of GROUND_PATTERNS) {
      for (const seed of SEEDS) {
        for (const f of [null, focus]) {
          const now = makePattern(seed, pattern, f);
          const before = originalMakePattern(seed, pattern, f);
          const r = mulberry32(seed ^ 0x55);
          for (const d of randomDirs(300, seed)) {
            const above = r() * 1.2 - 0.2;
            const a = { ...now(d, above) }, b = { ...before(d, above) };
            expect(a.mix).toBe(b.mix);
            if (a.mix > 0) expect(a.which).toBe(b.which);
          }
        }
      }
    }
  });

  it('only patchwork and veins carry cells', () => {
    for (const p of GROUND_PATTERNS) {
      const n = patternParams(7, p, null).cells.length;
      expect(n > 0).toBe(p === 'patchwork' || p === 'veins');
    }
  });
});

describe('ground shader pattern code (transliterated)', () => {
  it('reads the uploaded noise table as makeNoise3, negative coordinates included', () => {
    for (const seed of [11, 0x1f3b ^ 202, 99999]) {
      const ref = makeNoise3(seed);
      const port = shaderNoise(textureOf(seed));
      const r = mulberry32(seed);
      for (let i = 0; i < 500; i++) {
        const x = (r() - 0.5) * 40, y = (r() - 0.5) * 40, z = (r() - 0.5) * 40;
        expect(port(x, y, z, 1)).toBeCloseTo(ref(x, y, z), 6);
        expect(port(x, y, z, 3)).toBeCloseTo(fbm(ref, x, y, z, 3, 2, 0.5), 6);
      }
    }
  });

  it('picks the same colour and weight as the CPU reference on land', () => {
    let compared = 0;
    for (const pattern of GROUND_PATTERNS) {
      for (const seed of SEEDS.slice(0, 4)) {
        const params = patternParams(seed, pattern, null);
        const ref = makePattern(seed, pattern, null);
        const r = mulberry32(seed ^ 0x99);
        for (const d of randomDirs(400, seed ^ 0x3)) {
          const above = r();                 // land
          const a = shaderPattern(params, d, above);
          const b = { ...ref(d, above) };
          expect(a.mix).toBeCloseTo(b.mix, 9);
          if (b.mix > 0) expect(a.which).toBe(b.which);
          compared++;
        }
      }
    }
    expect(compared).toBe(GROUND_PATTERNS.length * 4 * 400);
  });
});
