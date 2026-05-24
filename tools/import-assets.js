#!/usr/bin/env node
// Catalog importer — converts the raw mirror at ~/code/3d-modles/assets into:
//   - src/world/assets/bundled/<creator>/<pack>/*.glb (Draco + WebP compressed)
//   - src/world/assets/catalog.source.json (metadata, no embeddings yet)
//
// After running this, run `npm run build:catalog` to compute embeddings.
//
// Idempotent: re-running is safe. Compression is skipped for files whose
// destination already exists. The catalog.source.json is rewritten each run
// so allowlist tweaks take effect.
//
// Usage:
//   node tools/import-assets.js          # full run
//   node tools/import-assets.js --dry    # plan only, no copies/compression
//   node tools/import-assets.js --no-opt # skip gltf-transform pass

import { existsSync, statSync } from 'node:fs';
import { mkdir, copyFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join, dirname, basename, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { resolveFamily, SCALE_OVERRIDES } from './family.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = join(homedir(), 'code/3d-modles/assets');
// GLBs land in public/ so Vite serves them at /assets/bundled/... at runtime.
// catalog.source.json + catalog.json stay under src/world/assets/ because
// they're imported by JS modules (not served as static files).
const DEST_ROOT = join(ROOT, 'public/assets/bundled');
const CATALOG_SOURCE_PATH = join(ROOT, 'src/world/assets/catalog.source.json');
const PUBLIC_URL_PREFIX = '/assets/bundled';

const DRY = process.argv.includes('--dry');
const NO_OPT = process.argv.includes('--no-opt');

// ────────────────────────────────────────────────────────────────────────
// Biome strings MUST match the LLM's /tier2/direct enum verbatim:
//   desert | ocean | forest | ice | volcanic | crystalline | gas-stripped | alien
//
// AssetRetriever filters with strict `.includes(biomeAffinity)`, so any
// catalog string outside the enum is dead weight — the LLM will never
// retrieve it. Theme strings are free-form (no enum) so we keep semantic
// labels there for richer BM25/dense matching.
// ────────────────────────────────────────────────────────────────────────

const LLM_BIOMES = ['desert','ocean','forest','ice','volcanic','crystalline','gas-stripped','alien'];

// `family` derivation + `SCALE_OVERRIDES` are exported from tools/family.js
// so the in-place augmenter (tools/augment-catalog.js) can apply them to an
// existing catalog without re-importing source assets.

// ────────────────────────────────────────────────────────────────────────
// Per-filename biome refinement. First match wins; REPLACES the kit
// default. Lets us promote a `PalmTree` out of the kit's "forest" default
// into `ocean` (tropical), or a `DeadTree` into `desert`/`gas-stripped`.
//
// Pattern order matters — list more specific patterns first.
// ────────────────────────────────────────────────────────────────────────

const BIOME_OVERRIDES = [
  // ── Sci-fi / cosmic ──────────────────────────────────────────────
  { pattern: /^planet_/i,                                       biome: ['alien', 'crystalline'] },
  { pattern: /crystal/i,                                        biome: ['crystalline', 'alien'] },
  { pattern: /lava|magma/i,                                     biome: ['volcanic', 'alien'] },
  { pattern: /^(spaceship|rocket|craft|lander|ufo|station)/i,   biome: ['alien'] },
  { pattern: /antenna|satellite|turret|monorail|cable|machine_/i, biome: ['alien', 'gas-stripped'] },
  { pattern: /spike|toxic|venom/i,                              biome: ['alien', 'volcanic'] },
  { pattern: /crater|meteor/i,                                  biome: ['gas-stripped', 'volcanic'] },
  // ── Undead / desolate ────────────────────────────────────────────
  { pattern: /pumpkin|carved/i,                                 biome: ['desert', 'gas-stripped'] },
  { pattern: /^(dead|withered|burnt)/i,                         biome: ['desert', 'gas-stripped'] },
  { pattern: /skull|grave|crypt|tomb|bone(s)?$/i,               biome: ['desert', 'gas-stripped'] },
  // ── Maritime / coastal ───────────────────────────────────────────
  { pattern: /lighthouse|tower-watch|boat|dock|anchor/i,        biome: ['ocean'] },
  { pattern: /palm|coconut|tropical/i,                          biome: ['ocean', 'forest'] },
  // ── Tropical jungle ──────────────────────────────────────────────
  { pattern: /jungle/i,                                         biome: ['forest', 'ocean'] },
  // ── Coniferous / alpine ──────────────────────────────────────────
  { pattern: /pine|spruce|conifer/i,                            biome: ['forest', 'ice'] },
  { pattern: /birch/i,                                          biome: ['forest', 'ice'] },
  { pattern: /snow|ice|frozen|glacier/i,                        biome: ['ice'] },
  // ── Desert ───────────────────────────────────────────────────────
  { pattern: /sand|dune|cactus|oasis/i,                         biome: ['desert'] },
  // ── Mushroom / fungal ────────────────────────────────────────────
  { pattern: /mushroom|fungal/i,                                biome: ['forest', 'alien'] },
];

/**
 * Resolve the biome_affinity array for an asset: first matching override
 * wins, falling back to the kit default. Either way, the result is
 * filtered to the LLM enum — out-of-enum strings would never be retrieved.
 */
function resolveBiome(name, kit) {
  for (const rule of BIOME_OVERRIDES) {
    if (rule.pattern.test(name)) {
      return rule.biome.filter((b) => LLM_BIOMES.includes(b));
    }
  }
  return (kit.biomeAffinity || []).filter((b) => LLM_BIOMES.includes(b));
}

// ────────────────────────────────────────────────────────────────────────
// Kit allowlist + per-kit metadata. Adding a new kit means appending an
// entry here; the importer takes care of the rest.
//
// `biomeAffinity` here is the kit-wide default — assets that don't match
// any per-filename biome override inherit this. Use LLM enum values only.
// ────────────────────────────────────────────────────────────────────────

const KITS = [
  // ─── Kenney ───────────────────────────────────────────────────────────
  {
    id: 'kenney_nature',
    creator: 'Kenney',
    pack: 'kenney_nature',
    sourceDir: 'kenney/nature-kit',
    license: 'CC0',
    biomeAffinity: ['forest'],
    themeAffinity: ['natural', 'wild', 'temperate'],
    role: {
      surface: [
        /^tree_/, /^plant_/, /^grass(_|$)/, /^flower_/, /^mushroom_/,
        /^rock_small/, /^stone_small/, /^stump_/, /^log_/, /^crops_/,
      ],
      landmark: [/^cliff_(large|top|waterfall|cornerTop)_/, /^rock_tall/],
      hero: [],
    },
    reject: [
      /^bed_/, /^fence_/, /^path_/, /^bridge_/, /^canoe_/, /^crop_/,
      /^ground_/, /^campfire_/, /^cliff_block_/, /^cliff_diagonal/,
      /^cliff_half/, /^cliff_steps/, /^cliff_cornerInner/,
    ],
    scaleRange: { surface: [0.6, 1.8], landmark: [4, 8], hero: [6, 12] },
  },
  {
    id: 'kenney_space',
    creator: 'Kenney',
    pack: 'kenney_space',
    sourceDir: 'kenney/space-kit',
    license: 'CC0',
    biomeAffinity: ['alien', 'gas-stripped'],
    themeAffinity: ['alien', 'mechanical', 'industrial'],
    role: {
      surface: [/^rock_/, /^crater$/, /^plant_alien/, /^bones$/, /^bones_/, /^stones?$/, /^meteor/],
      landmark: [/^antenna_/, /^pipe_/, /^machine_/, /^satellite/, /^chimney/, /^terrain_/, /^craterLarge$/, /^gate_/, /^turret/],
      hero: [/^structure_detailed/, /^structure$/, /^rocket_/, /^craft_/, /^alien$/, /^hangar_large/, /^hangar$/, /^station_/, /^ufo/],
    },
    reject: [
      /^astronaut/, /^monorail/, /^character_/, /^panels_/, /^supports_/,
      /^corridor_/, /^desk_/, /^barrel/, /^cargo_/,
    ],
    scaleRange: { surface: [0.8, 2.5], landmark: [3, 7], hero: [8, 16] },
  },
  {
    id: 'kenney_castle',
    creator: 'Kenney',
    pack: 'kenney_castle',
    sourceDir: 'kenney/castle-kit',
    license: 'CC0',
    biomeAffinity: ['forest', 'desert'],
    themeAffinity: ['ancient', 'monumental', 'stone', 'fantasy'],
    role: {
      surface: [],
      landmark: [
        /^tower-square-/, /^tower-hexagon-/, /^tower-top/, /^tower-base/,
        /^pillar-/, /^wall-narrow$/, /^wall-narrow-corner$/, /^gate-/,
      ],
      hero: [/^tower-square-top-roof-high/, /^tower-square-top-roof$/, /^tower-hexagon-roof-secondary/],
    },
    reject: [
      /^wall-/, /^stairs-/, /^door$/, /^ground$/, /^wood-/, /^flag-/,
    ],
    scaleRange: { landmark: [4, 8], hero: [10, 18] },
  },
  {
    id: 'kenney_graveyard',
    creator: 'Kenney',
    pack: 'kenney_graveyard',
    sourceDir: 'kenney/graveyard-kit',
    license: 'CC0',
    biomeAffinity: ['desert', 'gas-stripped'],
    themeAffinity: ['dark', 'somber', 'ancient', 'undead'],
    role: {
      surface: [/^gravestone-/, /^rocks-/, /^pumpkin/, /^pine-(crooked|leafy)/, /^tree-/, /^skull/, /^bone-/],
      landmark: [/^crypt-/, /^pillar-/, /^lightpost-/, /^statue/, /^pine-tall/],
      hero: [/^crypt-large/, /^crypt-small-roof/],
    },
    reject: [
      /^iron-fence/, /^fence/, /^character-/, /^detail-/, /^ground/, /^column-broken/,
    ],
    scaleRange: { surface: [0.7, 1.8], landmark: [3, 6], hero: [6, 12] },
  },
  {
    id: 'kenney_pirate',
    creator: 'Kenney',
    pack: 'kenney_pirate',
    sourceDir: 'kenney/pirate-kit',
    license: 'CC0',
    biomeAffinity: ['ocean', 'forest'],
    themeAffinity: ['weathered', 'maritime', 'tropical', 'natural'],
    role: {
      surface: [/^grass$/, /^patch-grass/, /^palm-/, /^rocks-/],
      landmark: [/^tower-(top|middle|watch|roof)/, /^structure-platform/, /^structure$/],
      hero: [/^lighthouse/, /^ship-/, /^tower-watch/],
    },
    reject: [
      /^boat-/, /^canon/, /^flag-/, /^character/, /^crate/, /^barrel/, /^chest/,
    ],
    scaleRange: { surface: [0.6, 1.5], landmark: [3, 7], hero: [8, 14] },
  },
  {
    id: 'kenney_fantasy_town',
    creator: 'Kenney',
    pack: 'kenney_fantasy_town',
    sourceDir: 'kenney/fantasy-town-kit',
    license: 'CC0',
    biomeAffinity: ['forest'],
    themeAffinity: ['rustic', 'monumental', 'natural', 'fantasy'],
    role: {
      surface: [],
      landmark: [/^pillar-/, /^fountain-/, /^watermill/, /^well/, /^arch$/],
      hero: [/^tower/, /^watermill$/],
    },
    reject: [
      /^wall-/, /^roof-/, /^stairs-/, /^door/, /^window/, /^hedge/, /^fence/,
      /^bench/, /^chair/, /^table/, /^cart/, /^lantern/, /^barrel/,
    ],
    scaleRange: { landmark: [3, 6], hero: [6, 12] },
  },

  // ─── Quaternius ───────────────────────────────────────────────────────
  {
    id: 'quaternius_space',
    creator: 'Quaternius',
    pack: 'quaternius_space',
    sourceDir: 'quaternius/ultimate-space-kit-march-2023/Ultimate Space Kit - March 2023/Environment/OBJ',
    license: 'CC0',
    biomeAffinity: ['alien', 'volcanic', 'crystalline'],
    themeAffinity: ['alien', 'mechanical', 'cosmic'],
    role: {
      surface: [/^Rock_\d+$/, /^Crystal/, /^Tree_(Spikes|Lava|Light|Toxic)/, /^Plant_/],
      landmark: [/^SolarPanel/, /^Antenna/, /^Beacon/, /^Tower/, /^Crater/, /^House_/],
      hero: [/^Planet_\d+$/, /^Spaceship/, /^House_Long$/, /^Tower_/],
    },
    reject: [
      /^Astronaut/, /^Character/, /^Item/, /^UI/, /^Pickup/,
    ],
    scaleRange: { surface: [0.8, 2.5], landmark: [3, 7], hero: [10, 20] },
  },
  {
    id: 'quaternius_ruins',
    creator: 'Quaternius',
    pack: 'quaternius_ruins',
    sourceDir: 'quaternius/ultimate-modular-ruins-pack-aug-2021/Ultimate Modular Ruins Pack - Aug 2021/OBJ',
    license: 'CC0',
    biomeAffinity: ['forest', 'desert'],
    themeAffinity: ['ancient', 'overgrown', 'forgotten', 'fantasy', 'ruin'],
    role: {
      surface: [/^Bush_/, /^Grass$/, /^Vines/],
      landmark: [
        /^Wall_(Overgrown|Big|ArchRound)/, /^Column_/, /^Arch_/, /^Pillar/,
        /^Floor_Pillar/, /^Statue/, /^Obelisk/,
      ],
      hero: [/^Wall_ArchRound_Broken$/, /^Column_BridgeSupport$/, /^Tower/],
    },
    reject: [
      /^Floor_/, /^Rail_/, /^Stairs/, /^Curve_/, /^Bridge_/, /^Roof_/, /^Door/,
    ],
    scaleRange: { surface: [0.6, 1.5], landmark: [3, 7], hero: [8, 14] },
  },
  {
    id: 'quaternius_nature',
    creator: 'Quaternius',
    pack: 'quaternius_nature',
    sourceDir: 'quaternius/ultimate-stylized-nature-may-2022/Ultimate Stylized Nature - May 2022/OBJ',
    license: 'CC0',
    biomeAffinity: ['forest'],
    themeAffinity: ['natural', 'wild', 'lush', 'temperate'],
    role: {
      surface: [
        /^PineTree_\d+$/, /^PalmTree_\d+$/, /^Tree_\d+$/, /^Bush(_|$)/,
        /^Flower_/, /^Grass(_|$)/, /^Mushroom/, /^Rock_\d+$/, /^Plant_/,
        /^[A-Z][a-z]+Tree_\d+$/,   // BirchTree, DeadTree, MapleTree, NormalTree, OakTree, …
        /^Petals_/,
      ],
      landmark: [/^PineTree_Big/, /^PalmTree_Big/, /^Tree_Big/, /^RockBig/, /^DeadTree_(10|11|12)/],
      hero: [/^Tree_Massive/, /^RockGiant/],
    },
    reject: [/^UI_/, /^Item_/, /^Prop_/, /^Crop/, /^Pickup/],
    scaleRange: { surface: [0.8, 2.5], landmark: [4, 8], hero: [10, 18] },
  },
  {
    id: 'quaternius_crops',
    creator: 'Quaternius',
    pack: 'quaternius_crops',
    sourceDir: 'quaternius/nature-crops-pack-jan-2020/Nature Crops Pack - Jan 2020/OBJ',
    license: 'CC0',
    biomeAffinity: ['forest', 'ocean'],
    themeAffinity: ['natural', 'cultivated', 'tropical'],
    role: {
      surface: [/^Tree_/, /^PalmTree_/, /^PineTree_/, /^Bush_/, /^Flower/, /^Rock_/],
      landmark: [],
      hero: [],
    },
    reject: [/Crop$/, /Harvested$/, /^UI_/, /^Item_/],
    scaleRange: { surface: [0.7, 2.0] },
  },
  {
    id: 'quaternius_stylized_trees',
    creator: 'Quaternius',
    pack: 'quaternius_stylized_trees',
    sourceDir: 'quaternius/textured-stylized-trees-may-2020/Textured Stylized Trees - May 2020/OBJ',
    license: 'CC0',
    biomeAffinity: ['forest'],
    themeAffinity: ['natural', 'lush', 'temperate'],
    role: {
      surface: [
        /^Tree_/, /^PalmTree_/, /^PineTree_/, /^OakTree_/,
        /^[A-Z][a-z]+(Tree|Birch|Pine|Oak|Maple|Willow)_\d+$/,
        /^(Pine|Birch|Oak|Maple|Willow|Spruce)_\d+$/,
      ],
      landmark: [/_Big$/, /_Large$/],
      hero: [/_Massive$/],
    },
    reject: [],
    scaleRange: { surface: [1.0, 3.0], landmark: [4, 8], hero: [10, 18] },
  },

  // ─── KayKit ───────────────────────────────────────────────────────────
  {
    id: 'kaykit_forest',
    creator: 'KayKit',
    pack: 'kaykit_forest',
    sourceDir: 'kaykit/forest/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/obj',
    license: 'CC0',
    biomeAffinity: ['forest', 'ice'],
    themeAffinity: ['natural', 'wild', 'lush', 'temperate'],
    dedupKayKit: true,
    role: {
      surface: [/^Bush_/, /^Grass_/, /^Rock_/, /^Tree_(Bare_)?\d/, /^Flower/, /^Mushroom/, /^Plant/],
      landmark: [/^TreeStump_/, /^FallenTree/],
      hero: [],
    },
    reject: [/SingleSided_Mesh/, /^Log_/, /^Stump_/],
    scaleRange: { surface: [0.7, 2.2], landmark: [3, 6] },
  },
  {
    id: 'kaykit_space_base',
    creator: 'KayKit',
    pack: 'kaykit_space_base',
    sourceDir: 'kaykit/space-base-bits/KayKit_Space_Base_Bits_1.0_FREE/Assets/obj',
    license: 'CC0',
    biomeAffinity: ['alien', 'gas-stripped'],
    themeAffinity: ['mechanical', 'industrial', 'mining'],
    dedupKayKit: true,
    role: {
      surface: [/^rock_/, /^crystal_/, /^cargo_/, /^crater_/],
      landmark: [/^lander_/, /^windturbine/, /^lights$/, /^antenna/, /^terrain_/],
      hero: [/^spacetruck$/, /^lander_/, /^satellite_dish/],
    },
    reject: [
      /^spacetruck_(wheel|trailer)/, /^pipe/, /^crate/, /character/, /soldier/,
    ],
    scaleRange: { surface: [0.6, 2.0], landmark: [4, 8], hero: [8, 14] },
  },
];

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

/** Strip the .glb extension. */
function stem(filename) {
  return filename.replace(/\.glb$/i, '');
}

/**
 * Match a filename against role-pattern arrays. First role with a match
 * wins; preference order matches the KITS schema (surface → landmark → hero).
 * Hero generally has fewer patterns so checking it last avoids accidental
 * surface→hero promotion.
 */
function classifyRole(name, kit) {
  for (const role of ['hero', 'landmark', 'surface']) {
    const patterns = kit.role[role] || [];
    if (patterns.some((p) => p.test(name))) return role;
  }
  return null;
}

/**
 * KayKit dedup. Strip color/letter variant suffixes so we keep one entry
 * per silhouette. e.g. `Rock_3_B_Color1` → `Rock_3`. Returns the shape key.
 */
function kaykitShapeKey(name) {
  return name
    .replace(/_[A-Z]_Singlesided_Color\d+$/, '')
    .replace(/_[A-Z]_Color\d+$/, '')
    .replace(/_Singlesided_Color\d+$/, '')
    .replace(/_SingleSided_Mesh$/, '')
    .replace(/_Color\d+$/, '');
}

/**
 * Turn a filename like "tree_pineRoundA" into a tag array
 * ["tree","pine","round"]. Splits on _, -, camelCase, and digits;
 * lowercases everything; dedupes; drops very short tokens.
 */
function tagsFor(name) {
  const tokens = name
    .replace(/([a-z])([A-Z])/g, '$1_$2')   // camelCase → snake
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_\-\s]+|(?<=\D)(?=\d)|(?<=\d)(?=\D)/)
    .filter((t) => t.length >= 2 && !/^\d+$/.test(t));
  return [...new Set(tokens)];
}

