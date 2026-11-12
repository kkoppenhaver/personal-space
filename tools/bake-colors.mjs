#!/usr/bin/env node
// Colour bake — turns a SOURCE GLB from the raw mirror into the bundled GLB
// the game ships, with the asset's authored albedo baked into vertex colours.
//
// Output contract (every bundled GLB):
//   - every primitive has COLOR_0 (float VEC3, LINEAR RGB): texel (sRGB →
//     linear, nearest texel at the vertex's UV, sampler wrap honoured, glTF
//     top-left UV origin) × baseColorFactor. Untextured material → its factor.
//   - one neutral material named "baked" (white factor, no textures), no
//     images, no TEXCOORD_*; animations dropped (static pose only).
//   - node transforms baked into the geometry and primitives joined, so most
//     assets are ONE primitive (one draw call).
//   - Draco compressed (positions 14 bit, normals 10 bit, colours 12 bit).
// Assets whose colour genuinely can't be recovered keep their geometry but
// get no COLOR_0 (the runtime falls back to the flat family colour).
//
// Per-kit colour sources live in BAKE_CONFIG below; the name palette is in
// tools/part-palette.json. See src/world/assets/README.md for the overview.
//
// Usage:
//   node tools/bake-colors.mjs                 # re-bake every bundled asset
//   node tools/bake-colors.mjs kenney_pirate   # only these kit ids
//   node tools/bake-colors.mjs --report        # also rewrite tools/bake-report.json
//
// The four Kenney colormap kits need their atlases (not in the raw mirror):
//   $KENNEY_COLORMAP_DIR (default ~/code/kenney-colormaps)/<kit>/colormap.png
// A kit whose atlas is missing is skipped with an error; its files are left
// untouched.

import { readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { flatten, join as joinPrims, weld, dedup, prune, draco } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIRROR = join(homedir(), 'code/3d-modles/assets');
export const KENNEY_COLORMAP_DIR = process.env.KENNEY_COLORMAP_DIR || join(homedir(), 'code/kenney-colormaps');
const PALETTE_PATH = join(ROOT, 'tools/part-palette.json');
const REPORT_PATH = join(ROOT, 'tools/bake-report.json');

const kenneyAtlas = (kitDir) => ({ 'Textures/colormap.png': join(KENNEY_COLORMAP_DIR, kitDir, 'colormap.png') });

/**
 * Per-kit colour source. Kits not listed use the default: bake straight from
 * whatever the source GLB carries (material factors and embedded textures).
 *   source           - label written to bake-report.json
 *   externalImages   - uri → local file, for GLBs that reference textures
 *                      not shipped in the mirror (Kenney colormap kits)
 *   materialTextures - material name → local file, for materials whose
 *                      texture was unlinked on export (sampled at the UVs)
 *   averageTextures  - { dir, aliases }: material name → `${name}.png|jpg`
 *                      in dir; bake the texture's mean colour (alpha > 0.5
 *                      texels, linear space) instead of sampling at UVs
 *   namePalette      - consult tools/part-palette.json for materials with no
 *                      texture and a Blender default-grey factor
 */
export const BAKE_CONFIG = {
  kenney_castle:       { source: 'kenney colormap.png atlas (Castle Kit 2.0)',       externalImages: kenneyAtlas('castle-kit') },
  kenney_graveyard:    { source: 'kenney colormap.png atlas (Graveyard Kit 5.0)',    externalImages: kenneyAtlas('graveyard-kit') },
  kenney_pirate:       { source: 'kenney colormap.png atlas (Pirate Kit 2.1)',       externalImages: kenneyAtlas('pirate-kit') },
  kenney_fantasy_town: { source: 'kenney colormap.png atlas (Fantasy Town Kit 2.0)', externalImages: kenneyAtlas('fantasy-town-kit') },
  quaternius_space: {
    source: 'Atlas.png sampled at source UVs',
    materialTextures: { Atlas: join(MIRROR, 'quaternius/ultimate-space-kit-march-2023/Ultimate Space Kit - March 2023/Atlas.png') },
  },
  quaternius_nature: {
    source: 'per-material texture average (glTF/ textures) + name palette',
    averageTextures: {
      dir: join(MIRROR, 'quaternius/ultimate-stylized-nature-may-2022/Ultimate Stylized Nature - May 2022/glTF'),
      aliases: { Rock: 'Rocks' },
    },
    namePalette: true,
  },
  quaternius_stylized_trees: { source: 'name palette (pack ships no textures)', namePalette: true },
  quaternius_ruins:          { source: 'material factors + name palette for unlinked leaf materials', namePalette: true },
  kaykit_forest:             { source: 'embedded atlas texture + name palette for untextured', namePalette: true },
};

// ────────────────────────────────────────────────────────────────────────
// Colour helpers
// ────────────────────────────────────────────────────────────────────────

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
export const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const hexToLinear = (hex) => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => SRGB_TO_LINEAR[v]);
};

