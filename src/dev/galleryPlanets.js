// The fixed bench planets: forced-concept parameter sets that build the same
// planet every time, with no worker and no LLM.
//
// Used by the seed gallery (tests/e2e/gallery.spec.js → ?placementLab=1) and
// the look lab (?lookLab=1). Each `q` is exactly the placement lab's query
// string (see src/dev/PlacementLab.js for the keys).
//
// Keep the list STABLE — change an entry only on purpose, and rename its
// `file` when you do, so before/after gallery pairs stay comparable.
//
// Spread across landform, sea level, motif, tier, biome and hero pack. The
// first five echo the Phase 14 reference planets (the quality bar in
// docs/plans/2026-06-10-003-…-phase-14-concept-spine-plan.md); `teaser` is
// that planet's one-line hook.

export const GALLERY_PLANETS = [
  {
    file: '01-quiet-forest-rolling-uniform-lean-pines',
    short: 'Bent pines',
    teaser: 'pines here, and a wind that bent every one of them the same way',
    q: {
      seed: 101, biome: 'forest', tier: 'quiet', sea: 0.42, amp: 1.0, shape: 'rolling', pattern: 'none',
      motif: 'uniform-lean', subjects: 'surface', slots: 3, density: 'medium',
      hero: 'kenney:castle:tower-square-top-roof',
      landmarks: 'quaternius:ruins:Column_Round,kenney:nature:cliff_large_rock',
      surface: 'quaternius:nature:PineTree_1,quaternius:nature:BirchTree_2',
    },
  },
  {
    file: '02-notable-forest-one-mountain-foxes-facing-statue',
    short: 'Fox statue',
    teaser: 'the foxes keep a statue of a fox',
    q: {
      seed: 202, biome: 'forest', tier: 'notable', sea: 0.42, amp: 1.0, shape: 'one-mountain', pattern: 'spots',
      motif: 'all-facing-point', subjects: 'creatures', slots: 2, density: 'medium', creatures_budget: 1.0,
      hero: 'quaternius:ruins:Statue_Fox',
      landmarks: 'quaternius:ruins:Column_Round_Short,quaternius:ruins:Wall_ArchRound_Overgrown',
      surface: 'quaternius:nature:Bush_Flowers,quaternius:nature:Grass_Large',
      creatures: 'quaternius:animals:Fox',
    },
  },
  {
    file: '03-notable-ocean-terraced-sea60-grid-rows-watermill',
    short: 'Drowned orchard',
    teaser: 'an orchard in perfect rows; the sea took the back half',
    q: {
      seed: 303, biome: 'ocean', tier: 'notable', sea: 0.6, amp: 1.0, shape: 'terraced', pattern: 'rows',
      motif: 'grid-rows', subjects: 'surface', slots: 2, density: 'medium',
      hero: 'kenney:fantasy_town:watermill',
      landmarks: 'kenney:fantasy_town:fountain-center',
      surface: 'kenney:nature:crops_cornStageD,quaternius:nature:PalmTree_1',
    },
  },
  {
    file: '04-notable-desert-mesas-graves-facing-crypt',
    short: 'Graves and a door',
    teaser: 'a thousand graves, and every one of them faces the same door',
    q: {
      seed: 404, biome: 'desert', tier: 'notable', sea: 0.15, amp: 0.9, shape: 'mesas', pattern: 'patchwork',
      motif: 'all-facing-point', subjects: 'surface', slots: 2, density: 'dense',
      hero: 'kenney:graveyard:crypt-large',
      landmarks: 'kenney:graveyard:lightpost-double,kenney:graveyard:pillar-obelisk',
      surface: 'kenney:graveyard:gravestone-cross,kenney:graveyard:gravestone-round',
    },
  },
  {
    file: '05-singular-desert-dunes-nosea-fleet-shared-heading',
    short: 'Fleet, no sea',
    teaser: 'a fleet at anchor on a world with no sea',
    q: {
      seed: 505, biome: 'desert', tier: 'singular', sea: 0, amp: 0.8, shape: 'dunes', pattern: 'stripes',
      motif: 'shared-heading', subjects: 'landmarks', embed: 0.4, slots: 3, density: 'sparse',
      hero: 'kenney:pirate:ship-wreck',
      landmarks: 'kenney:pirate:ship-large,kenney:pirate:ship-medium,kenney:pirate:ship-small',
      surface: 'kenney:space:bones,quaternius:nature:DeadTree_3',
    },
  },
  {
    file: '06-quiet-ocean-archipelago-sea70-watchtower',
    short: 'Watchtower isles',
    q: {
      seed: 606, biome: 'ocean', tier: 'quiet', sea: 0.7, amp: 1.2, shape: 'archipelago', pattern: 'none',
      motif: 'none', slots: 2, density: 'medium',
      hero: 'kenney:pirate:tower-watch',
      landmarks: 'kenney:pirate:tower-middle',
      surface: 'kenney:pirate:palm-straight,kenney:pirate:palm-bend',
    },
  },
  {
    file: '07-notable-alien-crater-procession-lander',
    short: 'Crater lander',
    q: {
      seed: 707, biome: 'alien', tier: 'notable', sea: 0, amp: 1.1, shape: 'crater', pattern: 'rings',
      motif: 'procession', subjects: 'surface', slots: 3, density: 'medium',
      hero: 'kaykit:space_base:lander_A',
      landmarks: 'kaykit:space_base:windturbine_tall,quaternius:space:SolarPanel_Ground,kaykit:space_base:lights',
      surface: 'quaternius:space:Tree_Spikes_1,kaykit:space_base:cargo_A',
    },
  },
  {
    file: '08-singular-crystalline-spires-hangar',
    short: 'Crystal hangar',
    q: {
      seed: 808, biome: 'crystalline', tier: 'singular', sea: 0.3, amp: 1.4, shape: 'spires', pattern: 'veins',
      motif: 'none', slots: 4, density: 'dense',
      hero: 'kenney:space:hangar_largeA',
      landmarks: 'kenney:castle:tower-hexagon-roof,quaternius:space:House_Cylinder,quaternius:ruins:Arch_Gothic',
      surface: 'kenney:space:rock_crystalsLargeA,quaternius:space:Plant_2',
    },
  },
];

/** The five Phase 14 reference planets (the look lab's subjects). */
export const REFERENCE_PLANETS = GALLERY_PLANETS.slice(0, 5);