/** Title-case a filename for the human-readable name. */
function nameFor(filename) {
  return stem(filename)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Slug-safe asset id. e.g. "kenney:nature-kit:tree_pineRoundA" */
function makeId(kit, stemName) {
  return `${kit.creator.toLowerCase()}:${kit.pack.replace(/^[a-z]+_/, '')}:${stemName}`;
}

/**
 * Recursively yield .glb files under a directory.
 */
async function* walkGlbs(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) yield* walkGlbs(full);
    else if (ent.isFile() && ent.name.toLowerCase().endsWith('.glb')) yield full;
  }
}

/** Run gltf-transform CLI on a GLB. Optimize in place. */
function runOptimize(file) {
  return new Promise((resolve, reject) => {
    // optimize = dedupe + prune + weld + draco + (textures handled below)
    const args = ['--yes', '@gltf-transform/cli', 'optimize', file, file, '--compress', 'draco', '--texture-compress', 'webp'];
    const child = spawn('npx', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`gltf-transform exit ${code}: ${stderr.slice(-400)}`));
    });
  });
}

// ────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────

async function processKit(kit, summary) {
  const sourceAbs = join(SOURCE_ROOT, kit.sourceDir);
  if (!existsSync(sourceAbs)) {
    summary.kitsMissing.push(kit.id);
    return;
  }
  const destAbs = join(DEST_ROOT, kit.creator.toLowerCase(), kit.pack.replace(/^[a-z]+_/, ''));
  await mkdir(destAbs, { recursive: true });

  // Pre-walk + dedup (KayKit) before role classification.
  const candidates = []; // { file, name, role }
  const dedupSeen = new Set();
  for await (const file of walkGlbs(sourceAbs)) {
    const name = stem(basename(file));
    if ((kit.reject || []).some((p) => p.test(name))) {
      summary.rejected++;
      continue;
    }
    const role = classifyRole(name, kit);
    if (!role) {
      summary.unclassified++;
      continue;
    }
    if (kit.dedupKayKit) {
      const key = kaykitShapeKey(name);
      if (dedupSeen.has(key)) { summary.duplicated++; continue; }
      dedupSeen.add(key);
    }
    candidates.push({ file, name, role });
  }

  if (DRY) {
    console.log(`  [dry] ${kit.id}: would import ${candidates.length} (hero=${candidates.filter(c=>c.role==='hero').length} landmark=${candidates.filter(c=>c.role==='landmark').length} surface=${candidates.filter(c=>c.role==='surface').length})`);
    summary.entries.push(...candidates.map(c => ({ kit, ...c })));
    return;
  }

  // Copy + (optional) compress.
  for (const c of candidates) {
    const destFile = join(destAbs, basename(c.file));
    if (!existsSync(destFile)) {
      await copyFile(c.file, destFile);
      if (!NO_OPT) {
        try {
          await runOptimize(destFile);
        } catch (err) {
          // Optimize failure → keep raw copy; warn.
          console.warn(`  ! optimize failed for ${basename(destFile)}: ${err.message}`);
          summary.optFailed++;
        }
      }
    } else {
      summary.skippedExisting++;
    }
    summary.entries.push({ kit, ...c, destFile });
  }
  console.log(`  ✓ ${kit.id}: ${candidates.length} imported`);
}

