// Deterministic offline fallback — never blank.

import { mulberry32 } from '../world/Seed.js';

const TEASERS = [
  'a world of vertical oceans',
  'a planet that hums at dusk',
  'a place where shadows pool like water',
  'a desert that keeps the wind',
  'a forest of silent bells',
  'a sphere of polished glass',
  'a planet where everything is salt',
  'a world that remembers visitors',
  'a place of long, low songs',
  'a planet of thin, blue light',
];

const BIOMES = ['desert','ocean','forest','ice','volcanic','crystalline','alien'];

const NAME_SYL_A = ['Vor','Thal','Sil','Kel','Bren','Ash','Mor','Lir','Tyr','Cal','Quen','Drev','Aer','Pir','Ulm'];
const NAME_SYL_B = ['en','os','ar','ith','um','iel','an','ord','ux','eth','iri','un','ai','onth'];

export function placeholderTier1(seed) {
  const r = mulberry32(seed >>> 0);
  return { teaser: TEASERS[Math.floor(r() * TEASERS.length)] };
}

// Deterministic offline concepts (Phase 14a). A small rotation of premade
// premises — including the five reference planets from the Phase 14 plan —
// so dev mode (no worker) exercises the full spine: teaser on the ping,
// terrain override, concept-constrained Tier 2, lore against the question.
const CONCEPTS = {
  quiet: [
    { teaser: 'pines here, and a wind that bent every one of them the same way',
      premise: 'A forest world where every tree leans the same few degrees toward sunrise, as if the wind only ever blew once, hard.',
      question: 'what bent them?',
      biome: 'forest', terrain: { sea_level: 0.42, amplitude: 1.0 },
      landmark_slots: 3, hero_on_water: false, creature_budget: 0, density: 'medium',
      motif: { kind: 'uniform-lean', subjects: 'surface' },
      asset_keywords: ['pine trees', 'birch trees', 'mossy rocks'] },
    { teaser: 'somebody stacked every rock on this planet, once',
      premise: 'A bare world where the loose stones sit in tidy piles, long enough ago that moss has opinions about it.',
      question: 'who counts rocks?',
      biome: 'gas-stripped', terrain: { sea_level: 0.2, amplitude: 0.9 },
      landmark_slots: 2, hero_on_water: false, creature_budget: 0, density: 'sparse',
      motif: { kind: 'none', subjects: 'surface' },
      asset_keywords: ['stacked stones', 'small rocks', 'dead grass'] },
    { teaser: 'an ordinary green world except all the flowers face away from the sun',
      premise: 'A mild meadow planet whose flowers all turn their backs to the light, every one of them, like a grudge.',
      question: 'what are they looking at instead?',
      biome: 'forest', terrain: { sea_level: 0.4, amplitude: 1.0 },
      landmark_slots: 3, hero_on_water: false, creature_budget: 0.35, density: 'dense',
      motif: { kind: 'uniform-lean', subjects: 'surface' },
      asset_keywords: ['flowers', 'grass clumps', 'bushes', 'deer'] },
  ],
  notable: [
    { teaser: 'a thousand graves, and every one of them faces the same door',
      premise: 'A dry burial world where every gravestone, no two alike, faces a single crypt on the hill; lamp posts make two lines up to its door.',
      question: 'what walks between the lamps at night?',
      biome: 'desert', terrain: { sea_level: 0.15, amplitude: 0.9 },
      landmark_slots: 2, hero_on_water: false, creature_budget: 0, density: 'dense',
      motif: { kind: 'all-facing-point', subjects: 'surface' },
      asset_keywords: ['gravestones', 'crypt', 'lamp posts', 'crooked pines'] },
    { teaser: 'the foxes keep a statue of a fox',
      premise: 'Ruins overrun by foxes, and at the center a stone fox four times life size, worn smooth at the base. Nothing else here is carved.',
      question: 'who carved it — and why only the one?',
      biome: 'forest', terrain: { sea_level: 0.42, amplitude: 1.0 },
      landmark_slots: 2, hero_on_water: false, creature_budget: 1.0, density: 'medium',
      motif: { kind: 'all-facing-point', subjects: 'creatures' },
      asset_keywords: ['fox statue', 'broken columns', 'overgrown walls', 'foxes'] },
    { teaser: 'an orchard in perfect rows; the sea took the back half',
      premise: 'Crops planted in measured rows that run straight at the shore and keep going in — stalk tops still visible in the shallows.',
      question: 'where did the waterline used to be?',
      biome: 'ocean', terrain: { sea_level: 0.6, amplitude: 1.0 },
      landmark_slots: 2, hero_on_water: false, creature_budget: 0, density: 'medium',
      motif: { kind: 'grid-rows', subjects: 'surface' },
      asset_keywords: ['corn crops in rows', 'palm trees', 'watermill', 'fountain'] },
  ],
  singular: [
    { teaser: 'a fleet at anchor on a world with no sea',
      premise: 'Eight sailing ships sit hull-down in the dunes of a waterless world, bows all on one heading, sails still rigged for a wind going nowhere.',
      question: 'where did the sea go — or did they ever sail at all?',
      biome: 'desert', terrain: { sea_level: 0, amplitude: 0.8 },
      landmark_slots: 3, hero_on_water: false, creature_budget: 0, density: 'sparse',
      motif: { kind: 'shared-heading', subjects: 'landmarks' }, embed_bias: 0.4,
      asset_keywords: ['shipwreck sailing ships', 'bones', 'dead trees'] },
    { teaser: 'one tower, and the ten thousand stones that almost made it taller',
      premise: 'A single colossal tower on an empty world, ringed by neat piles of cut stone that never made it up — abandoned one course from done.',
      question: 'what made them stop?',
      biome: 'ice', terrain: { sea_level: 0.1, amplitude: 0.5 },
      landmark_slots: 0, hero_on_water: false, creature_budget: 0, density: 'sparse',
      motif: { kind: 'none', subjects: 'surface' },
      asset_keywords: ['colossal tower', 'cut stone blocks', 'stone piles'] },
  ],
};

