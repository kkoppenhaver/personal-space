// What a planet's clouds look like (roadmap 1c). Pure: no three.js.
//
// Two inputs shape them, on top of the planet seed:
//   register (the planet's emotional key, dealt per system in
//            shared/planet-dice.js) picks the FORM: puffy, popcorn,
//            towering, streaked overcast, bands. It is known when the
//            system is built, so it goes into the baked noise field.
//   biome    (arrives later, with Tier 2 or its placeholder) sets how MUCH
//            and what TINT: sparse cream wisps over a desert, a fuller
//            deck over an ocean, ash over a volcano. It only changes shader
//            uniforms, so a late biome never re-bakes anything.
// The seed moves and turns the noise, so a planet always has the same
// clouds and neighbours with the same register still differ.

import { mulberry32 } from '../../shared/prng.js';

// Form by register. scale: features around the sphere (higher = smaller
// clouds). stretch: >1 smears them along latitude into streaks/bands.
// gain: fbm octave falloff (higher = ragged edges). cover: added coverage.
// shade: how dark the thick parts get seen from below. soft: edge width
// (streaks need softer edges or they read as shards from below).
const FORMS = {
  puffy:    { scale: 2.4, stretch: 1.0, gain: 0.45, cover: 0.0,  shade: 0.75, soft: 0.05 },
  popcorn:  { scale: 4.6, stretch: 1.0, gain: 0.42, cover: -0.02, shade: 0.8, soft: 0.05 },
  towering: { scale: 2.0, stretch: 1.0, gain: 0.55, cover: 0.02, shade: 0.66, soft: 0.05 },
  overcast: { scale: 2.6, stretch: 2.0, gain: 0.5,  cover: 0.1,  shade: 0.62, soft: 0.12 },
  bands:    { scale: 3.0, stretch: 3.0, gain: 0.4,  cover: 0.02, shade: 0.72, soft: 0.1 },
};

export const REGISTER_FORM = {
  serene: 'puffy', tender: 'puffy', cozy: 'puffy',
  playful: 'popcorn', absurd: 'popcorn', mischievous: 'popcorn', celebratory: 'popcorn',
  grand: 'towering', proud: 'towering',
  eerie: 'overcast', melancholy: 'overcast',
  industrious: 'bands',
};

// Amount and tint by biome (Placeholder.js / Tier 2 biome enum).
// cover: the fraction of sky the deck aims for. tint: sRGB hex.
export const BIOME_CLOUDS = {
  desert:      { cover: 0.16, tint: 0xfff0d8 },
  ocean:       { cover: 0.40, tint: 0xffffff },
  forest:      { cover: 0.34, tint: 0xf8fbff },
  ice:         { cover: 0.38, tint: 0xeef5ff },
  volcanic:    { cover: 0.32, tint: 0xa8968e },
  crystalline: { cover: 0.26, tint: 0xf3e8ff },
  alien:       { cover: 0.30, tint: 0xe6fff6 },
};
const UNKNOWN_BIOME = { cover: 0.28, tint: 0xffffff };

/** The baked part: form and placement. Depends only on register + seed. */
export function cloudForm({ register, seed }) {
  const formId = REGISTER_FORM[register] || 'puffy';
  const f = FORMS[formId];
  const rand = mulberry32((seed ^ 0xc10d5) >>> 0);
  // A random rotation (as a unit quaternion) and offset for the noise.
  const u1 = rand(), u2 = rand(), u3 = rand();
  const q = [
    Math.sqrt(1 - u1) * Math.sin(2 * Math.PI * u2),
    Math.sqrt(1 - u1) * Math.cos(2 * Math.PI * u2),
    Math.sqrt(u1) * Math.sin(2 * Math.PI * u3),
    Math.sqrt(u1) * Math.cos(2 * Math.PI * u3),
  ];
  const offset = [rand() * 97, rand() * 97, rand() * 97];
  return {
    form: formId,
    scale: f.scale * (0.9 + 0.2 * rand()),
    stretch: f.stretch,
    gain: f.gain,
    shade: f.shade,
    soft: f.soft,
    coverShift: f.cover + (rand() - 0.5) * 0.06,
    altitude: 0.85 + 0.3 * rand(),   // × the look's cloud altitude
    spin: (rand() - 0.5) * 2,        // drift direction and speed, -1..1
    q, offset,
  };
}

