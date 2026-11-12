// Colour grading for authored vertex colours (Phase 1a — true colours).
//
// Before this, every mounted asset was painted ONE flat colour (its family
// colour shifted toward the biome accent). A palm's trunk and fronds were
// the same green; a tower's roof matched its walls.
//
// Now a model keeps its own colours, re-centred on the planet's palette:
//
//   graded = centre + contrast × (authored − mean)        (in OKLab)
//
//   mean    the asset's average authored colour
//   centre  that average, pulled toward the biome accent by the family's
//           blend amount (ColorSystem.gradeCentre) — the same "dual-axis"
//           idea as before, with the asset's own average standing in for
//           the generic family colour
//   authored − mean   what makes the trunk darker and browner than the
//           fronds. It survives the grade untouched.
//
// So a planet still reads as one place (every asset's average sits on the
// palette), and each asset still reads as itself.
//
// Pure math on plain arrays: no three.js, no DOM. Colours are LINEAR sRGB
// triples (what glTF COLOR_0 and three's vertex colours hold).

// ── linear sRGB ↔ OKLab (https://bottosson.github.io/posts/oklab/) ─────

export function linearToOklab(r, g, b) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

export function oklabToLinear(L, A, B) {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

/** 0xRRGGBB (sRGB) → [r, g, b] linear. */
export function hexToLinear(hex) {
  const n = typeof hex === 'string' ? parseInt(hex.replace('#', ''), 16) : (hex >>> 0);
  return [srgbToLinear(((n >> 16) & 0xff) / 255), srgbToLinear(((n >> 8) & 0xff) / 255), srgbToLinear((n & 0xff) / 255)];
}

// ── OKLab ↔ OKLCH ──────────────────────────────────────────────────────

export function oklabToLch([L, A, B]) {
  let h = Math.atan2(B, A) * 180 / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c: Math.hypot(A, B), h };
}

export function lchToOklab({ l, c, h }) {
  const rad = h * Math.PI / 180;
  return [l, c * Math.cos(rad), c * Math.sin(rad)];
}

// ── Asset statistics ───────────────────────────────────────────────────

/**
 * Weighted mean of linear-RGB colours, taken in OKLab.
 *
 * @param {ArrayLike<number>} colors  r,g,b triples (linear)
 * @param {ArrayLike<number>|null} [weights] one weight per colour (e.g. the
 *   surface area each vertex stands for); null = equal weights
 * @returns {[number, number, number]} OKLab mean ([0.6, 0, 0] if empty)
 */
export function meanOklab(colors, weights = null) {
  const n = Math.floor(colors.length / 3);
  let sl = 0, sa = 0, sb = 0, sw = 0;
  for (let i = 0; i < n; i++) {
    const w = weights ? weights[i] : 1;
    if (!(w > 0)) continue;
    const [L, A, B] = linearToOklab(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]);
    sl += L * w; sa += A * w; sb += B * w; sw += w;
  }
  return sw > 0 ? [sl / sw, sa / sw, sb / sw] : [0.6, 0, 0];
}

// ── The grade ──────────────────────────────────────────────────────────

// Keep graded lightness inside a printable range: nothing crushes to black
// or blows out to paper-white under the game's lights.
const L_MIN = 0.12;
const L_MAX = 0.97;

/**
 * Re-centre authored colours on `centre`, keeping each colour's offset from
 * the asset's `mean`.
 *
 * @param {ArrayLike<number>} colors linear-RGB triples (authored)
 * @param {object} opts
 * @param {[number, number, number]} opts.mean    OKLab mean of the WHOLE asset
 * @param {[number, number, number]} opts.centre  OKLab colour the mean maps to
 * @param {number} [opts.contrast=1]  scale on (authored − mean); 1 keeps the
 *   authored part-to-part differences, 0 collapses to a flat `centre`
 * @param {Float32Array} [out] optional destination (same length)
 * @returns {Float32Array} graded linear-RGB triples
 */
export function gradeColors(colors, { mean, centre, contrast = 1 }, out = null) {
  const n = Math.floor(colors.length / 3);
  const dst = out || new Float32Array(n * 3);
  // Authored models repeat a handful of colours across thousands of
  // vertices; memoize on the exact input triple.
  let pr = NaN, pg = NaN, pb = NaN, qr = 0, qg = 0, qb = 0;
  for (let i = 0; i < n; i++) {
    const r = colors[i * 3], g = colors[i * 3 + 1], b = colors[i * 3 + 2];
    if (r !== pr || g !== pg || b !== pb) {
      const [L, A, B] = linearToOklab(r, g, b);
      const gl = Math.min(L_MAX, Math.max(L_MIN, centre[0] + contrast * (L - mean[0])));
      const [x, y, z] = oklabToLinear(gl, centre[1] + contrast * (A - mean[1]), centre[2] + contrast * (B - mean[2]));
      pr = r; pg = g; pb = b;
      qr = Math.min(1, Math.max(0, x)); qg = Math.min(1, Math.max(0, y)); qb = Math.min(1, Math.max(0, z));
    }
    dst[i * 3] = qr; dst[i * 3 + 1] = qg; dst[i * 3 + 2] = qb;
  }
  return dst;
}
