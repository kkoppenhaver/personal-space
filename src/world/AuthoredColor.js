// Authored colour extraction (Phase 1a — true colours).
//
// Reads the colours a model was made with, once per loaded GLB, so
// MaterialSet can grade them toward a planet's palette instead of painting
// the whole asset one flat colour.
//
// Where the colour comes from, in order:
//   1. COLOR_0 vertex colours. The import bake (tools/bake-colors.mjs)
//      writes these for every bundled asset — from the kit's palette
//      texture, its per-material colours, or the source textures' averages.
//   2. The material's own colour, when the GLB has no COLOR_0 but its
//      materials are really coloured (an asset imported before the bake).
//   3. Nothing. Blender's default grey means "no colour was authored"; the
//      mesh falls back to its family colour (MaterialSet).
//
// Results are stored on the cached source objects, which every per-planet
// clone shares:
//   geometry.userData.authoredColors  Float32Array of linear r,g,b per
//                                     vertex, or null
//   scene.userData.authoredColor      { authored, mean } — mean is the
//                                     asset's area-weighted OKLab average

import * as THREE from 'three';
import { meanOklab } from './ColorGrade.js';

// Exporters write these when a material never had a colour assigned:
// Blender's default diffuse (0.64 from OBJ, 0.8 from FBX).
const DEFAULT_GREYS = [0.64, 0.8];
function isDefaultGrey(r, g, b) {
  if (Math.abs(r - g) > 0.01 || Math.abs(g - b) > 0.01) return false;
  return DEFAULT_GREYS.some((v) => Math.abs(r - v) < 0.02);
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _scale = new THREE.Vector3();

/**
 * Surface area each vertex stands for (a third of every triangle it is
 * in), in the asset's own space. Weights the asset mean so a big wall
 * counts for more than a finely modelled doorknob.
 */
function vertexAreas(geometry, matrixWorld) {
  const pos = geometry.attributes.position;
  const out = new Float32Array(pos.count);
  // Node scale → area scale (models here are uniformly scaled or close to it).
  matrixWorld.decompose(_a, new THREE.Quaternion(), _scale);
  const k = Math.abs(_scale.x * _scale.y * _scale.z) ** (2 / 3) || 1;
  const index = geometry.index;
  const triCount = (index ? index.count : pos.count) / 3;
  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    _a.fromBufferAttribute(pos, i0);
    _b.fromBufferAttribute(pos, i1).sub(_a);
    _c.fromBufferAttribute(pos, i2).sub(_a);
    const third = (_b.cross(_c).length() * 0.5 * k) / 3;
    out[i0] += third; out[i1] += third; out[i2] += third;
  }
  return out;
}

/**
 * Authored linear-RGB colour per vertex for one mesh, or null when the mesh
 * carries no real colour.
 */
function authoredColorsOf(mesh) {
  const geometry = mesh.geometry;
  const n = geometry.attributes.position.count;
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  // three keeps material.color in the linear working space.
  const base = mat?.color ? [mat.color.r, mat.color.g, mat.color.b] : [1, 1, 1];
  const attr = geometry.attributes.color;

  if (attr) {
    // COLOR_0 (linear) × base colour factor. getX/Y/Z denormalize integer
    // attributes (Draco-quantised colours arrive as normalized ints).
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      out[i * 3] = attr.getX(i) * base[0];
      out[i * 3 + 1] = attr.getY(i) * base[1];
      out[i * 3 + 2] = attr.getZ(i) * base[2];
    }
    return out;
  }
  // A textured material's base colour is a multiplier on a texture we are
  // not sampling here, so it says nothing on its own. Pure white is the
  // same story: it is what a material carries when its colour lives in a
  // texture (including one that failed to load).
  const isWhite = base[0] > 0.98 && base[1] > 0.98 && base[2] > 0.98;
  if (!mat?.color || mat.map || isWhite || isDefaultGrey(base[0], base[1], base[2])) return null;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = base[0]; out[i * 3 + 1] = base[1]; out[i * 3 + 2] = base[2];
  }
  return out;
}

/**
 * Extract authored colours for every mesh under `scene` (a loaded GLB's
 * root) and the asset's mean colour. Idempotent; call once per cached GLB.
 *
 * @param {THREE.Object3D} scene
 * @returns {{ authored: boolean, mean: [number, number, number] }}
 */
export function prepareAuthoredColor(scene) {
  if (scene.userData.authoredColor) return scene.userData.authoredColor;
  scene.updateMatrixWorld(true);

  const parts = [];
  let total = 0;
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const colors = authoredColorsOf(o);
    o.geometry.userData.authoredColors = colors;
    if (!colors) return;
    parts.push({ colors, weights: vertexAreas(o.geometry, o.matrixWorld) });
    total += colors.length / 3;
  });

  let mean = [0.6, 0, 0];
  if (parts.length) {
    const colors = new Float32Array(total * 3);
    const weights = new Float32Array(total);
    let at = 0;
    for (const p of parts) {
      colors.set(p.colors, at * 3);
      weights.set(p.weights, at);
      at += p.colors.length / 3;
    }
    // Degenerate geometry (all zero-area) → fall back to an unweighted mean.
    mean = meanOklab(colors, weights.some((w) => w > 0) ? weights : null);
  }

  const info = { authored: parts.length > 0, mean };
  scene.userData.authoredColor = info;
  return info;
}
