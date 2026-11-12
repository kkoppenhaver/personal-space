// Boot the real game (production bundle, offline mode), prove the loop runs,
// warp to a planet and wait for its concept + visuals, and fail on any
// uncaught page error or unexpected console error.

import { test, expect } from '@playwright/test';
import { armPage } from './guard.js';

test('game boots offline, flies, and mounts a planet without errors', async ({ page }, testInfo) => {
  const guard = await armPage(page);
  // The approach for the planet nearest spawn can start before warpTo, so
  // listen from the first navigation.
  const pickGaveUp = [];
  page.on('console', (m) => {
    if (/\[LLM\] tier2 pick (failed|skipped)/.test(m.text())) pickGaveUp.push(m.text());
  });

  // Returning-visitor path: the welcome modal pauses the loop and gates
  // START on the 22 MB model download.
  await page.addInitScript(() => {
    localStorage.setItem('personalspace:welcome-seen:v1', '1');
  });

  await page.goto('/');
  await page.waitForFunction(() => !!window.__GAME?.plane, null, { timeout: 120_000 });

  // The loop is running: the plane moves over a second of wall time.
  const pos = () => page.evaluate(() => {
    const p = window.__GAME.plane.position();
    return [p.x, p.y, p.z];
  });
  const a = await pos();
  await page.waitForTimeout(1000);
  const b = await pos();
  const moved = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  expect(moved, 'plane should move while the loop runs').toBeGreaterThan(0.5);

  // Drop onto planet 0 of the active system and wait for it to settle:
  // concept applied, Tier 2 (placeholder) words applied, then either its
  // GLB visuals mount, or the pick stage gives up and the planet stays
  // procedural. KNOWN GAP: with the model host blocked, retrieval does not
  // reach its BM25-only mode (AssetRetriever re-awaits the rejected model
  // promise), so today the pick stage fails and nothing mounts in-game.
  // The seed gallery covers the GLB mount path through the placement lab.
  const name = await page.evaluate(() => window.__GAME.warpTo(0, 40));
  expect(name).not.toBe('no such planet');

  await page.waitForFunction(() => !!(window.__GAME.planet?.concept && window.__GAME.planet?.meta),
    null, { timeout: 120_000, polling: 250 });
  const deadline = Date.now() + 120_000;
  let settled = null;
  while (!settled && Date.now() < deadline) {
    const s = await page.evaluate(() => window.__GAME.planet.reveal?.state ?? null);
    if (s && s !== 'LOADING') settled = 'mounted';
    else if (!s && pickGaveUp.length) settled = 'procedural (pick stage gave up)';
    else await page.waitForTimeout(500);
  }
  expect(settled, 'planet visuals settle (mount, or the pick stage gives up)').not.toBeNull();

  const planet = await page.evaluate(() => {
    const p = window.__GAME.planet;
    return {
      name: p.concept?.name || p.meta?.name,
      teaser: p.concept?.teaser,
      tier: p.tier,
      reveal: p.reveal?.state ?? null,
      hero: !!p.heroSlot,
    };
  });
  planet.settled = settled;
  testInfo.annotations.push({ type: 'planet', description: JSON.stringify(planet) });
  console.log('[smoke] planet', planet);

  // Let a few frames of the arrival land, then keep one screenshot.
  await page.waitForTimeout(1500);
  await page.screenshot({ path: testInfo.outputPath('smoke-arrival.png') });

  expect(guard.state.forbidden, 'no request may reach prod / an LLM provider').toEqual([]);
  expect(guard.state.pageErrors, 'uncaught page errors').toEqual([]);
  expect(guard.unexpectedConsoleErrors(), 'console errors outside the allowlist (tests/e2e/guard.js)').toEqual([]);
});