/** Blender's "nothing linked" default base colours: 0.64 (OBJ/MTL export) and 0.8 (principled default). */
function isDefaultGrey(f) {
  return Math.abs(f[0] - f[1]) < 1e-3 && Math.abs(f[1] - f[2]) < 1e-3 &&
    (Math.abs(f[0] - 0.64) < 2e-3 || Math.abs(f[0] - 0.8) < 2e-3);
}

let _palette = null;
function paletteLookup(assetName, matName) {
  _palette ||= JSON.parse(readFileSync(PALETTE_PATH, 'utf8')).rules.map((r) => ({ ...r, re: new RegExp(r.match, 'i') }));
  const key = `${assetName}/${matName}`;
  const rule = _palette.find((r) => r.re.test(key));
  return rule ? { linear: hexToLinear(rule.srgb), rule: rule.match } : null;
}

// Decoded images, keyed by file path or a hash of the embedded bytes.
const _images = new Map();
async function decodeImage(key, bytes) {
  if (_images.has(key)) return _images.get(key);
  const { data, info } = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const img = { data, width: info.width, height: info.height };
  _images.set(key, img);
  return img;
}

function wrapIndex(i, n, mode) {
  if (mode === 33071) return Math.min(n - 1, Math.max(0, i));            // CLAMP_TO_EDGE
  if (mode === 33648) {                                                   // MIRRORED_REPEAT
    const p = ((i % (2 * n)) + 2 * n) % (2 * n);
    return p < n ? p : 2 * n - 1 - p;
  }
  return ((i % n) + n) % n;                                               // REPEAT
}

/** Nearest-texel linear RGB at (u, v); glTF UV origin is the image's top-left. */
function sampleLinear(img, u, v, wrapS, wrapT) {
  const x = wrapIndex(Math.floor(u * img.width), img.width, wrapS);
  const y = wrapIndex(Math.floor(v * img.height), img.height, wrapT);
  const o = (y * img.width + x) * 4;
  return [SRGB_TO_LINEAR[img.data[o]], SRGB_TO_LINEAR[img.data[o + 1]], SRGB_TO_LINEAR[img.data[o + 2]], img.data[o + 3]];
}

/** Mean linear RGB of texels with alpha > 0.5. */
function averageLinear(img) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let o = 0; o < img.data.length; o += 4) {
    if (img.data[o + 3] <= 127) continue;
    r += SRGB_TO_LINEAR[img.data[o]]; g += SRGB_TO_LINEAR[img.data[o + 1]]; b += SRGB_TO_LINEAR[img.data[o + 2]]; n++;
  }
  return n ? [r / n, g / n, b / n] : null;
}

function hasCutout(img) {
  if (img._cutout !== undefined) return img._cutout;
  let cut = 0;
  for (let o = 3; o < img.data.length; o += 4) if (img.data[o] <= 127) cut++;
  return (img._cutout = cut > img.data.length / 4 * 0.01);
}

function findAverageTexture(cfg, matName) {
  const base = cfg.aliases?.[matName] || matName;
  for (const ext of ['.png', '.jpg', '.jpeg']) {
    const p = join(cfg.dir, base + ext);
    if (existsSync(p)) return p;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────
// IO
// ────────────────────────────────────────────────────────────────────────

let _io = null;
export async function getIO() {
  if (_io) return _io;
  _io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'draco3d.encoder': await draco3d.createEncoderModule(),
    })
    .setStrictResources(false);
  _io.setLogger({ debug() {}, info() {}, warn() {}, error: (m) => console.error(m) });
  return _io;
}

/** Read a GLB, substituting external image URIs from `externalImages`. */
async function readSource(io, path, externalImages = {}) {
  const jsonDoc = await io.readAsJSON(path);
  for (const img of jsonDoc.json.images || []) {
    if (!img.uri || img.uri.startsWith('data:')) continue;
    const local = externalImages[img.uri];
    if (local) {
      if (!existsSync(local)) throw new Error(`external image ${img.uri} → ${local} is missing`);
      jsonDoc.resources[img.uri] = new Uint8Array(readFileSync(local));
    }
  }
  return io.readJSON(jsonDoc);
}

