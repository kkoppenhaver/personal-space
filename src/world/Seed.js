// Hashed PRNG. Same seed → same world.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function hashSeeds(...nums) {
  let h = 2166136261 >>> 0;
  for (const n of nums) {
    const x = ((n | 0) ^ Math.floor(n * 1e6 | 0)) >>> 0;
    h ^= x;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// FNV-1a over the UTF-16 code units of a string. Deterministic across runs and
// platforms; collisions are fine here since we only use it to seed a PRNG.
export function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Cheap value-noise. Smooth enough for terrain, fast enough for instancing.
export function makeNoise3(seed) {
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
