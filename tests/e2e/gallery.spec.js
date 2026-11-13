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
import { GALLERY_PLANETS } from '../../src/dev/galleryPlanets.js';

const OUT_DIR = path.join('test-results', 'seed-gallery');

// The list lives in src/dev/galleryPlanets.js (the look lab shares it).
const PLANETS = GALLERY_PLANETS;

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
