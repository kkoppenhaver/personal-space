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
  return {
    name,
    biome,
    palette,
    atmosphere: 'Thin air, a faint hum.',
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
