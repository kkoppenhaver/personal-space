#!/usr/bin/env node
// In-place catalog augmenter — adds the `family` and (optional)
// `scale_override` fields to existing assets in catalog.source.json
// AND catalog.json without re-running the importer or re-embedding.
//
// The augmenter is idempotent: re-running with no changes to
// tools/family.js produces no diff. Use this when you tweak the family
// pattern table or scale-override map and want the catalog to pick up
// the change immediately.
//
// Run: `node tools/augment-catalog.js`

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveFamily, SCALE_OVERRIDES } from './family.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'src/world/assets/catalog.source.json');
const OUTPUT = join(ROOT, 'src/world/assets/catalog.json');

/**
 * Pull the original stem from a catalog id like "kenney:nature:cliff_X".
 * makeId in import-assets.js preserves the original case of the stem.
 */
function stemFromId(id) {
  const parts = id.split(':');
  return parts[parts.length - 1];
}

function augmentAsset(asset) {
  const stem = stemFromId(asset.id);
  const family = resolveFamily(stem);
  const override = SCALE_OVERRIDES[asset.id];
  // Preserve key order roughly: family next to role; scale_override next to scale_range.
  const out = { ...asset, family };
  if (override) out.scale_override = override;
  else delete out.scale_override; // clean stale overrides if removed from the map
  return out;
}

async function augmentFile(path, label) {
  if (!existsSync(path)) {
    console.log(`[augment-catalog] ${label}: not found, skipping (${path})`);
    return;
  }
  const data = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(data.assets)) {
    console.warn(`[augment-catalog] ${label}: no assets array, skipping`);
    return;
  }
  let touched = 0;
  data.assets = data.assets.map((a) => {
    const updated = augmentAsset(a);
    if (updated.family !== a.family || JSON.stringify(updated.scale_override) !== JSON.stringify(a.scale_override)) {
      touched++;
    }
    return updated;
  });
  await writeFile(path, JSON.stringify(data, null, 2) + '\n');
  console.log(`[augment-catalog] ${label}: ${data.assets.length} assets, ${touched} touched (${path})`);
}

await augmentFile(SOURCE, 'catalog.source.json');
await augmentFile(OUTPUT, 'catalog.json');
console.log('[augment-catalog] done.');
