// Tiny OKLCH color helper. No dependencies.
//
// OKLCH is a perceptually-uniform polar color space (the OKLab cylinder).
// Why we bother:
//   - Lerping two colors in OKLCH preserves perceived brightness and
//     chroma — sRGB lerps muddy through gray, HSL lerps shift lightness.
//   - We need to blend a family base color (e.g. "rock gray") toward a
//     biome accent (e.g. "volcanic red") by a per-family amount; OKLCH
//     gives a clean linear knob for that.
//
// Reference: https://bottosson.github.io/posts/oklab/

const _srgbToLinear = (v) => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
const _linearToSrgb = (v) => v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;

function _srgbHexToLab(hex) {
  const n = typeof hex === 'string' ? parseInt(hex.replace('#', ''), 16) : (hex >>> 0);
  const r = _srgbToLinear(((n >> 16) & 0xff) / 255);
  const g = _srgbToLinear(((n >> 8) & 0xff) / 255);
  const b = _srgbToLinear((n & 0xff) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

function _labToSrgbHex(L, A, B) {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
  const r = _linearToSrgb( 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const g = _linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const b = _linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const ir = Math.round(clamp(r) * 255);
  const ig = Math.round(clamp(g) * 255);
  const ib = Math.round(clamp(b) * 255);
  return (ir << 16) | (ig << 8) | ib;
}

/**
 * Convert a hex color (number or "#rrggbb") to {l, c, h} where:
 *   l ∈ [0, 1] perceptual lightness
 *   c ∈ [0, ~0.4] chroma
 *   h ∈ [0, 360) hue in degrees
 */
export function hexToOklch(hex) {
  const [L, A, B] = _srgbHexToLab(hex);
  const c = Math.hypot(A, B);
  let h = Math.atan2(B, A) * 180 / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h };
}

/**
 * Convert {l, c, h} back to a hex integer (0xRRGGBB).
 */
export function oklchToHex({ l, c, h }) {
  const rad = h * Math.PI / 180;
  return _labToSrgbHex(l, c * Math.cos(rad), c * Math.sin(rad));
}

/**
 * Blend two OKLCH colors linearly. t=0 → a, t=1 → b.
 * Hue takes the shorter arc around the wheel so red↔magenta doesn't
 * detour through green.
 */
export function mixOklch(a, b, t) {
  const dl = b.l - a.l;
  const dc = b.c - a.c;
  let dh = b.h - a.h;
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  let h = a.h + dh * t;
  if (h < 0) h += 360;
  if (h >= 360) h -= 360;
  return { l: a.l + dl * t, c: a.c + dc * t, h };
}
