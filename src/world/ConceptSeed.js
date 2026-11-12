// Concept seeding (Phase 14a) — the deterministic inputs to the spawn-time
// concept call. Two rolls, both pure functions of the planet seed:
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
//   what worlds are allowed to be. ~10^5 combinations.
//
// Both ride to the worker inside the request context, so they fold into
// the KV cache key — same seed, same concept, forever.

import { mulberry32 } from './Seed.js';

const TIERS = [
  { id: 'quiet', weight: 60 },
  { id: 'notable', weight: 33 },
  { id: 'singular', weight: 7 },
];
const TIER_TOTAL = TIERS.reduce((s, t) => s + t.weight, 0);

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

// REGISTER — the emotional key a planet is written in. Unlike sparks
// (per-planet, independent), registers are dealt WITHOUT replacement
// across the planets of one system, so neighbours never share a tone.
// This is the fix for systems where every teaser drifted toward the
// same elegiac bone-field: the model's default register is "eerie
// ruin", and independent calls all fall into it.
const REGISTERS = [
  'eerie', 'playful', 'tender', 'absurd', 'grand', 'cozy',
  'industrious', 'celebratory', 'serene', 'melancholy', 'mischievous', 'proud',
];

// Name initials, likewise dealt without replacement per system, so
// siblings don't come back as Kethral / Kethraw / Ossendim / Ossmath.
const NAME_INITIALS = ['B', 'D', 'F', 'G', 'H', 'L', 'M', 'N', 'P', 'Q', 'R', 'S', 'T', 'V', 'W', 'Z', 'A', 'E', 'I', 'O', 'U', 'Y'];

function dealt(list, systemSeed, salt, index) {
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
  return dealt(REGISTERS, systemSeed, 0x3c11, index);
}

/** Required first letter for the index-th planet's name — distinct across siblings. */
export function rollNameInitial(systemSeed, index) {
  return dealt(NAME_INITIALS, systemSeed, 0x91d3, index);
}

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

/** Deterministic spark words for a planet seed — one draw per axis. */
export function rollSparks(seed) {
  const rand = mulberry32((seed ^ 0x5a9c) >>> 0);
  return SPARK_AXES.map((axis) => axis[Math.floor(rand() * axis.length)]);
}

/** Dev hook: tier distribution over n seeds. */
export function tierStats(n = 1000) {
  const counts = { quiet: 0, notable: 0, singular: 0 };
  for (let i = 0; i < n; i++) counts[rollTier(i * 2654435761 >>> 0)]++;
  return counts;
}
