// World archetypes (Phase 12a) — the anti-mode-collapse mechanism.
//
// The Tier 2 LLM, fed only `{seed, radius}`, converges on its favorite
// worlds no matter the seed. Instead of hoping it gets weird, the engine
// rolls a deterministic ARCHETYPE from the planet seed and hands it to the
// LLM as a hard creative constraint. The roll happens client-side at planet
// construction, so terrain parameters (sea level! amplitude!) are known
// before — and independent of — the LLM round-trip.
//
// Distribution is data: "too many ocean worlds" is a weight edit here, not
// a prompt-engineering séance. `standard` keeps ~40% of the sky ordinary so
// archetypes read as discoveries, not a slot machine.
//
// Every roll is seeded by `seed ^ 0xA2C4` — same planet, same archetype,
// same terrain params, same composition, across sessions and devices.

import { mulberry32 } from './Seed.js';

// terrain: { seaLevelQuantile: [lo,hi], ampScale: [lo,hi] } — rolled per
//   planet within the range; omitted → engine defaults (0.42 / 1.0).
// composition: landmarkSlots [lo,hi] (slots beyond the hero), surfaceKinds
//   [lo,hi], openWaterHero (hero slot goes on deep water), heroScale
//   (multiplier on the hero's scale range), densityHint.
// biomes: allowed biome subset passed to the LLM (soft constraint); null = any.
const ARCHETYPES = [
  {
    id: 'standard', weight: 18,
    label: null, spark: null, biomes: null,
    terrain: {}, composition: {},
  },
  {
    id: 'ocean-world', weight: 5,
    label: 'ocean world',
    spark: 'an endless water world — whatever stands here floats, drifts, or wrecked long ago',
    biomes: ['ocean'],
    terrain: { seaLevelQuantile: [0.85, 0.95], ampScale: [0.5, 0.7] },
    composition: { landmarkSlots: [0, 1], surfaceKinds: [1, 2], openWaterHero: true },
  },
  {
    id: 'frozen-ocean', weight: 2,
    label: 'frozen ocean',
    spark: 'a sea that froze mid-swell — everything here is locked in ice that was once water',
    biomes: ['ice'],
    terrain: { seaLevelQuantile: [0.85, 0.95], ampScale: [0.5, 0.7] },
    composition: { landmarkSlots: [0, 1], surfaceKinds: [1, 2], openWaterHero: true },
  },
  {
    id: 'archipelago', weight: 4,
    label: 'archipelago',
    spark: 'a scatter of small islands in a wide sea — every shore is close to another shore',
    biomes: ['ocean', 'forest'],
    terrain: { seaLevelQuantile: [0.65, 0.75], ampScale: [1.1, 1.3] },
    composition: { landmarkSlots: [2, 3] },
  },
  {
    id: 'desert-sea', weight: 4,
    label: 'waterless world',
    spark: 'a world with no water at all — whatever once flowed here left only its shape behind',
    biomes: ['desert', 'gas-stripped'],
    terrain: { seaLevelQuantile: [0, 0], ampScale: [0.7, 0.9] },
    composition: { landmarkSlots: [2, 3] },
  },
  {
    id: 'shipwreck-graveyard', weight: 3,
    label: 'shipwreck graveyard',
    spark: 'a coast that collects ships — wrecks and the things sailors abandoned, nothing seaworthy left',
    biomes: ['ocean'],
    terrain: { seaLevelQuantile: [0.55, 0.7] },
    composition: { landmarkSlots: [1, 2], openWaterHero: true },
  },
  {
    id: 'ruled-by-creatures', weight: 4,
    label: 'ruled by creatures',
    spark: 'a planet that belongs to one animal species — they are everywhere, and everything else here exists at their pleasure',
    biomes: ['forest', 'desert', 'ice'],
    terrain: {},
    composition: { landmarkSlots: [1, 2], creatureBudget: 1.0 },
  },
  {
    id: 'ruin-field', weight: 4,
    label: 'ruin field',
    spark: 'the leftover architecture of a civilization that finished whatever it was doing here',
    biomes: ['desert', 'forest', 'alien'],
    terrain: {},
    composition: { landmarkSlots: [2, 3] },
  },
  {
    id: 'necropolis', weight: 3,
    label: 'necropolis',
    spark: 'a planet used as a burial ground — by whom, for whom, the markers no longer say',
    biomes: ['desert', 'ice', 'alien'],
    terrain: { seaLevelQuantile: [0.1, 0.2] },
    composition: { landmarkSlots: [2, 3] },
  },
  {
    id: 'fortress-world', weight: 3,
    label: 'fortress world',
    spark: 'built to keep something out, or in — walls and towers outlasting whatever they defended against',
    biomes: ['forest', 'ice', 'volcanic'],
    terrain: { ampScale: [1.2, 1.4] },
    composition: { landmarkSlots: [2, 3] },
  },
  {
    id: 'launch-site', weight: 3,
    label: 'abandoned launch site',
    spark: 'a place things left from — pads, gantries, and cargo that never made the last flight',
    biomes: ['alien', 'gas-stripped', 'crystalline'],
    terrain: {},
    composition: { landmarkSlots: [2, 3] },
  },
  {
    id: 'garden-world', weight: 3,
    label: 'garden world',
    spark: 'a tended world — someone planted this on purpose, row by row, and may still be weeding it',
    biomes: ['forest'],
    terrain: { seaLevelQuantile: [0.3, 0.4] },
    composition: { landmarkSlots: [2, 3], densityHint: 'dense' },
  },
  {
    id: 'monolith-world', weight: 2,
    label: 'monolith world',
    spark: 'one colossal thing and nothing else — the planet is a pedestal for it',
    biomes: null,
    terrain: { ampScale: [0.4, 0.6] },
    composition: { landmarkSlots: [0, 0], surfaceKinds: [1, 1], heroScale: 1.6, densityHint: 'sparse' },
  },
  {
    id: 'overgrown-world', weight: 3,
    label: 'overgrown world',
    spark: 'growth that won — whatever else this world was, the forest is digesting it',
    biomes: ['forest'],
    terrain: {},
    composition: { landmarkSlots: [2, 3], densityHint: 'dense' },
  },
];

