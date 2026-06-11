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
  ['salt', 'rust', 'wax', 'chalk', 'amber', 'ash', 'glass', 'moss', 'tin', 'tar', 'bone', 'silk'],
  // mood / charge
  ['grief', 'patience', 'spite', 'devotion', 'stubbornness', 'mercy', 'appetite', 'homesickness', 'triumph', 'apology', 'curiosity', 'dread'],
  // process / verb-feeling
  ['drowned', 'abandoned mid-task', 'over-tended', 'counted', 'rehearsed', 'buried', 'sorted', 'repeated', 'guarded', 'forgotten on purpose', 'measured', 'waiting'],
  // scale / quantity feeling
  ['colossal', 'one of everything', 'thousands of one thing', 'half-finished', 'miniature', 'exactly two', 'too many', 'the last one'],
];

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