async function main() {
  console.log(`Importing from ${SOURCE_ROOT}`);
  console.log(`Bundling to   ${DEST_ROOT}`);
  if (DRY) console.log('(dry run — no files written)');
  if (NO_OPT) console.log('(no-opt — skipping gltf-transform compression)');
  console.log('');

  const summary = {
    kitsMissing: [],
    rejected: 0,
    unclassified: 0,
    duplicated: 0,
    skippedExisting: 0,
    optFailed: 0,
    entries: [],
  };

  for (const kit of KITS) {
    await processKit(kit, summary);
  }

  if (summary.kitsMissing.length) {
    console.warn(`\nMissing source dirs (skipped): ${summary.kitsMissing.join(', ')}`);
  }

  // Build catalog.source.json from collected entries.
  const assets = summary.entries.map(({ kit, file, name, role, destFile }) => {
    const sourceFile = destFile || join(DEST_ROOT, kit.creator.toLowerCase(), kit.pack.replace(/^[a-z]+_/, ''), basename(file));
    const url = `${PUBLIC_URL_PREFIX}/${kit.creator.toLowerCase()}/${kit.pack.replace(/^[a-z]+_/, '')}/${basename(sourceFile)}`;
    const id = makeId(kit, name);
    const entry = {
      id,
      name: nameFor(basename(file)),
      pack: kit.pack,
      creator: kit.creator,
      license: kit.license,
      attribution: null,
      url,
      role,
      family: resolveFamily(name),
      tags: tagsFor(name),
      biome_affinity: resolveBiome(name, kit),
      theme_affinity: kit.themeAffinity,
      scale_range: kit.scaleRange[role] || [1.0, 2.0],
    };
    if (SCALE_OVERRIDES[id]) entry.scale_override = SCALE_OVERRIDES[id];
    return entry;
  });

  // Dedup by id (in case two kits have overlapping filenames).
  const seen = new Set();
  const deduped = [];
  for (const a of assets) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    deduped.push(a);
  }

  // Final summary by role.
  const byRole = deduped.reduce((acc, a) => { acc[a.role] = (acc[a.role] || 0) + 1; return acc; }, {});
  console.log('\n──────────────────────────────────────────────');
  console.log(`Total entries: ${deduped.length}`);
  console.log(`  hero:     ${byRole.hero || 0}`);
  console.log(`  landmark: ${byRole.landmark || 0}`);
  console.log(`  surface:  ${byRole.surface || 0}`);
  console.log(`Rejected by filter: ${summary.rejected}`);
  console.log(`Unclassified:       ${summary.unclassified}`);
  if (summary.duplicated) console.log(`KayKit dedup'd:     ${summary.duplicated}`);
  if (summary.skippedExisting) console.log(`Skipped existing:   ${summary.skippedExisting}`);
  if (summary.optFailed) console.log(`Optimize failures:  ${summary.optFailed}`);
  console.log('──────────────────────────────────────────────\n');

  if (DRY) {
    console.log('(dry run complete — no catalog.source.json written)');
    return;
  }

  const out = {
    _comment: `Generated by tools/import-assets.js. Edit kit allowlist in the script, not this file.`,
    assets: deduped,
  };
  await writeFile(CATALOG_SOURCE_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote ${CATALOG_SOURCE_PATH}`);
  console.log(`\nNext: run \`npm run build:catalog\` to compute embeddings.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