// Prompt-only modifiers (~25% of planets get one). No engine semantics —
// they just push the LLM's interpretation sideways. Cheap variety.
const TWISTS = [
  'everything here is oversized, built for something much larger',
  'recently abandoned — whoever was here left in a hurry',
  'everything glows faintly, as if lit from inside',
  'split by a single enormous canyon',
  'half of it is always in shadow',
  'arranged with unsettling symmetry',
  'older than it should be — worn down past its design',
  'in the middle of being reclaimed by the terrain',
];

const TOTAL_WEIGHT = ARCHETYPES.reduce((s, a) => s + a.weight, 0);

const rollRange = (rand, range, fallback) =>
  range ? range[0] + (range[1] - range[0]) * rand() : fallback;
const rollInt = (rand, range, fallback) =>
  range ? Math.round(rollRange(rand, range)) : fallback;

/**
 * Deterministic archetype roll for a planet seed. Returns a fully-resolved
 * instance (ranges already rolled to concrete numbers):
 *
 *   {
 *     id, label, spark,                 // spark includes the twist, if any
 *     terrain: { seaLevelQuantile, ampScale },
 *     composition: { landmarkSlots, surfaceKinds, openWaterHero, heroScale, densityHint },
 *     llmContext,                       // compact object for /tier2/direct context
 *   }
 */
export function rollArchetype(seed) {
  const rand = mulberry32((seed ^ 0xA2C4) >>> 0);

  let pick = ARCHETYPES[0];
  let roll = rand() * TOTAL_WEIGHT;
  for (const a of ARCHETYPES) {
    roll -= a.weight;
    if (roll <= 0) { pick = a; break; }
  }

  const twist = rand() < 0.25 ? TWISTS[Math.floor(rand() * TWISTS.length)] : null;
  const spark = pick.spark
    ? (twist ? `${pick.spark}; ${twist}` : pick.spark)
    : (twist || null);

  const terrain = {
    seaLevelQuantile: rollRange(rand, pick.terrain.seaLevelQuantile, 0.42),
    ampScale: rollRange(rand, pick.terrain.ampScale, 1.0),
  };
  const composition = {
    landmarkSlots: rollInt(rand, pick.composition.landmarkSlots, 4),
    surfaceKinds: rollInt(rand, pick.composition.surfaceKinds, 2),
    openWaterHero: !!pick.composition.openWaterHero,
    heroScale: pick.composition.heroScale ?? 1.0,
    densityHint: pick.composition.densityHint ?? null,
    // Creature scatter budget as a fraction of a full surface-asset budget.
    // Worlds with incidental wildlife get a handful; ruled-by-creatures
    // gets the full herd.
    creatureBudget: pick.composition.creatureBudget ?? 0.35,
  };

  return {
    id: pick.id,
    label: pick.label,
    spark,
    biomes: pick.biomes,
    terrain,
    composition,
    // Compact context for the worker; hashContext folds it into the KV
    // cache key, so archetype changes roll out without manual invalidation.
    llmContext: {
      id: pick.id,
      label: pick.label,
      spark,
      biomes: pick.biomes,
      landmark_slots: composition.landmarkSlots,
      density_hint: composition.densityHint,
    },
  };
}

/** Dev hook: archetype distribution over n sequential seeds. */
export function rollStats(n = 1000) {
  const counts = {};
  for (let i = 0; i < n; i++) {
    const a = rollArchetype(i * 2654435761 >>> 0);
    counts[a.id] = (counts[a.id] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}
