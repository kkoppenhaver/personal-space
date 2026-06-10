import * as THREE from 'three';
import { mulberry32 } from './Seed.js';
import { axisUpQuaternionFor, groundOffsetFor, bboxHeightFor, lateralCenterFor } from './AxisUp.js';
import { blendedUp, embedFractionFor, maxSlopeFor } from './PlacementRules.js';

// Density hint → instance count multiplier. Applied to the per-asset base
// count so a "dense" jungle planet really feels dense without flooding the
// same vertex positions repeatedly.
const DENSITY_MULTIPLIERS = { sparse: 0.4, medium: 1.0, dense: 2.0 };

/**
 * Build instanced surface scatter from selected GLB assets (Phase 4 path).
 * One InstancedMesh per asset URL, all sharing the GLB's first-mesh
 * geometry so we keep the draw-call count tight even with hundreds of
 * instances per planet.
 *
 * Each asset entry in `assets` is `{ glbClone, scaleRange, pack, family, assetMeta }`:
 *   - `glbClone` is a loaded clone from `AssetCache.loadInstance` (matSet
 *     already applied), only used as a source of geometry + material.
 *   - `scaleRange` is `[min, max]` meters from catalog metadata.
 *   - `pack` / `family` / `assetMeta` drive axis-up correction and the
 *     per-family placement rules (slope gate, up-blend, embed).
 *
 * Multi-mesh GLBs: we use the first descendant Mesh's geometry/material.
 * For surface scatter, single-mesh assets are the supported case (Kenney,
 * Quaternius, KayKit low-poly surface props are mostly single meshes;
 * multi-part assets like trees-with-canopy should be re-exported merged).
 *
 * @param {object} args
 * @param {THREE.BufferGeometry} args.geometry  - planet terrain mesh
 * @param {Float32Array} args.elevations
 * @param {number} args.radius
 * @param {number} args.seed
 * @param {{ glbClone: THREE.Object3D, scaleRange: [number, number] }[]} args.assets
 * @param {'sparse'|'medium'|'dense'} [args.density='medium']
 * @returns {THREE.Group}
 */