// ────────────────────────────────────────────────────────────────────────
// Bake
// ────────────────────────────────────────────────────────────────────────

/**
 * Resolve one material to a colour source:
 *   { kind: 'texture', img, wrapS, wrapT, texCoord, offset, scale, factor, label }
 *   { kind: 'const', linear, label }
 *   { kind: 'none', label }        — colour can't be recovered
 */
async function resolveMaterial(mat, assetName, cfg) {
  const name = mat?.getName() || '';
  const factor = mat ? mat.getBaseColorFactor().slice(0, 3) : [1, 1, 1];
  const tex = mat?.getBaseColorTexture();
  if (tex) {
    const bytes = tex.getImage();
    if (!bytes) return { kind: 'none', label: `unresolved texture ${tex.getURI()}` };
    const info = mat.getBaseColorTextureInfo();
    const tt = info.getExtension('KHR_texture_transform');
    if (tt && tt.getRotation() !== 0) throw new Error(`${assetName}: KHR_texture_transform rotation not supported`);
    return {
      kind: 'texture', img: await decodeImage(`sha1:${hashBytes(bytes)}`, bytes),
      wrapS: info.getWrapS(), wrapT: info.getWrapT(),
      texCoord: tt?.getTexCoord() ?? info.getTexCoord(),
      offset: tt?.getOffset() || [0, 0], scale: tt?.getScale() || [1, 1],
      factor, label: 'texture',
    };
  }
  if (cfg.materialTextures?.[name]) {
    const p = cfg.materialTextures[name];
    return {
      kind: 'texture', img: await decodeImage(p, readFileSync(p)),
      wrapS: 10497, wrapT: 10497, texCoord: 0, offset: [0, 0], scale: [1, 1],
      // The unlinked default grey is not authored colour — don't darken by it.
      factor: isDefaultGrey(factor) ? [1, 1, 1] : factor,
      label: `atlas ${basename(p)}`,
    };
  }
  if (cfg.averageTextures) {
    const p = findAverageTexture(cfg.averageTextures, name);
    if (p) {
      const img = await decodeImage(p, readFileSync(p));
      const avg = averageLinear(img);
      if (avg) {
        // The texture is the authored colour; the material factor in these
        // OBJ-derived files is only Blender's viewport colour (default grey or
        // a rough swatch of the same texture) — multiplying would darken twice.
        const f = [1, 1, 1];
        // Alpha-cut sheets (leaf/petal cards) get a per-UV-island average so
        // each card keeps its own colour; opaque tiling detail textures (bark,
        // rock) get one whole-texture average so facets don't mottle.
        const kind = hasCutout(img) ? 'island-average' : 'const';
        return { kind, img, linear: avg, factor: f, label: `${kind === 'const' ? 'avg' : 'island avg'} ${basename(p)}` };
      }
    }
  }
  if (isDefaultGrey(factor) && cfg.namePalette) {
    const hit = paletteLookup(assetName, name);
    if (hit) return { kind: 'const', linear: hit.linear, label: `palette /${hit.rule}/` };
    return { kind: 'none', label: `default grey "${name}", no palette rule` };
  }
  return { kind: 'const', linear: factor, label: 'factor' };
}

function hashBytes(bytes) {
  return createHash('sha1').update(bytes).digest('hex');
}

/**
 * Average-colour mode for detail textures and alpha-cut cards. Each UV
 * island (triangles connected through shared vertices) gets the mean linear
 * colour of the opaque (alpha > 0.5) texels its triangles cover in UV space.
 * That keeps a pink flower card pink and its leaf card green when several
 * cards share one texture sheet, while a tiling bark texture still averages
 * to its overall colour. Islands that cover no opaque texel, are huge in UV
 * space (> 4 texture repeats), or primitives without UVs fall back to the
 * whole-texture average.
 */
