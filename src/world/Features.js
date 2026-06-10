import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './Seed.js';
import { axisUpQuaternionFor, groundOffsetFor, bboxHeightFor, lateralCenterFor } from './AxisUp.js';
import { blendedUp, embedFractionFor, maxSlopeFor, surfaceBandFor, resolveScale } from './PlacementRules.js';

// Density hint → instance count multiplier. Applied to the per-asset base
// count so a "dense" jungle planet really feels dense without flooding the
// same vertex positions repeatedly.
const DENSITY_MULTIPLIERS = { sparse: 0.4, medium: 1.0, dense: 2.0 };

// Clustering tuning (Phase 13b). Real places group: groves, rock fields,
// debris. Each asset's budget lands ~80% in a handful of angular clusters
// and ~20% as global strays so the space between clusters isn't sterile.
const CLUSTER_MEMBERS = 12;       // target instances per cluster
const CLUSTER_RADIUS_DOT = 0.985; // ~10° — grove radius (≈10u at radius 60)
const CENTER_SPREAD_DOT = 0.92;   // ~23° minimum spacing between centers
const CLUSTER_SHARE = 0.8;

/**
 * Build instanced surface scatter from selected GLB assets.
 * One InstancedMesh per asset URL; multi-mesh GLBs are merged into a
 * single geometry (material array via groups) so the rendered thing
 * matches the bbox used to ground it.
 *
 * Each asset entry in `assets` is `{ glbClone, scaleRange, pack, family, assetMeta }`:
 *   - `glbClone` is a loaded clone from `AssetCache.loadInstance` (matSet
 *     already applied), only used as a source of geometry + material.
 *   - `scaleRange` is the fallback size bias when the catalog record has
 *     no scale_range; scale itself is bbox-normalized (PlacementRules).
 *   - `pack` / `family` / `assetMeta` drive axis-up correction and the
 *     per-family placement rules (slope gate, band, up-blend, embed).
 *
 * Placement is clustered and band-aware: per-asset cluster centers with a
 * minimum angular spread, members within a grove radius, a stray share
 * scattered planet-wide, all gated by family slope/elevation rules and
 * excluded from landmark footprints.
 *
 * @param {object} args
 * @param {THREE.BufferGeometry} args.geometry  - planet terrain mesh
 * @param {Float32Array} args.elevations
 * @param {number} args.radius
 * @param {number} args.seed
 * @param {{ glbClone: THREE.Object3D, scaleRange: [number, number] }[]} args.assets
 * @param {'sparse'|'medium'|'dense'} [args.density='medium']
 * @param {number} [args.seaLevel=0.42] - elevation quantile (archetype-driven)
 * @param {{ direction: THREE.Vector3, minDot: number }[]} [args.excludeZones] - landmark footprints
 * @returns {THREE.Group}
 */
