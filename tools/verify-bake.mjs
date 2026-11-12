#!/usr/bin/env node
// Verify the colour bake (tools/bake-colors.mjs) against a snapshot of the
// bundled GLBs from before the bake.
//
//   node tools/verify-bake.mjs <beforeDir> [--colors N] [--pack kenney/pirate]
//
// <beforeDir> mirrors public/assets/bundled (e.g. a `git worktree` or a copy
// taken before re-baking). Checks, per file: same file set; every primitive
// has COLOR_0; no textures / images / TEXCOORD_*; world bbox matches within
// 0.5% of the asset's largest dimension; triangle count not increased and
// not reduced by more than welding can explain (reported); primitive counts
// and byte totals before/after. `--colors N` prints the distinct baked
// colours (sRGB hex, vertex counts) for N assets per pack.

import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getIO, linearToSrgb } from './bake-colors.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AFTER = join(ROOT, 'public/assets/bundled');
const args = process.argv.slice(2);
const BEFORE = args[0];
if (!BEFORE || BEFORE.startsWith('--')) { console.error('usage: node tools/verify-bake.mjs <beforeDir> [--colors N] [--pack creator/pack]'); process.exit(2); }
const nColors = args.includes('--colors') ? parseInt(args[args.indexOf('--colors') + 1], 10) : 0;
const onlyPack = args.includes('--pack') ? args[args.indexOf('--pack') + 1] : null;

function listGlbs(dir) {
  const out = [];
  for (const c of readdirSync(dir)) for (const p of readdirSync(join(dir, c))) {
    for (const f of readdirSync(join(dir, c, p))) if (f.endsWith('.glb')) out.push(`${c}/${p}/${f}`);
  }
  return out.sort();
}

async function stats(io, path) {
  // Bundled "before" Kenney colormap files reference a texture that doesn't
  // exist; readAsJSON (non-strict) tolerates that.
  const doc = await io.readJSON(await io.readAsJSON(path));
  const root = doc.getRoot();
  const scene = root.getDefaultScene() || root.listScenes()[0];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let tris = 0, prims = 0, withColor = 0, uv = 0;
  const colors = new Map();
  const v = [0, 0, 0], c = [0, 0, 0];
  scene.traverse((node) => {
    const mesh = node.getMesh();
    if (!mesh) return;
    const m = node.getWorldMatrix();
    for (const p of mesh.listPrimitives()) {
      prims++;
      const pos = p.getAttribute('POSITION');
      const idx = p.getIndices();
      tris += (idx ? idx.getCount() : pos.getCount()) / 3;
      if (p.listSemantics().some((s) => s.startsWith('TEXCOORD'))) uv++;
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, v);
        const w = [0, 1, 2].map((k) => m[k] * v[0] + m[4 + k] * v[1] + m[8 + k] * v[2] + m[12 + k]);
        for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], w[k]); max[k] = Math.max(max[k], w[k]); }
      }
      const col = p.getAttribute('COLOR_0');
      if (col) {
        withColor++;
        for (let i = 0; i < col.getCount(); i++) {
          col.getElement(i, c);
          const hex = '#' + c.slice(0, 3).map((x) => Math.round(Math.min(1, Math.max(0, linearToSrgb(x))) * 255).toString(16).padStart(2, '0')).join('');
          colors.set(hex, (colors.get(hex) || 0) + 1);
        }
      }
    }
  });
  return {
    min, max, tris, prims, withColor, uv,
    textures: root.listTextures().length, images: root.listTextures().filter((t) => t.getImage()).length,
    materials: root.listMaterials().length,
    draco: root.listExtensionsUsed().some((e) => e.extensionName === 'KHR_draco_mesh_compression'),
    colors,
  };
}

const io = await getIO();
const before = listGlbs(BEFORE), after = listGlbs(AFTER);
const sameSet = before.length === after.length && before.every((f, i) => f === after[i]);
console.log(`file set: before ${before.length}, after ${after.length}, identical: ${sameSet}`);

