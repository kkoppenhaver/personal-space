// Look lab (?lookLab=1, src/dev/LookLab.js): every look in
// src/render/Looks.js must draw without a shader or page error.
//
// It also writes the comparison sheet: one PNG per planet × view × look,
// plus index.html laying them out side by side.
//   CI / npm run test:e2e   the first reference planet, 8 images, in
//                           test-results/look-lab/ (CI artifact `look-lab`)
//   npm run look:sheet      all five reference planets, 40 images, in
//                           look-sheet/ — outside test-results/, which
//                           Playwright empties at the start of every run

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { armPage } from './guard.js';
import { REFERENCE_PLANETS } from '../../src/dev/galleryPlanets.js';
import { LOOKS, LOOK_ORDER } from '../../src/render/Looks.js';

const FULL = !!process.env.LOOK_SHEET;
const OUT_DIR = FULL ? 'look-sheet' : path.join('test-results', 'look-lab');
const PLANETS = FULL ? REFERENCE_PLANETS.map((_, i) => i) : [0];
const VIEWS = [
  { id: 'wide', label: 'Whole planet' },
  { id: 'photo', label: 'Photo of the hero' },
];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function sheetHtml() {
  const head = LOOK_ORDER.map((id, i) => `
      <div class="look"><b>${i + 1}. ${esc(LOOKS[id].name)}</b><span>${esc(LOOKS[id].blurb)}</span></div>`).join('');
  const rows = PLANETS.flatMap((p) => VIEWS.map((v) => `
    <div class="label"><b>${esc(REFERENCE_PLANETS[p].short)}</b><span>${esc(v.label)}</span><i>“${esc(REFERENCE_PLANETS[p].teaser)}”</i></div>${
  LOOK_ORDER.map((id) => `
    <a href="p${p}-${v.id}-${id}.png" target="_blank"><img loading="lazy" src="p${p}-${v.id}-${id}.png" alt="${esc(REFERENCE_PLANETS[p].short)}, ${esc(v.label)}, ${esc(LOOKS[id].name)}"></a>`).join('')}`)).join('');
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Look lab sheet — Personal Space</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0d0e16; color: #ece8df; font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  header { padding: 20px 24px 8px; max-width: 900px; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  header p { margin: 0 0 6px; opacity: 0.75; }
  .grid { display: grid; grid-template-columns: 150px repeat(${LOOK_ORDER.length}, minmax(0, 1fr)); gap: 8px; padding: 8px 24px 40px; align-items: start; }
  .head { position: sticky; top: 0; z-index: 2; display: contents; }
  .look, .corner { position: sticky; top: 0; z-index: 2; background: #0d0e16; padding: 10px 0 8px; }
  .look b { display: block; font-size: 15px; }
  .look span { display: block; opacity: 0.65; font-size: 12px; }
  .label { padding-top: 4px; }
  .label b, .label span, .label i { display: block; }
  .label span { opacity: 0.7; font-size: 12px; }
  .label i { opacity: 0.5; font-size: 12px; margin-top: 6px; }
  a { display: block; border-radius: 6px; overflow: hidden; outline: 1px solid rgba(255,255,255,0.08); }
  a:hover { outline-color: #ffd7a6; }
  img { display: block; width: 100%; height: auto; }
  @media (max-width: 900px) { .grid { grid-template-columns: 90px repeat(${LOOK_ORDER.length}, minmax(0, 1fr)); padding: 8px; gap: 4px; } .look span, .label i { display: none; } }
</style>
<header>
  <h1>Look lab sheet</h1>
  <p>Each row is one reference planet and one view. Each column is a look. Click an image for full size.</p>
  <p>To move the camera yourself, run the game locally and open <code>?lookLab=1</code>.</p>
</header>
<div class="grid">
  <div class="corner"></div>${head}${rows}
</div>
</html>
`;
}

test('look lab: every look draws', async ({ page }) => {
  // Software rendering: about ten seconds a frame with the full pipeline on
  // a fast laptop, and CI runners are roughly three times slower.
  test.setTimeout(FULL ? 1_200_000 : 600_000);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const guard = await armPage(page);

  await page.goto(`/?lookLab=1&shot=1&look=${LOOK_ORDER[0]}&planet=${PLANETS[0]}&view=${VIEWS[0].id}`);
  await page.waitForFunction(() => window.__LAB_READY === true, null, { timeout: 180_000, polling: 250 });

  for (const planet of PLANETS) {
    for (const view of VIEWS) {
      for (const look of LOOK_ORDER) {
        const drawn = await page.evaluate(async (s) => {
          await window.__LOOKLAB.set(s);
          const L = window.__LOOKLAB;
          return { ...L.state, hero: !!L.stages.get(s.planet)?.planet.heroSlot };
        }, { look, planet, view: view.id });
        expect(drawn, 'the lab is showing what was asked for').toMatchObject({ look, planet, view: view.id, hero: true });
        await page.locator('#canvas').screenshot({ path: path.join(OUT_DIR, `p${planet}-${view.id}-${look}.png`), animations: 'disabled' });
      }
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), sheetHtml());

  expect(guard.state.forbidden).toEqual([]);
  expect(guard.state.pageErrors, 'uncaught page errors').toEqual([]);
  expect(guard.unexpectedConsoleErrors(), 'console errors (a shader that fails to compile lands here)').toEqual([]);
});
