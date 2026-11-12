// Seed gallery: 8 fixed planets rendered through the placement bench
// (?placementLab, src/dev/PlacementLab.js) in screenshot mode, one PNG each
// in test-results/seed-gallery/. Every visual PR gets the same 8 images
// before and after; CI uploads them as the `seed-gallery` artifact.
//
// Not a pixel-diff test: it asserts only that each render completed without
// page errors. Keep the list STABLE — change an entry only on purpose, and
// rename its file when you do, so before/after pairs stay comparable.

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { armPage } from './guard.js';

const OUT_DIR = path.join('test-results', 'seed-gallery');

// Spread across landform, sea level, motif, tier, biome and hero pack.
// The first five echo the Phase 14 reference planets.
const PLANETS = [
  {
    file: '01-quiet-forest-rolling-uniform-lean-pines',
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
    q: {
      seed: 808, biome: 'crystalline', tier: 'singular', sea: 0.3, amp: 1.4, shape: 'spires', pattern: 'veins',
      motif: 'none', slots: 4, density: 'dense',
      hero: 'kenney:space:hangar_largeA',
      landmarks: 'kenney:castle:tower-hexagon-roof,quaternius:space:House_Cylinder,quaternius:ruins:Arch_Gothic',
      surface: 'kenney:space:rock_crystalsLargeA,quaternius:space:Plant_2',
    },
  },
];

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => fs.mkdirSync(OUT_DIR, { recursive: true }));

for (const { file, q } of PLANETS) {
  test(`seed gallery: ${file}`, async ({ page }) => {
    const guard = await armPage(page);
    const labWarnings = [];
    page.on('console', (m) => { if (/\[placementLab\]/.test(m.text()) && m.type() === 'warning') labWarnings.push(m.text()); });
    const qs = new URLSearchParams({ placementLab: '1', shot: '1', ...q });
    await page.goto(`/?${qs}`);
    await page.waitForFunction(() => window.__LAB_READY === true, null, { timeout: 120_000, polling: 250 });

    const mounted = await page.evaluate(() => ({
      hero: !!window.__LAB.planet.heroSlot,
      reveal: window.__LAB.planet.reveal?.state ?? null,
    }));
    expect(mounted.hero, 'hero GLB mounted').toBe(true);

    await page.locator('#canvas').screenshot({ path: path.join(OUT_DIR, `${file}.png`), animations: 'disabled' });

    expect(labWarnings, 'every catalog id resolves').toEqual([]);
    expect(guard.state.forbidden).toEqual([]);
    expect(guard.state.pageErrors, 'uncaught page errors').toEqual([]);
  });
}