export function buildInstancedFeaturesFromAssets({ geometry, elevations, radius, seed, assets, density = 'medium' }) {
  const group = new THREE.Group();
  if (!assets || assets.length === 0) return group;

  const densityMult = DENSITY_MULTIPLIERS[density] ?? 1.0;
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  const vCount = pos.count;

  // Per-asset target counts. Split the planet's total scatter budget across
  // the available asset slots so a single "dense" rock doesn't crowd out
  // the tree slot.
  const BASE_PER_ASSET = 120;
  const totalBudget = Math.floor(BASE_PER_ASSET * assets.length * densityMult);

  // Pre-pick surface candidate vertex indices (e ≥ 0.46, i.e. land above
  // basin band). We then walk this list assigning indices round-robin
  // across assets — guarantees they share the same surface coverage rather
  // than each asset clustering in whichever vertex slice it samples first.
  const candidates = [];
  for (let i = 0; i < vCount; i++) {
    if (elevations[i] >= 0.46) candidates.push(i);
  }
  if (candidates.length === 0) return group;

  // Shuffle deterministically so per-planet scatter is stable across
  // restarts but doesn't repeat across planets.
  const rand = mulberry32(seed ^ 0xfeed);
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const samples = Math.min(totalBudget, candidates.length);

  // Per-asset instance buckets.
  const buckets = assets.map(() => []);
  // Pre-resolve per-asset placement constants once. Cheaper than
  // recomputing per instance, and the bbox is shared across all
  // instances of the same asset anyway.
  const perAsset = assets.map((a) => {
    const bbox = a.glbClone?.userData?.bbox;
    return {
      bboxOffset: groundOffsetFor(bbox, a.pack, a.assetMeta),
      embedHeight: embedFractionFor(a.family) * bboxHeightFor(bbox, a.pack, a.assetMeta),
      axisUp: axisUpQuaternionFor(a.pack, a.assetMeta),
      lateral: lateralCenterFor(bbox, a.pack, a.assetMeta),
      maxSlope: maxSlopeFor(a.family),
      family: a.family ?? null,
    };
  });

  // Walk shuffled candidates, assigning each vertex round-robin across
  // assets — but skip assets whose slope gate rejects the vertex (a tree
  // doesn't grow on a cliff face; a rock is happy anywhere). A vertex no
  // asset accepts is dropped. Iterates past `samples` to refill what the
  // gates reject, up to the full candidate pool.
  const tmp = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  let assigned = 0;
  for (let s = 0; s < candidates.length && assigned < samples; s++) {
    const idx = candidates[s];
    tmp.fromBufferAttribute(pos, idx);
    const r = tmp.length();
    const dir = tmp.clone().divideScalar(r);
    nrm.fromBufferAttribute(nor, idx).normalize();
    const slope = 1 - dir.dot(nrm);
    for (let k = 0; k < assets.length; k++) {
      const bucketIdx = (assigned + k) % assets.length;
      if (slope > perAsset[bucketIdx].maxSlope) continue;
      const [minS, maxS] = assets[bucketIdx].scaleRange ?? [0.5, 1.5];
      const scale = minS + (maxS - minS) * rand();
      buckets[bucketIdx].push({ dir, normal: nrm.clone(), height: r, scale, twist: rand() * Math.PI * 2 });
      assigned++;
      break;
    }
  }

  // Bounding sphere big enough to cover surface band — same trick as the
  // procedural path. Without this an InstancedMesh culls based on the
  // single-instance bound and pops entire scatter clouds when the planet
  // center exits the frustum.
  const featureBound = new THREE.Sphere(new THREE.Vector3(0, 0, 0), radius * 1.1);

  // ── Build one InstancedMesh per asset ────────────────────────────
  for (let aIdx = 0; aIdx < assets.length; aIdx++) {
    const transforms = buckets[aIdx];
    if (transforms.length === 0) continue;

    const { geom, mat } = extractFirstMeshGeometry(assets[aIdx].glbClone);
    if (!geom || !mat) continue;

    const inst = new THREE.InstancedMesh(geom, mat, transforms.length);
    const dummy = new THREE.Object3D();
    const { bboxOffset, embedHeight, axisUp, lateral, family } = perAsset[aIdx];
    const up = new THREE.Vector3();
    const yAxis = new THREE.Vector3(0, 1, 0);
    const surfaceUp = new THREE.Quaternion();
    const spin = new THREE.Quaternion();
    const recenter = new THREE.Vector3();
    transforms.forEach((t, i) => {
      // Up-vector: radial leaned toward the terrain normal per family
      // (rocks conform to the hillside, flora stays near-plumb).
      blendedUp(t.dir, t.normal, family, up);
      // Grounding: signed bbox base offset (pull-down included) minus the
      // family's embed depth, applied along the instance's up.
      dummy.position.copy(t.dir).multiplyScalar(t.height)
        .addScaledVector(up, (bboxOffset - embedHeight) * t.scale);
      surfaceUp.setFromUnitVectors(yAxis, up);
      spin.setFromAxisAngle(up, t.twist);
      // Compose: axisUp (asset-local) → surfaceUp (slot) → spin.
      dummy.quaternion.copy(spin).multiply(surfaceUp).multiply(axisUp);
      // Corner-pivot fix: keep the footprint centered on the sample point.
      recenter.copy(lateral).multiplyScalar(t.scale).applyQuaternion(dummy.quaternion);
      dummy.position.add(recenter);
      dummy.scale.setScalar(t.scale);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    });
    inst.instanceMatrix.needsUpdate = true;
    inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    inst.boundingSphere = featureBound.clone();
    inst.userData.assetIndex = aIdx;
    group.add(inst);
  }

  return group;
}

function extractFirstMeshGeometry(root) {
  let mesh = null;
  root.traverse((o) => {
    if (mesh) return;
    if (o.isMesh && o.geometry && o.material) mesh = o;
  });
  if (!mesh) return { geom: null, mat: null };
  // Use the (clone's) geometry directly — instancing shares it across all N
  // instances. The clone is otherwise discarded after this; the geometry
  // outlives it through the InstancedMesh reference.
  return { geom: mesh.geometry, mat: mesh.material };
}