export function buildInstancedFeaturesFromAssets({ geometry, elevations, radius, seed, assets, density = 'medium', seaLevel = 0.42, excludeZones = [] }) {
  const group = new THREE.Group();
  if (!assets || assets.length === 0) return group;

  const densityMult = DENSITY_MULTIPLIERS[density] ?? 1.0;
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  const vCount = pos.count;

  const BASE_PER_ASSET = 120;
  const perAssetBudget = Math.floor(BASE_PER_ASSET * densityMult);

  // ── Gather land candidates once (shared across assets) ────────────
  // Everything above the waterline, outside landmark footprints, with
  // direction/normal/slope precomputed. ~10k verts at subdivisions=5 —
  // cheap to materialize.
  const rand = mulberry32(seed ^ 0xfeed);
  const tmp = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const all = [];
  for (let i = 0; i < vCount; i++) {
    const e = elevations[i];
    if (e < seaLevel + 0.005) continue;
    tmp.fromBufferAttribute(pos, i);
    const r = tmp.length();
    const dir = tmp.clone().divideScalar(r);
    let excluded = false;
    for (const z of excludeZones) {
      if (dir.dot(z.direction) > z.minDot) { excluded = true; break; }
    }
    if (excluded) continue;
    nrm.fromBufferAttribute(nor, i).normalize();
    all.push({ dir, normal: nrm.clone(), height: r, slope: 1 - dir.dot(nrm), e });
  }
  if (all.length === 0) return group;
  // Deterministic shuffle: stable per planet, varied across planets.
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }

  // Per-asset placement constants.
  const perAsset = assets.map((a) => {
    const bbox = a.glbClone?.userData?.bbox;
    return {
      bboxOffset: groundOffsetFor(bbox, a.pack, a.assetMeta),
      embedHeight: embedFractionFor(a.family) * bboxHeightFor(bbox, a.pack, a.assetMeta),
      bboxHeight: bboxHeightFor(bbox, a.pack, a.assetMeta),
      axisUp: axisUpQuaternionFor(a.pack, a.assetMeta),
      lateral: lateralCenterFor(bbox, a.pack, a.assetMeta),
      maxSlope: maxSlopeFor(a.family),
      band: surfaceBandFor(a.family, seaLevel),
      family: a.family ?? null,
    };
  });

  // ── Cluster + assign per asset ─────────────────────────────────────
  const used = new Set();   // vertices already claimed (no co-located doubles)
  const buckets = assets.map(() => []);

  for (let aIdx = 0; aIdx < assets.length; aIdx++) {
    const pa = perAsset[aIdx];
    let eligible = all.filter((c) => !used.has(c) && c.slope <= pa.maxSlope
      && c.e >= pa.band[0] && c.e <= pa.band[1]);
    if (eligible.length < perAssetBudget * 0.5) {
      // Thin band (high sea level, crowded planet) — relax the band but
      // keep the slope gate; floating-tree glitches beat empty planets,
      // tilted-tree glitches don't.
      eligible = all.filter((c) => !used.has(c) && c.slope <= pa.maxSlope);
    }
    if (eligible.length === 0) continue;
    const count = Math.min(perAssetBudget, eligible.length);

    // Cluster centers: greedy angular spread over the (shuffled) pool.
    const nClusters = Math.max(1, Math.round(count / CLUSTER_MEMBERS));
    const centers = [];
    for (const c of eligible) {
      if (centers.length >= nClusters) break;
      if (centers.every((ct) => ct.dir.dot(c.dir) < CENTER_SPREAD_DOT)) centers.push(c);
    }

    // Members within a grove radius of any center vs strays everywhere.
    const clustered = [];
    const stray = [];
    for (const c of eligible) {
      (centers.some((ct) => c.dir.dot(ct.dir) > CLUSTER_RADIUS_DOT) ? clustered : stray).push(c);
    }
    const takeClustered = Math.min(clustered.length, Math.round(count * CLUSTER_SHARE));
    const picks = clustered.slice(0, takeClustered);
    picks.push(...stray.slice(0, count - picks.length));
    if (picks.length < count) {
      picks.push(...clustered.slice(takeClustered, takeClustered + count - picks.length));
    }

    for (const c of picks) {
      used.add(c);
      const scale = resolveScale({
        role: 'surface',
        scaleRange: assets[aIdx].assetMeta?.scale_range ?? assets[aIdx].scaleRange,
        scaleOverride: assets[aIdx].assetMeta?.scale_override ?? null,
        bboxHeight: pa.bboxHeight,
        rand,
      });
      buckets[aIdx].push({ dir: c.dir, normal: c.normal, height: c.height, scale, twist: rand() * Math.PI * 2 });
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

    const { geom, mat } = extractMergedGeometry(assets[aIdx].glbClone);
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

/**
 * Geometry + material for instancing a whole GLB (Phase 13b).
 *
 * Single-mesh assets (the common case) pass through untouched — the
 * instancing shares the source geometry. Multi-mesh assets (tree trunk +
 * canopy, ruins with separate rubble) are baked into ONE merged geometry
 * with material groups, so the rendered instance matches the whole-model
 * bbox the grounding math uses — previously only the first child mesh
 * rendered (a tree-with-canopy scattered as bare trunks).
 *
 * The merged geometry is freshly allocated per planet (the per-mesh
 * transforms are baked in), so the dispose in `Planet._replaceGroup`
 * is safe and correct for it.
 */
function extractMergedGeometry(root) {
  const meshes = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (o.isMesh && o.geometry && o.material) meshes.push(o);
  });
  if (meshes.length === 0) return { geom: null, mat: null };
  if (meshes.length === 1) return { geom: meshes[0].geometry, mat: meshes[0].material };

  // Bake each child's transform (root is unmounted → matrixWorld is the
  // local chain), normalize attribute sets to the shared subset, and
  // unify indexing so mergeGeometries accepts the lot.
  let geoms = meshes.map((o) => {
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    g.morphAttributes = {};
    return g;
  });
  const common = geoms
    .map((g) => new Set(Object.keys(g.attributes)))
    .reduce((a, b) => new Set([...a].filter((k) => b.has(k))));
  for (const g of geoms) {
    for (const k of Object.keys(g.attributes)) {
      if (!common.has(k)) g.deleteAttribute(k);
    }
  }
  if (!geoms.every((g) => g.index)) {
    geoms = geoms.map((g) => (g.index ? g.toNonIndexed() : g));
  }
  const merged = mergeGeometries(geoms, true);   // true → material groups
  if (!merged) {
    console.warn('[Features] geometry merge failed; falling back to first mesh');
    return { geom: meshes[0].geometry, mat: meshes[0].material };
  }
  return { geom: merged, mat: meshes.map((o) => o.material) };
}

export function buildInstancedFeatures({ geometry, elevations, radius, seed, palette, excludeZone = null, seaLevel = 0.42 }) {
  const rand = mulberry32(seed ^ 0xfeed);
  const group = new THREE.Group();
  const pos = geometry.attributes.position;
  const vCount = pos.count;
  // Band thresholds relative to sea level (matches the historical absolute
  // constants at the 0.42 default: skip <0.43, flora 0.46-0.70, rocks >0.75).
  const land = 1 - seaLevel || 1;
  const skipBelow = seaLevel + 0.01;
  const floraLo = seaLevel + 0.04;
  const floraHi = seaLevel + 0.48 * land;
  const rockLo = seaLevel + 0.57 * land;

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
    if (e < skipBelow) continue; // skip water
    tmp.fromBufferAttribute(pos, i);
    // Skip exclusion zone (e.g. landing pad area)
    if (exCenter && tmp.distanceToSquared(exCenter) < exR2) continue;
    const r = tmp.length();
    const dir = tmp.clone().divideScalar(r);
    if (e > rockLo) {
      // rocks on high elevation
      const size = 0.6 + rand() * 1.2;
      rockTransforms.push({ dir, height: r, size, twist: rand() * Math.PI * 2 });
    } else if (e > floraLo && e < floraHi) {
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