function islandAverage(prim, src, out) {
  const n = prim.getAttribute('POSITION').getCount();
  const uvAcc = prim.getAttribute('TEXCOORD_0');
  if (!uvAcc) { for (let i = 0; i < n; i++) out.set(src.linear, i * 3); return; }
  const idxAcc = prim.getIndices();
  const tri = idxAcc ? Array.from(idxAcc.getArray()) : [...Array(n).keys()];
  const uv = new Float32Array(n * 2);
  const t = [0, 0];
  for (let i = 0; i < n; i++) { uvAcc.getElement(i, t); uv[i * 2] = t[0]; uv[i * 2 + 1] = t[1]; }

  // Union-find over vertices joined by triangles.
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a; };
  for (let k = 0; k < tri.length; k += 3) {
    const r0 = find(tri[k]);
    parent[find(tri[k + 1])] = r0;
    parent[find(tri[k + 2])] = r0;
  }

  const { img } = src;
  const W = img.width, H = img.height;
  const sums = new Map();   // root → [r, g, b, count, huge]
  for (let k = 0; k < tri.length; k += 3) {
    const root = find(tri[k]);
    let acc = sums.get(root);
    if (!acc) sums.set(root, (acc = [0, 0, 0, 0, 0]));
    if (acc[4]) continue;
    const px = [0, 1, 2].map((j) => uv[tri[k + j] * 2] * W);
    const py = [0, 1, 2].map((j) => uv[tri[k + j] * 2 + 1] * H);
    const x0 = Math.floor(Math.min(...px)), x1 = Math.ceil(Math.max(...px));
    const y0 = Math.floor(Math.min(...py)), y1 = Math.ceil(Math.max(...py));
    if ((x1 - x0) * (y1 - y0) > W * H * 4) { acc[4] = 1; continue; }
    const area = (px[1] - px[0]) * (py[2] - py[0]) - (px[2] - px[0]) * (py[1] - py[0]);
    const addTexel = (x, y) => {
      const xi = wrapIndex(x, W, 10497), yi = wrapIndex(y, H, 10497);
      const o = (yi * W + xi) * 4;
      if (img.data[o + 3] <= 127) return;
      acc[0] += SRGB_TO_LINEAR[img.data[o]]; acc[1] += SRGB_TO_LINEAR[img.data[o + 1]]; acc[2] += SRGB_TO_LINEAR[img.data[o + 2]]; acc[3]++;
    };
    // Always count the centroid so slivers smaller than a texel still vote.
    addTexel(Math.floor((px[0] + px[1] + px[2]) / 3), Math.floor((py[0] + py[1] + py[2]) / 3));
    if (Math.abs(area) < 1e-9) continue;
    // Large triangles (tiling bark) are subsampled to ~1k texels each.
    const stride = Math.max(1, Math.ceil(Math.sqrt(((x1 - x0) * (y1 - y0)) / 1024)));
    for (let y = y0; y < y1; y += stride) {
      for (let x = x0; x < x1; x += stride) {
        const cx = x + 0.5, cy = y + 0.5;
        const w0 = ((px[1] - cx) * (py[2] - cy) - (px[2] - cx) * (py[1] - cy)) / area;
        const w1 = ((px[2] - cx) * (py[0] - cy) - (px[0] - cx) * (py[2] - cy)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 >= 0 && w1 >= 0 && w2 >= 0) addTexel(x, y);
      }
    }
  }
  const colorOf = new Map();
  for (const [root, a] of sums) {
    colorOf.set(root, !a[4] && a[3] > 0 ? [a[0] / a[3] * src.factor[0], a[1] / a[3] * src.factor[1], a[2] / a[3] * src.factor[2]] : src.linear);
  }
  for (let i = 0; i < n; i++) out.set(colorOf.get(find(i)) || src.linear, i * 3);
}

/** Build the COLOR_0 array for one primitive, or null if not recoverable. */
function colorsFor(prim, src, warn) {
  const pos = prim.getAttribute('POSITION');
  const n = pos.getCount();
  const out = new Float32Array(n * 3);
  if (src.kind === 'none') return null;
  if (src.kind === 'const') {
    for (let i = 0; i < n; i++) out.set(src.linear, i * 3);
  } else if (src.kind === 'island-average') {
    islandAverage(prim, src, out);
  } else {
    const uv = prim.getAttribute(`TEXCOORD_${src.texCoord}`);
    if (!uv) return null;
    const t = [0, 0];
    for (let i = 0; i < n; i++) {
      uv.getElement(i, t);
      const u = t[0] * src.scale[0] + src.offset[0];
      const v = t[1] * src.scale[1] + src.offset[1];
      const c = sampleLinear(src.img, u, v, src.wrapS, src.wrapT);
      if (c[3] < 128) warn.transparentTexels++;
      out[i * 3] = c[0] * src.factor[0];
      out[i * 3 + 1] = c[1] * src.factor[1];
      out[i * 3 + 2] = c[2] * src.factor[2];
    }
  }
  // Fold in any authored vertex colours.
  const existing = prim.getAttribute('COLOR_0');
  if (existing) {
    const e = [0, 0, 0, 1];
    for (let i = 0; i < n; i++) {
      existing.getElement(i, e);
      out[i * 3] *= e[0]; out[i * 3 + 1] *= e[1]; out[i * 3 + 2] *= e[2];
    }
  }
  return out;
}

