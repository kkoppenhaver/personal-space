// Planet dice — every deterministic roll that feeds the spawn-time concept
// call. Pure functions of seeds; no DOM, no three.js.
//
// Lives in /shared because BOTH sides import it:
//   - the game rolls these to build terrain and to seed its offline fallback;
//   - the worker re-derives them from (system_seed, planet_index) so the
//     prompt context is never client-supplied text (see conceptContextFor).
//
//   TIER — how much coordination budget this planet gets. Not "how weird
//   the idea is": quiet planets still carry one observable note; singular
//   planets get motif stacking, slot exceptions, and longer lore. The
//   ratios are the discovery pacing — most of the sky is quiet so the
//   singular finds land as finds.
//
//   SPARKS — entropy without buckets. A few draws from orthogonal word
//   lists, handed to the concept model as inspiration grit ("keep what
//   sparks, discard freely"). This is what stops ten thousand planets
//   from converging on the model's favorite premise, WITHOUT enumerating
//   what worlds are allowed to be.
//
//   REGISTER / NAME INITIAL / LANDFORM / GROUND PATTERN — dealt WITHOUT
//   replacement across the planets of one system, so siblings never share
//   a tone, a first letter, or a landform.

import { mulberry32, hashSeeds } from './prng.js';

// ── Tier ────────────────────────────────────────────────────────────────

const TIERS = [
  { id: 'quiet', weight: 60 },
  { id: 'notable', weight: 33 },
  { id: 'singular', weight: 7 },
];
const TIER_TOTAL = TIERS.reduce((s, t) => s + t.weight, 0);
export const TIER_IDS = TIERS.map((t) => t.id);

/** Deterministic tier for a planet seed: 'quiet' | 'notable' | 'singular'. */
export function rollTier(seed) {
  const rand = mulberry32((seed ^ 0x7e1a) >>> 0);
  let roll = rand() * TIER_TOTAL;
  for (const t of TIERS) {
    roll -= t.weight;
    if (roll <= 0) return t.id;
  }
  return 'quiet';
}

/** Dev hook: tier distribution over n seeds. */
export function tierStats(n = 1000) {
  const counts = { quiet: 0, notable: 0, singular: 0 };
  for (let i = 0; i < n; i++) counts[rollTier(i * 2654435761 >>> 0)]++;
  return counts;
}

// ── Sparks ──────────────────────────────────────────────────────────────

// Orthogonal axes. Nouns/feelings the model can transmute — deliberately
// NOT world-types. Editing these lists tunes flavor, not taxonomy.
const SPARK_AXES = [
  // material / substance
  ['salt', 'rust', 'wax', 'chalk', 'amber', 'ash', 'glass', 'moss', 'tin', 'tar', 'bone', 'silk',
   'honey', 'brass', 'paper', 'clay', 'velvet', 'copper', 'wool', 'pearl'],
  // mood / charge
  ['grief', 'patience', 'spite', 'devotion', 'stubbornness', 'mercy', 'appetite', 'homesickness', 'triumph', 'apology', 'curiosity', 'dread',
   'delight', 'mischief', 'pride', 'giddiness', 'tenderness', 'showing off', 'hospitality', 'awe'],
  // process / verb-feeling
  ['drowned', 'abandoned mid-task', 'over-tended', 'counted', 'rehearsed', 'buried', 'sorted', 'repeated', 'guarded', 'forgotten on purpose', 'measured', 'waiting',
   'celebrated', 'decorated', 'raced', 'traded', 'built for a party', 'grown too well', 'herded', 'invited', 'stacked', 'polished'],
  // scale / quantity feeling
  ['colossal', 'one of everything', 'thousands of one thing', 'half-finished', 'miniature', 'exactly two', 'too many', 'the last one',
   'a matched pair', 'a crowd', 'mismatched sizes', 'one enormous and one tiny'],
];

/** Deterministic spark words for a planet seed — one draw per axis. */
export function rollSparks(seed) {
  const rand = mulberry32((seed ^ 0x5a9c) >>> 0);
  return SPARK_AXES.map((axis) => axis[Math.floor(rand() * axis.length)]);
}

// ── Register + name initial (uniform deal per system) ───────────────────