const totals = { bytesBefore: 0, bytesAfter: 0, primsBefore: 0, primsAfter: 0, trisBefore: 0, trisAfter: 0, noColor: [], bboxFail: [], triChanged: [], texLeft: [], uvLeft: [], defaultGrey: [], notDraco: [], multiPrim: [] };
const perPack = {};
const shownPerPack = {};
for (const f of after) {
  const pack = f.split('/').slice(0, 2).join('/');
  if (onlyPack && pack !== onlyPack) continue;
  const a = await stats(io, join(AFTER, f));
  const b = await stats(io, join(BEFORE, f));
  const bb = statSync(join(BEFORE, f)).size, ab = statSync(join(AFTER, f)).size;
  totals.bytesBefore += bb; totals.bytesAfter += ab;
  totals.primsBefore += b.prims; totals.primsAfter += a.prims;
  totals.trisBefore += b.tris; totals.trisAfter += a.tris;
  const pp = (perPack[pack] ||= { n: 0, bytesBefore: 0, bytesAfter: 0, primsBefore: 0, primsAfter: 0, withColor: 0 });
  pp.n++; pp.bytesBefore += bb; pp.bytesAfter += ab; pp.primsBefore += b.prims; pp.primsAfter += a.prims;
  if (a.withColor === a.prims) pp.withColor++; else totals.noColor.push(f);
  const size = Math.max(...[0, 1, 2].map((k) => b.max[k] - b.min[k]));
  const err = Math.max(...[0, 1, 2].map((k) => Math.max(Math.abs(a.min[k] - b.min[k]), Math.abs(a.max[k] - b.max[k]))));
  if (err > size * 0.005) totals.bboxFail.push(`${f} (err ${(err / size * 100).toFixed(2)}%)`);
  if (a.tris !== b.tris) totals.triChanged.push(`${f} ${b.tris}→${a.tris}`);
  if (a.textures || a.images) totals.texLeft.push(f);
  if (a.uv) totals.uvLeft.push(f);
  if (!a.draco) totals.notDraco.push(f);
  // Blender's unlinked default greys (0.64 → #d0d0d0... in linear-as-sRGB terms
  // the bake would emit #d1d1d1 for 0.64 and #e7e7e7 for 0.8).
  const greyVerts = ['#d1d1d1', '#e7e7e7', '#a3a3a3', '#cccccc'].reduce((n, h) => n + (a.colors.get(h) || 0), 0);
  const allVerts = [...a.colors.values()].reduce((n, x) => n + x, 0);
  if (allVerts && greyVerts / allVerts > 0.5) totals.defaultGrey.push(`${f} (${Math.round(greyVerts / allVerts * 100)}%)`);
  if (a.prims > 1) totals.multiPrim.push(`${f} (${a.prims})`);
  if (nColors && (shownPerPack[pack] || 0) < nColors) {
    shownPerPack[pack] = (shownPerPack[pack] || 0) + 1;
    const top = [...a.colors.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([h, n]) => `${h}×${n}`).join(' ');
    console.log(`  ${f}: ${a.colors.size} colours: ${top}`);
  }
}
console.log('\nper pack:');
for (const [p, s] of Object.entries(perPack)) console.log(`  ${p.padEnd(26)} n=${String(s.n).padStart(3)} COLOR_0=${String(s.withColor).padStart(3)} prims ${s.primsBefore}→${s.primsAfter} bytes ${s.bytesBefore}→${s.bytesAfter}`);
const list = (k) => `${totals[k].length}${totals[k].length ? ': ' + totals[k].slice(0, 40).join(', ') : ''}`;
console.log(`\ntotal bytes ${totals.bytesBefore} → ${totals.bytesAfter}`);
console.log(`primitives ${totals.primsBefore} → ${totals.primsAfter}; triangles ${totals.trisBefore} → ${totals.trisAfter}`);
console.log(`without COLOR_0: ${list('noColor')}`);
console.log(`bbox mismatch (>0.5%): ${list('bboxFail')}`);
console.log(`triangle count changed: ${list('triChanged')}`);
console.log(`textures/images left: ${list('texLeft')}`);
console.log(`TEXCOORD left: ${list('uvLeft')}`);
console.log(`not Draco: ${list('notDraco')}`);
console.log(`mostly Blender default grey: ${list('defaultGrey')}`);
console.log(`more than one primitive: ${list('multiPrim')}`);
