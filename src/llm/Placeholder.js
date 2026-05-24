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

export function placeholderTier2(seed) {
  const r = mulberry32((seed ^ 0xa53f) >>> 0);
  const name = `${NAME_SYL_A[Math.floor(r() * NAME_SYL_A.length)]}${NAME_SYL_B[Math.floor(r() * NAME_SYL_B.length)]}`;
  const biome = BIOMES[Math.floor(r() * BIOMES.length)];
  const palette = paletteForBiome(biome, r);
  const hints = hintsForBiome(biome);
  // density picked from the same seed so repeat visits feel deterministic
  const densities = ['sparse', 'medium', 'dense'];
  const density = densities[Math.floor(r() * densities.length)];
  return {
    name,
    biome,
    palette,
    atmosphere: 'Thin air, a faint hum.',
    theme: hints.theme,
    density,
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
