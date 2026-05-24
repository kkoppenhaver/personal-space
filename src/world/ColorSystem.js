// Dual-axis color resolution for planet-mounted assets.
//
// Axis 1 — Semantic family anchor (FAMILY_BASE):
//   Every asset has a `family` (rock, flora, structure, ...). Each family
//   has a baseline OKLCH color that says "what this material kind looks
//   like regardless of context." Rocks read as low-chroma gray; flora as
//   mid-chroma green; bone as desaturated cream.
//
// Axis 2 — Biome shift (FAMILY_BLEND × BIOME_OVERRIDES):
//   Each family is blended toward the biome's accent hue by a per-family
//   amount. Rocks lean ~30% so they stay recognizably rock-like with just
//   a biome tint (basalt on volcanic, frost-gray on ice). Flora leans
//   ~60% — greens still read as plants. Landmarks lean ~100% — they get
//   the pure accent so they pop. Hero is 0% — original PBR.
//
// Per-asset jitter:
//   Two instances of the same asset on the same planet shouldn't read as
//   identical paint chips. A hash-keyed nudge (hue ±2°, chroma ±5%) keeps
//   family identity intact while breaking visual repetition.

import { hexToOklch, mixOklch, oklchToHex } from './OKLCH.js';

// ── Family base colors ────────────────────────────────────────────────
//
// Picked for "what this material looks like with no biome context." Tuned
// by eye against the Quaternius / Kenney / KayKit packs we ship. Adjust
// the chroma to make a family more/less assertive against the biome.
const FAMILY_BASE = {
  rock:      { l: 0.55, c: 0.025, h:  60 },  // warm gray
  stone:     { l: 0.62, c: 0.020, h:  70 },  // slightly cooler/lighter than rock
  sand:      { l: 0.78, c: 0.060, h:  85 },  // warm pale
  flora:     { l: 0.58, c: 0.110, h: 140 },  // saturated green
  wood:      { l: 0.45, c: 0.080, h:  50 },  // warm brown
  metal:     { l: 0.62, c: 0.020, h: 230 },  // cool desaturated
  bone:      { l: 0.82, c: 0.030, h:  85 },  // cream
  crystal:   { l: 0.72, c: 0.120, h: 290 },  // luminous purple
  structure: { l: 0.65, c: 0.040, h:  60 },  // weathered stone
  default:   { l: 0.55, c: 0.040, h:  60 },
};

// ── Biome accent hue (when palette is unavailable) ────────────────────
//
// Used as a fallback. In practice the LLM ships a palette and we use
// `palette.snow` as the accent — see resolveColor's `biomeAccentHex` arg.
const BIOME_FALLBACK_ACCENT = {
  desert:       0xd8a85f,
  ocean:        0x3aa0c9,
  forest:       0x4a7c3a,
  ice:          0xb8d8e8,
  volcanic:     0xb84a2a,
  crystalline:  0x9e6cc8,
  'gas-stripped': 0x6a5a4a,
  alien:        0x7ad07a,
};

// ── Per-family default blend toward biome accent ──────────────────────
//
// 0 = pure family color, 1 = pure biome accent. Per the plan:
//   - rocks lean ~30% (stay rocky)
//   - flora ~60% (still reads as plant)
//   - landmarks/structure ~100% (pure accent)
//   - hero 0% (untouched PBR)
const FAMILY_BLEND_DEFAULT = {
  rock:      0.30,
  stone:     0.35,
  sand:      0.55,
  flora:     0.60,
  wood:      0.40,
  metal:     0.45,
  bone:      0.25,
  crystal:   0.70,
  structure: 0.95,
  default:   0.50,
};

// ── Per-biome overrides (sparse) ──────────────────────────────────────
//
// Where a biome wants stronger or weaker shift than the family default.
// Volcanic rocks lean harder so basalt reads warm; ice rocks lean lighter
// so frost-blue rocks aren't electric.
const BIOME_BLEND_OVERRIDES = {
  volcanic: { rock: 0.45, stone: 0.45 },
  ice:      { rock: 0.40, flora: 0.50 },
  alien:    { flora: 0.75, crystal: 0.85 },
};

/**
 * Look up the family→accent blend factor for (biome, family).
 */
function blendFactor(biome, family) {
  return BIOME_BLEND_OVERRIDES[biome]?.[family] ?? FAMILY_BLEND_DEFAULT[family] ?? FAMILY_BLEND_DEFAULT.default;
}

/** Cheap deterministic hash → integer. */
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h;
}

/**
 * Resolve a final color for one mounted asset on one planet.
 *
 * @param {object} args
 * @param {string} args.family            - e.g. 'rock', 'flora', 'structure'
 * @param {string|null} args.biome        - LLM biome enum, or null for default blend
 * @param {number} args.biomeAccentHex    - 0xRRGGBB; usually palette.snow
 * @param {string} args.assetId           - catalog id; used for per-asset jitter
 * @returns {number} hex 0xRRGGBB
 */
export function resolveColor({ family, biome, biomeAccentHex, assetId }) {
  const base = FAMILY_BASE[family] || FAMILY_BASE.default;
  const accent = hexToOklch(biomeAccentHex);
  const t = blendFactor(biome, family);
  const mixed = mixOklch(base, accent, t);

  // Hash-keyed jitter so two instances of the same asset on the same
  // planet vary subtly. Hue ±2°, chroma ±5% of family chroma — small
  // enough to read as "natural variation," not "different material."
  const h = hashStr(assetId || '');
  const dh = ((h & 0xff) / 255 - 0.5) * 4;          // ±2°
  const dc = (((h >>> 8) & 0xff) / 255 - 0.5) * 0.10 * base.c; // ±5% of family chroma
  return oklchToHex({
    l: mixed.l,
    c: Math.max(0, mixed.c + dc),
    h: (mixed.h + dh + 360) % 360,
  });
}

/** Default biome accent if no palette is available. Used as a safety net. */
export function biomeFallbackAccent(biome) {
  return BIOME_FALLBACK_ACCENT[biome] ?? 0xb0b0b0;
}

/** Exported for tests and debug overlays. */
export const _internal = { FAMILY_BASE, FAMILY_BLEND_DEFAULT, BIOME_BLEND_OVERRIDES };