/** The uniform part: amount and tint. */
export function cloudCover(form, biome) {
  const b = BIOME_CLOUDS[biome] || UNKNOWN_BIOME;
  return {
    cover: Math.min(0.6, Math.max(0.08, b.cover + form.coverShift)),
    tint: b.tint,
  };
}

// ── Noise ──────────────────────────────────────────────────────────────

function hash3(x, y, z) {
  let h = (x * 374761393 + y * 668265263 + z * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const c000 = hash3(xi, yi, zi), c100 = hash3(xi + 1, yi, zi);
  const c010 = hash3(xi, yi + 1, zi), c110 = hash3(xi + 1, yi + 1, zi);
  const c001 = hash3(xi, yi, zi + 1), c101 = hash3(xi + 1, yi, zi + 1);
  const c011 = hash3(xi, yi + 1, zi + 1), c111 = hash3(xi + 1, yi + 1, zi + 1);
  const x00 = c000 + (c100 - c000) * u, x10 = c010 + (c110 - c010) * u;
  const x01 = c001 + (c101 - c001) * u, x11 = c011 + (c111 - c011) * u;
  const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}

function rotate(q, x, y, z) {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  return [x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)];
}

/**
 * The cloud field as an equirectangular byte map matching
 * THREE.SphereGeometry's UVs (u around the equator, v = 1 at the north
 * pole; row 0 is v ≈ 0). Noise is sampled in 3D on the unit sphere, so
 * there is no seam and no pinch. Values are fbm in 0..255, remapped so the
 * shader's coverage threshold means "this fraction of the sphere".
 */
export function bakeCloudField(form, width = 256, height = 128) {
  const out = new Uint8Array(width * height);
  const vals = new Float32Array(width * height);
  const OCT = 4;
  for (let j = 0; j < height; j++) {
    const theta = (1 - (j + 0.5) / height) * Math.PI;   // 0 at the north pole
    const st = Math.sin(theta), ct = Math.cos(theta);
    for (let i = 0; i < width; i++) {
      const phi = ((i + 0.5) / width) * Math.PI * 2;
      // SphereGeometry: x = -cos(phi) sin(theta), y = cos(theta), z = sin(phi) sin(theta)
      let [x, y, z] = [-Math.cos(phi) * st, ct, Math.sin(phi) * st];
      // Streaks run along latitude: squash the noise across it.
      y *= form.stretch;
      [x, y, z] = rotate(form.q, x, y, z);
      let amp = 1, freq = form.scale, sum = 0, norm = 0;
      for (let o = 0; o < OCT; o++) {
        sum += amp * valueNoise(x * freq + form.offset[0], y * freq + form.offset[1], z * freq + form.offset[2]);
        norm += amp;
        amp *= form.gain;
        freq *= 2.03;
      }
      vals[j * width + i] = sum / norm;
    }
  }
  // Rank-remap to uniform 0..1, weighted by texel area (sin theta), so a
  // threshold of (1 - cover) covers `cover` of the sphere's area.
  const n = width * height;
  const idx = new Uint32Array(n);
  for (let k = 0; k < n; k++) idx[k] = k;
  idx.sort((a, b) => vals[a] - vals[b]);
  let total = 0;
  const area = new Float32Array(height);
  for (let j = 0; j < height; j++) { area[j] = Math.sin((1 - (j + 0.5) / height) * Math.PI); total += area[j] * width; }
  let acc = 0;
  for (let k = 0; k < n; k++) {
    const t = idx[k];
    const a = area[Math.floor(t / width)];
    out[t] = Math.round(((acc + a * 0.5) / total) * 255);
    acc += a;
  }
  return out;
}