const KEEP_ATTRS = new Set(['POSITION', 'NORMAL', 'COLOR_0']);

/**
 * Bake one source GLB into `destPath`. Returns a per-asset summary.
 * @param {string} srcPath
 * @param {string} destPath
 * @param {{ id: string }} kit - an entry from KITS (tools/import-assets.js)
 * @param {{ compress?: boolean }} [opts] - compress:false skips Draco (debugging)
 */
export async function bakeAsset(srcPath, destPath, kit, { compress = true } = {}) {
  const io = await getIO();
  const cfg = BAKE_CONFIG[kit.id] || {};
  const assetName = basename(srcPath).replace(/\.glb$/i, '');
  const doc = await readSource(io, srcPath, cfg.externalImages);
  const root = doc.getRoot();

  // 1. Colour every primitive from its own material.
  const matCache = new Map();
  const sources = new Set();
  let colored = 0, uncolored = 0;
  const missing = [];
  const warn = { transparentTexels: 0 };
  const doubleSided = root.listMaterials().some((m) => m.getDoubleSided());
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      if (!matCache.has(mat)) matCache.set(mat, await resolveMaterial(mat, assetName, cfg));
      const src = matCache.get(mat);
      sources.add(src.label);
      const colors = colorsFor(prim, src, warn);
      if (colors) {
        const acc = doc.createAccessor().setType('VEC3').setArray(colors).setBuffer(root.listBuffers()[0] || doc.createBuffer());
        prim.setAttribute('COLOR_0', acc);
        colored++;
      } else {
        prim.setAttribute('COLOR_0', null);
        uncolored++;
        missing.push(src.label);
      }
    }
  }
  // Mixed coloured/uncoloured primitives can't join and would read oddly;
  // treat the whole asset as uncoloured in that case.
  const hasColor = uncolored === 0;
  if (!hasColor) {
    for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives()) prim.setAttribute('COLOR_0', null);
  }

  // 2. One neutral material; drop textures, UVs, animations, skins.
  const baked = doc.createMaterial('baked')
    .setBaseColorFactor([1, 1, 1, 1])
    .setMetallicFactor(0)
    .setRoughnessFactor(1)
    .setDoubleSided(doubleSided);
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      prim.setMaterial(baked);
      for (const sem of prim.listSemantics()) if (!KEEP_ATTRS.has(sem)) prim.setAttribute(sem, null);
      for (const t of prim.listTargets()) t.dispose();
    }
    mesh.setWeights([]);
  }
  for (const m of root.listMaterials()) if (m !== baked) m.dispose();
  for (const t of root.listTextures()) t.dispose();
  for (const a of root.listAnimations()) a.dispose();
  for (const s of root.listSkins()) s.dispose();
  for (const ext of root.listExtensionsUsed()) ext.dispose();

  // 3. Bake node transforms + join into as few primitives as possible.
  await doc.transform(
    flatten(),
    joinPrims({ keepNamed: false, keepMeshes: false }),
    weld(),
    dedup(),
    prune({ keepLeaves: false, keepAttributes: false }),
  );
  // join() leaves one node per joined mesh; collapse onto a single mesh
  // when every node is an identity-transform sibling.
  await collapseMeshes(doc);
  await doc.transform(joinPrims({ keepNamed: false, keepMeshes: false }), weld(), prune());

  // 4. Draco.
  if (compress) {
    doc.createExtension(KHRDracoMeshCompression).setRequired(true);
    await doc.transform(draco({ method: 'edgebreaker', quantizePosition: 14, quantizeNormal: 10, quantizeColor: 12 }));
  }

  await mkdir(dirname(destPath), { recursive: true });
  const bytes = await io.writeBinary(doc);
  await writeFile(destPath, bytes);

  const prims = doc.getRoot().listMeshes().reduce((n, m) => n + m.listPrimitives().length, 0);
  return { name: assetName, colored: hasColor, sources: [...sources], missing, prims, bytes: bytes.byteLength, transparentTexels: warn.transparentTexels };
}

/**
 * After flatten(), every mesh node is a direct child of the scene. Move all
 * primitives of identity-transform nodes onto the first such node's mesh so
 * the final join() can merge them into one primitive.
 */