export function buildInstancedFeatures({ geometry, elevations, radius, seed, palette, excludeZone = null }) {
  const rand = mulberry32(seed ^ 0xfeed);
  const group = new THREE.Group();
  const pos = geometry.attributes.position;
  const vCount = pos.count;

  // Pick "anchor" vertices in each band by sampling many random vertex indices.
  const samples = 2200;
  const rockTransforms = [];
  const floraTransforms = [];
  const tmp = new THREE.Vector3();
  const exCenter = excludeZone?.center;
  const exR = excludeZone?.radius ?? 0;
  const exR2 = exR * exR;

  for (let s = 0; s < samples; s++) {
    const i = Math.floor(rand() * vCount);
    const e = elevations[i];
    if (e < 0.43) continue; // skip water
    tmp.fromBufferAttribute(pos, i);
    // Skip exclusion zone (e.g. landing pad area)
    if (exCenter && tmp.distanceToSquared(exCenter) < exR2) continue;
    const r = tmp.length();
    const dir = tmp.clone().divideScalar(r);
    if (e > 0.75) {
      // rocks on high elevation
      const size = 0.6 + rand() * 1.2;
      rockTransforms.push({ dir, height: r, size, twist: rand() * Math.PI * 2 });
    } else if (e > 0.46 && e < 0.7) {
      // flora on mid bands
      if (rand() < 0.7) {
        const size = 0.5 + rand() * 0.8;
        floraTransforms.push({ dir, height: r, size, twist: rand() * Math.PI * 2 });
      }
    }
  }

  // Bounding sphere that encompasses every instance. InstancedMesh defaults to
  // culling based on the per-instance geometry (1m for a rock) — once the
  // planet's render center passes outside the frustum the entire features
  // cloud pops out. Setting an explicit bound covering the planet's surface
  // band keeps the cloud rendered until the camera actually looks away.
  const featureBound = new THREE.Sphere(new THREE.Vector3(0, 0, 0), radius * 1.1);

  // ROCKS: low-poly tetrahedron
  if (rockTransforms.length > 0) {
    const g = new THREE.TetrahedronGeometry(1.0, 0);
    const m = new THREE.MeshLambertMaterial({ color: new THREE.Color(palette.high).multiplyScalar(0.9), flatShading: true });
    const inst = new THREE.InstancedMesh(g, m, rockTransforms.length);
    const dummy = new THREE.Object3D();
    rockTransforms.forEach((t, i) => {
      const up = t.dir;
      dummy.position.copy(up).multiplyScalar(t.height + 0.4 * t.size);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
      const qSpin = new THREE.Quaternion().setFromAxisAngle(up, t.twist);
      dummy.quaternion.copy(qSpin).multiply(q);
      dummy.scale.setScalar(t.size);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    });
    inst.instanceMatrix.needsUpdate = true;
    inst.boundingSphere = featureBound.clone();
    group.add(inst);
  }

  // FLORA: cone "mushroom-tree"
  if (floraTransforms.length > 0) {
    const g = new THREE.ConeGeometry(0.9, 2.2, 5);
    const m = new THREE.MeshLambertMaterial({ color: new THREE.Color(palette.low).multiplyScalar(0.85), flatShading: true });
    const inst = new THREE.InstancedMesh(g, m, floraTransforms.length);
    const dummy = new THREE.Object3D();
    floraTransforms.forEach((t, i) => {
      const up = t.dir;
      dummy.position.copy(up).multiplyScalar(t.height + 1.0 * t.size);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
      const qSpin = new THREE.Quaternion().setFromAxisAngle(up, t.twist);
      dummy.quaternion.copy(qSpin).multiply(q);
      dummy.scale.setScalar(t.size);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    });
    inst.instanceMatrix.needsUpdate = true;
    inst.boundingSphere = featureBound.clone();
    group.add(inst);
  }

  return group;
}