export function placeholderConcept(seed, context = {}) {
  const r = mulberry32((seed ^ 0xC0CE) >>> 0);
  const tier = context?.tier && CONCEPTS[context.tier] ? context.tier : 'quiet';
  const pool = CONCEPTS[tier];
  return { ...pool[Math.floor(r() * pool.length)] };
}

export function placeholderTier2(seed, context = {}) {
  const r = mulberry32((seed ^ 0xa53f) >>> 0);
  const name = `${NAME_SYL_A[Math.floor(r() * NAME_SYL_A.length)]}${NAME_SYL_B[Math.floor(r() * NAME_SYL_B.length)]}`;
  // Concept-aware (Phase 14a): elaborate the spine when present — biome,
  // density, and retrieval hints all derive from the premise the player
  // navigated by. Falls back to biome-table behavior for legacy callers.
  // Spread-copy: the per-keyword overrides below must not mutate the table.
  const concept = context?.concept || null;
  const biome = concept?.biome || BIOMES[Math.floor(r() * BIOMES.length)];
  const palette = paletteForBiome(biome, r);
  const hints = { ...hintsForBiome(biome) };
  if (concept?.asset_keywords?.length) {
    const kw = concept.asset_keywords;
    hints.hero = [kw[0]];
    hints.landmark = kw.slice(1).length ? kw.slice(1) : hints.landmark;
    hints.surface = kw.slice(1).length ? kw.slice(1) : hints.surface;
  }
  const densities = ['sparse', 'medium', 'dense'];
  const density = concept?.density || densities[Math.floor(r() * densities.length)];
  return {
    name,
    biome,
    palette,
    atmosphere: 'Thin air, a faint hum.',
    theme: concept?.teaser?.split(',')[0]?.slice(0, 40) || hints.theme,
    density,
    ...(concept?.creature_budget > 0 ? { inhabitant_hints: [concept.asset_keywords?.find((k) => /fox|deer|wolf|husky|animal|sheep|pig|cow|herd/i.test(k)) || 'wild animals'] } : {}),
    hero_landmark_hints:    hints.hero,
    landmark_anchor_hints:  hints.landmark,
    surface_feature_hints:  hints.surface,
    landmarks: [
      { slotId: 0, kind: 'peak',  name: `${name} Spire` },
      { slotId: 1, kind: 'peak',  name: 'The Knuckle' },
      { slotId: 2, kind: 'peak',  name: 'Quiet Tooth' },
      { slotId: 3, kind: 'peak',  name: 'Westmark' },
      { slotId: 4, kind: 'peak',  name: 'Old Crown' },
      { slotId: 5, kind: 'basin', name: 'The Hollow' },
    ],
  };
}

export function placeholderTier3(seed) {
  return {
    surfaceLore: 'The surface is quieter than expected. Strange how a place can feel deserted and watched at the same time.',
    landmarkLore: [],
  };
}

