#!/usr/bin/env node
// Build-time embedding pre-compute.
//
// Reads src/world/assets/catalog.source.json (hand-curated metadata for each
// bundled CC0 asset) and emits src/world/assets/catalog.json with the same
// shape plus a 384-dim MiniLM embedding per asset. Runtime hybrid retrieval
// (Phase 2) uses these embeddings for semantic similarity.
//
// CRITICAL — must match runtime model exactly: same model name, same dtype
// (q8), same pooling (mean), same normalize (true). Mismatch produces
// silent drift in cosine scores. Phase 2 boot does a sanity-check
// re-embed of one known item and asserts cosine > 0.98 vs stored.
//
// Run: `npm run build:catalog`

import { readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(root, 'src/world/assets/catalog.source.json');
const OUTPUT = join(root, 'src/world/assets/catalog.json');

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const DTYPE = 'q8';
const DIM = 384;

async function writeEmpty() {
  await writeFile(OUTPUT, JSON.stringify({
    version: 1,
    generated_at: new Date().toISOString(),
    model: MODEL, dtype: DTYPE, dim: DIM,
    assets: [],
  }, null, 2) + '\n');
  console.log(`[embed-catalog] wrote ${OUTPUT} (0 assets).`);
}

if (!existsSync(SOURCE)) {
  console.log(`[embed-catalog] no ${SOURCE} yet — emitting empty catalog.`);
  await writeEmpty();
  process.exit(0);
}

const source = JSON.parse(await readFile(SOURCE, 'utf8'));
if (!Array.isArray(source.assets)) {
  console.error(`[embed-catalog] ${SOURCE} must have an "assets" array.`);
  process.exit(1);
}

if (source.assets.length === 0) {
  console.log(`[embed-catalog] catalog.source.json has 0 assets — skipping model load.`);
  await writeEmpty();
  process.exit(0);
}

console.log(`[embed-catalog] loading model ${MODEL} (${DTYPE})...`);
const t0 = Date.now();
const { pipeline } = await import('@huggingface/transformers');
const embedder = await pipeline('feature-extraction', MODEL, { dtype: DTYPE });
console.log(`[embed-catalog] model ready (${Date.now() - t0} ms).`);

console.log(`[embed-catalog] embedding ${source.assets.length} assets...`);
const out = [];
for (const asset of source.assets) {
  const text = textForAsset(asset);
  const t = Date.now();
  const v = await embedder(text, { pooling: 'mean', normalize: true });
  if (v.dims?.at(-1) !== DIM) {
    console.error(`[embed-catalog] unexpected dim ${v.dims?.at(-1)} for ${asset.id}`);
    process.exit(1);
  }
  out.push({ ...asset, embedding: Array.from(v.data) });
  console.log(`  ${asset.id}  (${Date.now() - t} ms)`);
}

const payload = {
  version: 1,
  generated_at: new Date().toISOString(),
  model: MODEL, dtype: DTYPE, dim: DIM,
  assets: out,
};
await writeFile(OUTPUT, JSON.stringify(payload, null, 2) + '\n');
const size = (await stat(OUTPUT)).size;
console.log(`[embed-catalog] wrote ${OUTPUT} (${out.length} assets, ${(size / 1024).toFixed(1)} KB).`);

/**
 * Text used as input to the embedder. Order matters — name first (cheapest
 * tokens, anchors the vector), then a flat join of tags / biome / theme
 * affinities. This shape is what the runtime query is shaped against too.
 */
function textForAsset(a) {
  return [
    a.name || a.id,
    (a.tags || []).join(' '),
    (a.biome_affinity || []).join(' '),
    (a.theme_affinity || []).join(' '),
  ].filter(Boolean).join(' | ');
}