async function collapseMeshes(doc) {
  const root = doc.getRoot();
  const scene = root.getDefaultScene() || root.listScenes()[0];
  const meshNodes = [];
  scene.traverse((n) => { if (n.getMesh()) meshNodes.push(n); });
  const isIdentity = (n) => {
    const m = n.getWorldMatrix();
    return m.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-9);
  };
  const ident = meshNodes.filter(isIdentity);
  if (ident.length < 2) return;
  const target = ident[0];
  if (target.getParentNode()) return;
  for (const n of ident.slice(1)) {
    for (const p of n.getMesh().listPrimitives()) target.getMesh().addPrimitive(p);
    n.setMesh(null);
  }
}

// ────────────────────────────────────────────────────────────────────────
// CLI: re-bake every bundled asset from its mirror source.
// ────────────────────────────────────────────────────────────────────────

async function main() {
  const { KITS, listCandidates, destDirFor, sourceDirFor } = await import('./import-assets.js');
  const args = process.argv.slice(2);
  const writeReport = args.includes('--report');
  const onlyKits = args.filter((a) => !a.startsWith('--'));
  const report = existsSync(REPORT_PATH) && onlyKits.length ? JSON.parse(readFileSync(REPORT_PATH, 'utf8')) : { _comment: '', packs: {} };
  let failed = 0;

  for (const kit of KITS) {
    if (onlyKits.length && !onlyKits.includes(kit.id)) continue;
    const cfg = BAKE_CONFIG[kit.id] || {};
    if (!existsSync(sourceDirFor(kit))) { console.error(`✗ ${kit.id}: source dir missing`); failed++; continue; }
    const atlasMissing = Object.values(cfg.externalImages || {}).filter((p) => !existsSync(p));
    if (atlasMissing.length) {
      console.error(`✗ ${kit.id}: atlas missing (${atlasMissing.join(', ')}); files left untouched`);
      failed++;
      continue;
    }
    const destDir = destDirFor(kit);
    const cands = await listCandidates(kit);
    const seen = new Set();
    const pack = { source: cfg.source || 'source GLB material factors / embedded textures', baked: 0, withoutColor: [], bytesBefore: 0, bytesAfter: 0, primsAfter: 0, materialSources: {} };
    for (const c of cands) {
      const file = basename(c.file);
      if (seen.has(file)) continue;   // importer keeps the first file per name
      seen.add(file);
      const dest = join(destDir, file);
      if (!existsSync(dest)) continue; // the bundled set is fixed; never add files here
      pack.bytesBefore += statSync(dest).size;
      try {
        const r = await bakeAsset(c.file, dest, kit);
        pack.baked++;
        pack.bytesAfter += r.bytes;
        pack.primsAfter += r.prims;
        if (!r.colored) pack.withoutColor.push({ file, reason: r.missing.join('; ') });
        if (r.transparentTexels) {
          pack.transparentTexelSamples = (pack.transparentTexelSamples || 0) + r.transparentTexels;
          console.warn(`  ! ${kit.id}/${file}: ${r.transparentTexels} vertices sampled a transparent texel`);
        }
        for (const s of r.sources) pack.materialSources[s] = (pack.materialSources[s] || 0) + 1;
      } catch (err) {
        console.error(`  ! ${kit.id}/${file}: ${err.message}`);
        failed++;
        pack.bytesAfter += statSync(dest).size;
      }
    }
    report.packs[destDir.slice(join(ROOT, 'public/assets/bundled/').length)] = pack;
    console.log(`✓ ${kit.id}: ${pack.baked} baked, ${pack.withoutColor.length} without COLOR_0, ${pack.bytesBefore} → ${pack.bytesAfter} bytes`);
  }

  if (writeReport) {
    const packs = Object.values(report.packs);
    report._comment = 'Generated by tools/bake-colors.mjs --report. Per bundled pack: colour source, counts, bytes before/after the colour bake.';
    report.totals = {
      baked: packs.reduce((n, p) => n + p.baked, 0),
      withoutColor: packs.reduce((n, p) => n + p.withoutColor.length, 0),
      bytesBefore: packs.reduce((n, p) => n + p.bytesBefore, 0),
      bytesAfter: packs.reduce((n, p) => n + p.bytesAfter, 0),
      primsAfter: packs.reduce((n, p) => n + p.primsAfter, 0),
    };
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
    console.log(`Wrote ${REPORT_PATH}`);
  }
  if (failed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