// REGISTER — the emotional key a planet is written in. Dealt without
// replacement so neighbours never share a tone. This is the fix for
// systems where every teaser drifted toward the same elegiac bone-field:
// the model's default register is "eerie ruin", and independent calls all
// fall into it.
export const REGISTERS = [
  'eerie', 'playful', 'tender', 'absurd', 'grand', 'cozy',
  'industrious', 'celebratory', 'serene', 'melancholy', 'mischievous', 'proud',
];

// Name initials, likewise dealt without replacement per system, so
// siblings don't come back as Kethral / Kethraw / Ossendim / Ossmath.
const NAME_INITIALS = ['B', 'D', 'F', 'G', 'H', 'L', 'M', 'N', 'P', 'Q', 'R', 'S', 'T', 'V', 'W', 'Z', 'A', 'E', 'I', 'O', 'U', 'Y'];

// Seeded Fisher–Yates; the index-th card of the shuffled deck.
function dealtUniform(list, systemSeed, salt, index) {
  const rand = mulberry32((systemSeed ^ salt) >>> 0);
  const deck = list.slice();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck[index % deck.length];
}

/** Tone for the index-th planet of a system — distinct across siblings. */
export function rollRegister(systemSeed, index) {
  return dealtUniform(REGISTERS, systemSeed, 0x3c11, index);
}

/** Required first letter for the index-th planet's name — distinct across siblings. */
export function rollNameInitial(systemSeed, index) {
  return dealtUniform(NAME_INITIALS, systemSeed, 0x91d3, index);
}

// ── Landform + ground pattern (weighted deal per system) ────────────────

export const TERRAIN_SHAPES = [
  'rolling', 'one-mountain', 'ridge', 'rift', 'crater', 'cratered',
  'terraced', 'mesas', 'spires', 'dunes', 'archipelago', 'plates', 'flat',
];
export const GROUND_PATTERNS = ['none', 'patchwork', 'rows', 'rings', 'spots', 'veins', 'stripes'];

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
// in a row).
function dealtWeighted(table, systemSeed, salt, index) {
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

export function dealShape(systemSeed, index) { return dealtWeighted(SHAPE_WEIGHTS, systemSeed, 0x51a9e, index); }
export function dealPattern(systemSeed, index) { return dealtWeighted(PATTERN_WEIGHTS, systemSeed, 0x9a77e, index); }

// Single-planet fallback (no system context — dev benches).
export function rollShape(seed) { return weighted(SHAPE_WEIGHTS, mulberry32((seed ^ 0x51a9e) >>> 0)); }
export function rollPattern(seed) { return weighted(PATTERN_WEIGHTS, mulberry32((seed ^ 0x9a77e) >>> 0)); }

export function normalizeShape(s) { return TERRAIN_SHAPES.includes(s) ? s : null; }
export function normalizePattern(p) { return GROUND_PATTERNS.includes(p) ? p : null; }

// ── Identity → concept context (the single source of truth) ─────────────

/** Seed of the index-th planet (0-based) of a system. Mirrors SolarSystem. */
export function planetSeedFor(systemSeed, planetIndex) {
  return hashSeeds(systemSeed >>> 0, planetIndex + 1);
}

// Planet radii are PLANET_RADIUS * (0.8..1.4) = 80..140 today; the clamp
// leaves headroom for tuning without letting a client send nonsense.
export const RADIUS_MIN = 40;
export const RADIUS_MAX = 240;

/**
 * The exact context object the /concept prompt sees for one planet.
 *
 * Called by the client (offline fallback + legacy request field) AND by the
 * worker (which ignores whatever context the client sent and uses this).
 * Because both sides run the same function, the worker's KV cache key is
 * identical no matter who computed it.
 *
 * @param {{ systemSeed: number, planetIndex: number, radius: number }} id
 */
export function conceptContextFor({ systemSeed, planetIndex, radius }) {
  const sys = systemSeed >>> 0;
  const idx = planetIndex | 0;
  const seed = planetSeedFor(sys, idx);
  const r = Math.round(Number(radius));
  return {
    radius: Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, Number.isFinite(r) ? r : 100)),
    tier: rollTier(seed),
    sparks: rollSparks(seed),
    register: rollRegister(sys, idx),
    name_initial: rollNameInitial(sys, idx),
    terrain_shape: dealShape(sys, idx),
    ground_pattern: dealPattern(sys, idx),
  };
}