// Per-biome retrieval hints. These mirror what the real Tier 2 LLM would
// emit — short prose phrases the BM25 + dense retrievers tokenize against
// the catalog. Without these the dev-mode placeholder path would never
// reach `/tier2/pick` and no GLBs would mount on planets.
function hintsForBiome(biome) {
  const table = {
    desert: {
      theme: 'arid weathered ruin',
      hero:     ['towering sandstone monolith on a dune', 'lone obelisk silhouetted against the sky'],
      landmark: ['weathered stone pillars', 'half-buried ruins', 'broken arches and columns'],
      surface:  ['scattered cacti and dune grass', 'small wind-carved rocks', 'sand-burnt skulls and bones'],
    },
    ocean: {
      theme: 'coastal tropical maritime',
      hero:     ['tall lighthouse on a rocky cliff', 'weathered watch tower above the surf'],
      landmark: ['palm trees clustered on a beach', 'fountains and stone pillars', 'docks and weathered structures'],
      surface:  ['palm trees and beach rocks', 'tropical bushes and grass', 'small coastal stones'],
    },
    forest: {
      theme: 'lush temperate overgrown',
      hero:     ['ancient overgrown tower in deep woods', 'massive ruined arch wrapped in vines'],
      landmark: ['stone pillars and broken columns', 'old watermill by a river', 'fantasy fountains'],
      surface:  ['pine and birch trees and undergrowth', 'mushrooms and ferns and bushes', 'mossy rocks and grass clumps'],
    },
    ice: {
      theme: 'frozen alpine bleak',
      hero:     ['frozen spire of jagged ice', 'tall column of glacier-blue crystal'],
      landmark: ['ice-cracked pillars', 'frost-covered ruins', 'tall pine spires in deep snow'],
      surface:  ['spruce and bare birch trees in snow', 'ice rocks and frozen grass', 'icy stones and dead trees'],
    },
    volcanic: {
      theme: 'molten cracked harsh',
      hero:     ['obsidian monolith glowing from within', 'tall spike of cooled lava'],
      landmark: ['lava-cracked pillars', 'broken columns on scorched ground', 'craters and meteor scars'],
      surface:  ['spike trees and toxic lava plants', 'glowing magma rocks', 'burnt dead trees and ash'],
    },
    crystalline: {
      theme: 'cosmic prismatic alien',
      hero:     ['giant crystal formation reaching to the sky', 'tall alien planet hanging in mid-air'],
      landmark: ['crystal pillars and shards', 'mounted satellite antennae', 'tall alien towers'],
      surface:  ['scattered crystals and alien plants', 'small glowing crystal clusters', 'alien rocks and toxic flora'],
    },
    alien: {
      theme: 'alien sci-fi industrial',
      hero:     ['towering alien structure with antennae', 'tall satellite-mounted tower', 'massive abandoned lander'],
      landmark: ['turrets and machine arrays', 'satellite dishes and broken antennae', 'mining terrain platforms'],
      surface:  ['alien rocks and crystal flora', 'scattered cargo crates and stones', 'spike trees and toxic plants'],
    },
  };
  return table[biome] || table.alien;
}

function paletteForBiome(biome, r) {
  const palettes = {
    desert:      { water: '#3d6c8c', low: '#c2a26a', mid: '#9c7547', high: '#6e4a2c', snow: '#f5edd6', sky: '#d8c89c' },
    ocean:       { water: '#1a4e7a', low: '#46a89a', mid: '#3a7563', high: '#2c4f43', snow: '#e8f4f1', sky: '#8fcadf' },
    forest:      { water: '#214b6e', low: '#3a7a3a', mid: '#557a3b', high: '#4a5a2d', snow: '#f1efde', sky: '#9bc9c8' },
    ice:         { water: '#4a7da0', low: '#cdd9e0', mid: '#94aabb', high: '#5e7689', snow: '#ffffff', sky: '#bcd6e4' },
    volcanic:    { water: '#3a2b30', low: '#7e3a2a', mid: '#552520', high: '#2e1a18', snow: '#d6c2b5', sky: '#d97554' },
    crystalline: { water: '#5a3f7a', low: '#a98bc8', mid: '#7d5fa2', high: '#4d3672', snow: '#f3e8ff', sky: '#c3a8e0' },
    alien:       { water: '#1f6064', low: '#5cb6a0', mid: '#3f8e80', high: '#274a4c', snow: '#dbf3ec', sky: '#90d1c5' },
  };
  return palettes[biome] || palettes.alien;
}
