// Hashed PRNG. Same seed → same world.
//
// The PRNG + seed hashing live in /shared/prng.js (the worker imports them
// too); they're re-exported here so existing import sites keep working.

import { mulberry32 } from '../../shared/prng.js';

export { mulberry32, hashSeeds, hashString } from '../../shared/prng.js';

/**
 * The seeded tables behind makeNoise3: 256 unit gradients and a 256-entry
 * permutation (repeated to 512). Exported so the ground shader can upload
 * the same tables and evaluate the same noise per pixel (GroundMaterial.js).
 */
export function noise3Tables(seed) {
  const rand = mulberry32(seed);
  const grad = new Float32Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const u = rand() * 2 - 1, v = rand() * 2 - 1, w = rand() * 2 - 1;
    const m = Math.hypot(u, v, w) || 1;
    grad[i * 3] = u / m; grad[i * 3 + 1] = v / m; grad[i * 3 + 2] = w / m;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
  return { grad, perm };
}

// Cheap value-noise. Smooth enough for terrain, fast enough for instancing.
export function makeNoise3(seed) {
  const { grad, perm } = noise3Tables(seed);

  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + (b - a) * t;

  function gradDot(ix, iy, iz, x, y, z) {
    const idx = perm[(ix + perm[(iy + perm[iz & 255]) & 255]) & 255] * 3;
    return grad[idx] * x + grad[idx + 1] * y + grad[idx + 2] * z;
  }

  return function noise(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = fade(xf), v = fade(yf), w = fade(zf);
    const x0 = xi & 255, y0 = yi & 255, z0 = zi & 255;
    const x1 = (xi + 1) & 255, y1 = (yi + 1) & 255, z1 = (zi + 1) & 255;

    const n000 = gradDot(x0, y0, z0, xf, yf, zf);
    const n100 = gradDot(x1, y0, z0, xf - 1, yf, zf);
    const n010 = gradDot(x0, y1, z0, xf, yf - 1, zf);
    const n110 = gradDot(x1, y1, z0, xf - 1, yf - 1, zf);
    const n001 = gradDot(x0, y0, z1, xf, yf, zf - 1);
    const n101 = gradDot(x1, y0, z1, xf - 1, yf, zf - 1);
    const n011 = gradDot(x0, y1, z1, xf, yf - 1, zf - 1);
    const n111 = gradDot(x1, y1, z1, xf - 1, yf - 1, zf - 1);

    const nx00 = lerp(n000, n100, u);
    const nx10 = lerp(n010, n110, u);
    const nx01 = lerp(n001, n101, u);
    const nx11 = lerp(n011, n111, u);
    const nxy0 = lerp(nx00, nx10, v);
    const nxy1 = lerp(nx01, nx11, v);
    return lerp(nxy0, nxy1, w);
  };
}

// Octave sum
export function fbm(noise3, x, y, z, octaves = 4, lacunarity = 2, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise3(x * freq, y * freq, z * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
