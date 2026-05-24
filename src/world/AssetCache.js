// Single shared GLB loader + promise-map cache.
//
// Why a promise map rather than just THREE.Cache: THREE.Cache.enabled only
// dedupes raw fetches, you still re-parse on every loadAsync. A Map<url,
// Promise<GLTF>> dedupes parse too and survives concurrent loaders for the
// same URL (two planets streaming in the same frame asking for the same
// hero asset).
//
// The full decoder stack is set up once:
//   - GLTFLoader: base loader
//   - DRACOLoader: KHR_draco_mesh_compression (smaller geometry)
//   - KTX2Loader:  KHR_texture_basisu (much smaller GPU textures)
//   - MeshoptDecoder: EXT_meshopt_compression
//
// All decoders are *lazy* — the .wasm/.js files fetch only when a GLB
// actually uses that compression. Bundled CC0 assets that haven't been run
// through gltfpack just skip the decoder paths entirely.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

import { applyMaterialSet } from './MaterialSet.js';

let _loader = null;
const _cache = new Map();   // url → Promise<GLTF>

/**
 * Lazy singleton; constructed on first use so the decoders don't fetch
 * during initial app boot.
 *
 * @param {THREE.WebGLRenderer} [renderer] - required on first call so KTX2
 *   can detect texture compression support; subsequent calls reuse the
 *   instance and the renderer arg is ignored.
 */
export function getLoader(renderer) {
  if (_loader) return _loader;

  const draco = new DRACOLoader().setDecoderPath('/draco/');
  // KTX2Loader needs the renderer to pick the right transcoded format.
  // Caller is responsible for passing it on the first call.
  const ktx2 = new KTX2Loader().setTranscoderPath('/basis/');
  if (renderer) ktx2.detectSupport(renderer);

  _loader = new GLTFLoader()
    .setDRACOLoader(draco)
    .setKTX2Loader(ktx2)
    .setMeshoptDecoder(MeshoptDecoder);
  return _loader;
}

/**
 * Load a GLB by URL. Returns the parsed GLTF object (the same instance is
 * returned for every caller with the same URL — DO NOT mutate it, clone
 * before applying per-planet material overrides).
 *
 * Throws on load/parse failure. Callers should swap to a fallback asset
 * rather than letting the planet render half-built.
 *
 * @param {string} url
 * @param {THREE.WebGLRenderer} [renderer]
 * @returns {Promise<import('three/addons/loaders/GLTFLoader.js').GLTF>}
 */
export function load(url, renderer) {
  let p = _cache.get(url);
  if (p) return p;
  p = getLoader(renderer).loadAsync(url);
  // On rejection, drop the cache entry so a retry can re-attempt.
  p.catch(() => _cache.delete(url));
  _cache.set(url, p);
  return p;
}

/**
 * Load a GLB and return a per-instance clone with the planet's MaterialSet
 * applied. This is the common path for building planet visuals — the
 * cached source GLTF is the authoritative copy, the returned Group is a
 * fresh clone safe to mutate, translate, and add to scene.
 *
 * The returned clone's `userData.bbox` is a THREE.Box3 in the clone's
 * *local* frame (pre-scale, pre-orientation). Callers use `bbox.min.y` to
 * ground-snap the asset so its visible base touches terrain instead of
 * its origin floating above. Computed once per load and cached on the
 * source gltf.scene so subsequent clones reuse the same Box3 instance.
 *
 * @param {string} url
 * @param {ReturnType<typeof import('./MaterialSet.js').buildMaterialSet>} matSet
 * @param {THREE.WebGLRenderer} [renderer]
 * @param {{ family?: string, assetId?: string }} [assetMeta] - threaded to applyMaterialSet
 * @returns {Promise<THREE.Group>}
 */
export async function loadInstance(url, matSet, renderer, assetMeta) {
  const gltf = await load(url, renderer);
  // Compute & cache the local-frame bbox on the source scene once; every
  // future clone of this asset shares the same Box3 (Box3 is a value type,
  // not GPU-resident — safe to share).
  if (!gltf.scene.userData.bbox) {
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.userData.bbox = new THREE.Box3().setFromObject(gltf.scene);
  }
  // clone(true) shares geometry/material refs by design — fine for static
  // meshes since we override materials on the cloned tree below.
  const root = gltf.scene.clone(true);
  root.userData.bbox = gltf.scene.userData.bbox;
  if (matSet) applyMaterialSet(root, matSet, assetMeta || {});
  // Recompute bounding spheres so frustum culling under floating-origin is
  // correct (GLB-supplied bounds are valid pre-clone but become stale on
  // any per-mesh transform we apply downstream).
  root.traverse((o) => {
    if (o.isMesh && o.geometry && !o.geometry.boundingSphere) {
      o.geometry.computeBoundingSphere();
    }
  });
  return root;
}

/**
 * Drop a single URL from the cache. The underlying GPU resources are NOT
 * disposed here — the caller is responsible for disposing the cloned
 * geometry/material/texture refs on any per-planet instances that were
 * derived from this entry. Used by LRU eviction (Phase 8).
 */
export function evict(url) {
  _cache.delete(url);
}

/**
 * Cache stats for debugging.
 */
export function stats() {
  return { entries: _cache.size, urls: [..._cache.keys()] };
}
