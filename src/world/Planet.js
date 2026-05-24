import * as THREE from 'three';
import { buildPlanetGeometry, makeTerrainSampler } from './TerrainGen.js';
import {
  pickLandmarkSlots,
  buildLandmarkMeshes,
  buildLandmarkInstance,
} from './Landmarks.js';
import {
  buildInstancedFeatures,
  buildInstancedFeaturesFromAssets,
} from './Features.js';
import { Coverage } from './Coverage.js';
import { buildMaterialSet, disposeMaterialSet } from './MaterialSet.js';
import { loadInstance } from './AssetCache.js';
import { isDebugOn, attachInstanceHelpers, detachInstanceHelpers } from './DebugPlacement.js';
import { patchReveal } from './RevealMaterial.js';

// Seeds whose asset reveal has completed at least once. A planet streamed
// out and back in mounts solid (no re-fade on every home-system flyby).
// Keyed by seed so it survives Planet disposal; capped FIFO to bound growth.
const revealedSeeds = new Set();
const REVEALED_SEEDS_CAP = 1000;
function markSeedRevealed(seed) {
  if (revealedSeeds.has(seed)) return;
  if (revealedSeeds.size >= REVEALED_SEEDS_CAP) {
    revealedSeeds.delete(revealedSeeds.values().next().value);
  }
  revealedSeeds.add(seed);
}

// Honor prefers-reduced-motion: skip the dither tween, mount solid.
const _reducedMotion = typeof window !== 'undefined'
  && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Reveal tween: ease-out cubic. Distant arrival is slower (player still high
// in the atmosphere when assets were ready); late arrival is a quick catch-up
// (assets mounted while the plane had already descended).
const REVEAL_DISTANT_MS = 500;
const REVEAL_LATE_MS = 250;
// Altitude fraction (0 = surface, 1 = atmosphere top) below which a trigger
// counts as "late arrival".
const REVEAL_LATE_ALT_FRAC = 0.5;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

function makeDeferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// A Planet builds eager terrain + collider + landmark slot positions in its
// constructor (fast, deterministic from seed). Visual layers — landmark and
// feature meshes — start out procedural (today's behavior) and are replaced
// in place by `applyVisuals(...)` when the Tier 2 LLM pipeline resolves with
// selected GLB asset IDs. Stale loads (player swerved to a different planet,
// or the planet was disposed mid-flight) are dropped silently via the
// `visualGen` counter.

export class Planet {
  constructor({ rapier, world, seed, radius, center = new THREE.Vector3(0, 0, 0) }) {
    this.seed = seed;
    this.radius = radius;
    this.center = center.clone();
    this.meta = null;

    // Bumped by every applyVisuals call and by dispose(). Async asset loads
    // capture the value at start and check it before mounting. Stale loads
    // — from a planet that was despawned, or from a superseded swerve —
    // see a mismatch and bail without touching the scene.
    this.visualGen = 0;
    // Built lazily on first applyVisuals() so dispose() has something to
    // tear down even on the procedural-only path.
    this.matSet = null;
    // Reveal-as-you-fly state; set in applyVisuals when real assets mount.
    // Null means "no GLB visuals" → claim captures the procedural frame now.
    this.reveal = null;

    const built = buildPlanetGeometry({ seed, radius });
    this.geometry = built.geometry;
    this.elevations = built.elevations;
    this.palette = built.palette;
    this.seaLevel = built.seaLevel;

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.mesh = new THREE.Mesh(this.geometry, mat);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // Tag so the MaterialSet audit (Phase 6) exempts the terrain — it uses
    // its own vertex-colored material, not a per-mesh matSet clone.
    this.mesh.userData.matSlot = 'terrain';

    // Sampler for fast altitude queries without raycasting.
    this.sample = makeTerrainSampler({ seed, radius, seaLevel: built.seaLevel });

    // Pick landmark slots from the actual mesh. Stable for a given seed —
    // applyVisuals later binds GLB clones to these same slots.
    this.landmarks = pickLandmarkSlots({
      geometry: this.geometry,
      elevations: this.elevations,
      radius,
      seed,
      count: 5,
    });

    // Procedural landmark + feature groups — visible from spawn so the planet
    // never looks empty during approach. applyVisuals will swap these out
    // when Tier 2 returns asset selections.
    this.landmarkGroup = buildLandmarkMeshes(this.landmarks, this.palette);
    this.landmarkGroup.userData.procedural = true;

    this.coverage = new Coverage();
    this.claimed = false;

    this.featuresGroup = buildInstancedFeatures({
      geometry: this.geometry,
      elevations: this.elevations,
      radius,
      seed,
      palette: this.palette,
    });
    this.featuresGroup.userData.procedural = true;

    this.group = new THREE.Group();
    this.group.add(this.mesh);
    this.group.add(this.landmarkGroup);
    this.group.add(this.featuresGroup);
    this.group.position.copy(this.center);

    // Rapier trimesh collider
    const indices = this.geometry.index ? this.geometry.index.array : null;
    const vertices = this.geometry.attributes.position.array;
    const idxArray = indices ? new Uint32Array(indices) : new Uint32Array((() => {
      const n = vertices.length / 3;
      const a = new Uint32Array(n);
      for (let i = 0; i < n; i++) a[i] = i;
      return a;
    })());
    const bodyDesc = rapier.RigidBodyDesc.fixed().setTranslation(center.x, center.y, center.z);
    this.body = world.createRigidBody(bodyDesc);
    const colDesc = rapier.ColliderDesc.trimesh(new Float32Array(vertices), idxArray)
      .setFriction(0.6).setRestitution(0.2)
      .setActiveEvents(rapier.ActiveEvents.COLLISION_EVENTS);
    this.collider = world.createCollider(colDesc, this.body);
  }

  // Distance from `pos` (world coords) along surface up direction → altitude above terrain.
  altitudeAbove(pos) {
    const rel = pos.clone().sub(this.center);
    const r = rel.length();
    const dir = rel.divideScalar(r || 1);
    const h = this.sample(dir.x, dir.y, dir.z);
    return r - h;
  }

  // Add `delta` to this planet's render position. Updates the Three group,
  // the Rapier body, and the cached center. Children (landmarks, features,
  // landing zone) auto-follow because they're parented under `this.group`.
  translate(delta) {
    this.center.add(delta);
    this.group.position.copy(this.center);
    this.body.setTranslation({ x: this.center.x, y: this.center.y, z: this.center.z }, true);
  }

  /**
   * Apply Tier 2 LLM output. Names + palette take effect immediately
   * (synchronously); GLB asset binding is deferred to applyVisuals which
   * runs asynchronously and tolerates the planet despawning mid-load.
   *
   * For backward compat: this is the existing single-entry from main.js.
   * Callers that have GLB selections can call applyVisuals directly with
   * the resolved asset records and the renderer ref.
   *
   * @param {object} meta - shape from LLMClient.approach()
   */
  applyLLM(meta) {
    this.meta = meta;
    if (!meta) return;
    if (Array.isArray(meta.landmarks)) {
      for (const m of meta.landmarks) {
        const lm = this.landmarks.find(l => l.slotId === m.slotId);
        if (lm) lm.name = m.name || lm.name;
      }
    }
    // Palette retint + matSet refresh is also handled by applyVisuals, but
    // we run it here too so callers that never reach applyVisuals (no
    // selected_assets in meta) still see the palette take effect.
    if (meta.palette) {
      this.palette = { ...this.palette, ...meta.palette };
      this._reTintVertexColors();
    }
  }

  /**
   * Deferred build of LLM-driven planet visuals: hero asset + landmark GLBs
   * bound to slots + instanced surface scatter from selected assets. Safe to
   * call multiple times; each call captures the current visualGen and bails
   * silently if a later call (or dispose) supersedes it before its async
   * loads resolve.
   *
   * Per-asset try/catch — a single GLB failure leaves the rest of the
   * planet intact, with the procedural fallback retained for the failing
   * slot.
   *
   * Asset records (heroAsset/landmarkAssets[]/surfaceAssets[]) come from
   * the catalog and carry `family`, `pack`, `id`, `scale_range`, and
   * optionally `scale_override`. The first three drive the dual-axis
   * color system; the latter two drive scale.
   *
   * @param {object} opts
   * @param {object} [opts.palette]
   * @param {string} [opts.biome]                 - LLM biome enum (forest|desert|...)
   * @param {object} [opts.heroAsset]             - catalog record
   * @param {Array<object|null>} [opts.landmarkAssets]
   * @param {Array<object>} [opts.surfaceAssets]
   * @param {'sparse'|'medium'|'dense'} [opts.density]
   * @param {THREE.WebGLRenderer} [opts.renderer] - required by AssetCache for KTX2 support
   */
  async applyVisuals(opts = {}) {
    this.visualGen++;
    const gen = this.visualGen;
    const { palette, biome, heroAsset, landmarkAssets, surfaceAssets, density = 'medium', renderer } = opts;

    // ── Palette + matSet refresh (always synchronous) ────────────────
    if (palette) {
      this.palette = { ...this.palette, ...palette };
      this._reTintVertexColors();
    }
    if (this.matSet) disposeMaterialSet(this.matSet);
    this.matSet = buildMaterialSet(this.palette, { biome });

    // Backward-compat path: no asset selections → palette-only update.
    const hasAnyAsset = !!heroAsset || (Array.isArray(landmarkAssets) && landmarkAssets.length)
                      || (Array.isArray(surfaceAssets) && surfaceAssets.length);
    if (!hasAnyAsset) return;

    // Reveal state — set up before loads so the claim path can await
    // readiness even if the player claims mid-load. Latest applyVisuals call
    // wins (overwrites a superseded one); the claim ceiling backstops any
    // orphaned deferred.
    const mounted = makeDeferred();
    const done = makeDeferred();
    this.reveal = {
      state: 'LOADING',       // LOADING → MOUNTED → REVEALING → REVEALED
      assetsRequested: true,
      uniforms: [],           // uReveal refs to drive (one per mounted material)
      durationMs: REVEAL_DISTANT_MS,
      elapsedMs: 0,
      mounted: mounted.promise, _resolveMounted: mounted.resolve,
      done: done.promise, _resolveDone: done.resolve,
    };

    // ── Resolve slot bindings ────────────────────────────────────────
    // Hero takes the rarest available landmark slot (prefer spire), then
    // landmark_a/b/c fill the remaining slots in order.
    const heroSlot = heroAsset ? this._pickHeroSlot() : null;
    const remainingSlots = heroSlot
      ? this.landmarks.filter((s) => s !== heroSlot)
      : this.landmarks.slice();

    // ── Async loads (parallel, per-task try/catch) ───────────────────
    const heroPromise = heroAsset
      ? this._loadAssetSafe(heroAsset.url, renderer, 'hero', _assetMetaOf(heroAsset))
      : Promise.resolve(null);

    const landmarkPromises = (landmarkAssets || []).map((a, i) => {
      if (!a || !remainingSlots[i]) return Promise.resolve(null);
      return this._loadAssetSafe(a.url, renderer, `landmark[${i}]`, _assetMetaOf(a));
    });

    const surfacePromises = (surfaceAssets || []).map((a, i) =>
      a ? this._loadAssetSafe(a.url, renderer, `surface[${i}]`, _assetMetaOf(a)) : Promise.resolve(null)
    );

    // Await each set independently so a slow tail asset doesn't block the
    // others. We still wait for all before mounting — the plan calls for a
    // single-frame mount, no partial state.
    const [heroClone, landmarkClones, surfaceClones] = await Promise.all([
      heroPromise,
      Promise.all(landmarkPromises),
      Promise.all(surfacePromises),
    ]);

    // ── Cancellation check ───────────────────────────────────────────
    // If a newer applyVisuals call or dispose ran while we were loading,
    // visualGen will have moved on. Drop everything silently.
    if (this.visualGen !== gen) return;

    // ── Build new groups, then swap in a single frame ────────────────
    // We rebuild landmark group symmetrically: every slot ends up with
    // either a GLB instance (if the asset loaded) or a procedural marker
    // (fallback). That way an all-GLB-failed planet still reads like a
    // planet, not a featureless ball.
    const newLandmarkGroup = new THREE.Group();
    const slotsHandled = new Set();

    // Hero — bind GLB if available, otherwise fall back to a procedural
    // marker so the slot still has something.
    if (heroSlot) {
      if (heroClone) {
        const hero = buildLandmarkInstance({
          slot: heroSlot,
          gltfClone: heroClone,
          scaleRange: _scaleRangeOf(heroAsset, [6, 12]),
          pack: heroAsset.pack,
          seed: this.seed,
        });
        hero.userData.role = 'hero';
        hero.userData.assetId = heroAsset.id;
        newLandmarkGroup.add(hero);
      } else if (heroAsset) {
        // Hero asset requested but failed — procedural marker for the slot.
        newLandmarkGroup.add(buildLandmarkMeshes([heroSlot], this.palette));
      }
      slotsHandled.add(heroSlot);
    }

    // Landmarks — each failed slot falls back to a procedural marker.
    for (let i = 0; i < (landmarkAssets || []).length; i++) {
      const slot = remainingSlots[i];
      if (!slot) break;
      const clone = landmarkClones[i];
      const asset = landmarkAssets[i];
      if (clone) {
        const lm = buildLandmarkInstance({
          slot,
          gltfClone: clone,
          scaleRange: _scaleRangeOf(asset, [3, 6]),
          pack: asset?.pack,
          seed: this.seed,
        });
        lm.userData.role = 'landmark';
        lm.userData.assetId = asset?.id;
        newLandmarkGroup.add(lm);
      } else if (asset) {
        newLandmarkGroup.add(buildLandmarkMeshes([slot], this.palette));
      }
      slotsHandled.add(slot);
    }

    // Catch-all: any landmark slot that the LLM didn't pick an asset for
    // still gets its procedural marker so the planet's silhouette stays
    // consistent across visits regardless of how many assets Tier 2 chose.
    const unhandledSlots = this.landmarks.filter((s) => !slotsHandled.has(s));
    if (unhandledSlots.length) {
      newLandmarkGroup.add(buildLandmarkMeshes(unhandledSlots, this.palette));
    }

    // If hero AND landmarks were both omitted, keep the current procedural
    // landmark group (no need to replace identical content).
    const replacingLandmarks = heroAsset || (landmarkAssets && landmarkAssets.length);

    // Features (one InstancedMesh per surface asset)
    const successfulSurfaceAssets = (surfaceAssets || [])
      .map((a, i) => ({ asset: a, clone: surfaceClones[i] }))
      .filter((x) => x.clone)
      .map((x) => ({
        glbClone: x.clone,
        scaleRange: _scaleRangeOf(x.asset, [0.5, 1.5]),
        pack: x.asset?.pack,
      }));

    let newFeaturesGroup = null;
    if (successfulSurfaceAssets.length) {
      newFeaturesGroup = buildInstancedFeaturesFromAssets({
        geometry: this.geometry,
        elevations: this.elevations,
        radius: this.radius,
        seed: this.seed,
        assets: successfulSurfaceAssets,
        density,
      });
    }

    // Mount on the next animation frame so the swap aligns with the GPU's
    // frame boundary (avoids a brief flicker on the swap-out path).
    await new Promise((r) => requestAnimationFrame(r));
    // Re-check gen after the rAF in case the player despawned within the
    // same frame.
    if (this.visualGen !== gen) return;

    if (replacingLandmarks) {
      this._replaceGroup('landmarkGroup', newLandmarkGroup);
    }
    if (newFeaturesGroup) {
      this._replaceGroup('featuresGroup', newFeaturesGroup);
    }
    // Match SolarSystem's blanket `frustumCulled = false` policy for any
    // freshly-mounted meshes. Phase 8 will revisit this with proper
    // per-mesh bounds + instanced chunk culling.
    if (replacingLandmarks) this.landmarkGroup.traverse((c) => { c.frustumCulled = false; });
    if (newFeaturesGroup) this.featuresGroup.traverse((c) => { c.frustumCulled = false; });

    // ── Reveal patch ─────────────────────────────────────────────────
    // Patch a uReveal dither-clip onto every freshly-mounted asset material
    // (landmark clones + surface InstancedMesh materials), starting hidden.
    // Terrain is NOT patched — the planet stays a visible veiled sphere; only
    // surface detail materializes on atmosphere entry. One uReveal per
    // material (InstancedMesh shares one → one uniform covers all instances).
    const rv = this.reveal;
    const collect = (group) => group?.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      if (!o.material.userData.revealUniform) {
        o.material.userData.revealUniform = patchReveal(o.material, 0);
      }
      rv.uniforms.push(o.material.userData.revealUniform);
    });
    if (replacingLandmarks) collect(this.landmarkGroup);
    if (newFeaturesGroup) collect(this.featuresGroup);

    rv._resolveMounted();
    if (revealedSeeds.has(this.seed) || _reducedMotion) {
      // Re-approach or reduced-motion → mount solid, no fade.
      this._setReveal(1);
      rv.state = 'REVEALED';
      rv._resolveDone();
    } else {
      // Hold hidden; tickReveal triggers the fade on atmosphere entry.
      rv.state = 'MOUNTED';
    }

    // Debug overlay (off by default; flip __GAME.debugPlacement to enable).
    if (isDebugOn() && replacingLandmarks) {
      this._refreshDebugHelpers();
    }
  }

  /**
   * Advance the asset reveal. Called per-frame from the render loop for every
   * loaded planet (not just the active one, so a reveal mid-approach doesn't
   * freeze). dt is seconds. `planePos` drives the entry trigger; `camera`
   * + `atmosphere` size the curve.
   */
  tickReveal(dt, planePos, camera, atmosphere) {
    const rv = this.reveal;
    if (!rv) return;

    if (rv.state === 'MOUNTED') {
      if (!atmosphere?.contains(planePos)) return;   // not in the atmosphere yet
      // Curve: if the plane is already low when the reveal fires (assets
      // arrived late while descending), do the quick 250ms catch-up; if it
      // just grazed the atmosphere top, the slower 500ms materialize.
      const shell = Math.max(1e-3, atmosphere.radius - this.radius);
      const altFrac = (planePos.distanceTo(this.center) - this.radius) / shell;
      rv.durationMs = altFrac < REVEAL_LATE_ALT_FRAC ? REVEAL_LATE_MS : REVEAL_DISTANT_MS;
      rv.elapsedMs = 0;
      rv.state = 'REVEALING';
    }

    if (rv.state === 'REVEALING') {
      rv.elapsedMs += dt * 1000;
      const t = Math.min(1, rv.elapsedMs / rv.durationMs);
      this._setReveal(easeOutCubic(t));
      if (t >= 1) {
        this._setReveal(1);
        rv.state = 'REVEALED';
        markSeedRevealed(this.seed);
        rv._resolveDone();
      }
    }
  }

  // Drive every mounted reveal uniform to `v`. Synchronous — the next render
  // shows the new value (used by the thumbnail path to force-solid before
  // capture).
  _setReveal(v) {
    if (!this.reveal) return;
    for (const u of this.reveal.uniforms) u.value = v;
  }

  // Force the reveal complete immediately (thumbnail-capture path). Resolves
  // the done promise so a waiting claim proceeds.
  forceRevealComplete() {
    const rv = this.reveal;
    if (!rv || rv.state === 'REVEALED') return;
    this._setReveal(1);
    rv.state = 'REVEALED';
    markSeedRevealed(this.seed);
    rv._resolveDone();
  }

  /**
   * Add/remove the placement debug overlay across this planet's landmark
   * instances. Public so `__GAME.refreshDebugPlacement()` can call across
   * all loaded planets after toggling the flag mid-session.
   */
  _refreshDebugHelpers() {
    if (!this.landmarkGroup) return;
    for (const child of this.landmarkGroup.children) {
      // Only attach to GLB instances, not procedural fallbacks (the
      // primitives are deliberate stand-ins, not the placement we care to
      // verify).
      const slotId = child.userData?.slotId;
      if (slotId == null || !child.userData?.bbox) continue;
      const slot = this.landmarks.find((s) => s.slotId === slotId);
      detachInstanceHelpers(child);
      if (isDebugOn()) attachInstanceHelpers(child, slot?.direction);
    }
  }

  /**
   * Tear down planet-scoped GPU resources that aren't already on the scene
   * tree. Geometries + cloned-per-mesh materials are disposed by the
   * SolarSystem.dispose traverse; this handles the MaterialSet *templates*
   * (not parented to scene) and bumps visualGen so any in-flight applyVisuals
   * load drops on resolve instead of mounting onto a despawned planet.
   */
  dispose() {
    this.visualGen++;
    if (this.matSet) {
      disposeMaterialSet(this.matSet);
      this.matSet = null;
    }
    // Drop reveal state. A half-faded reveal is discarded (not resumed); the
    // seed is only in revealedSeeds if the fade actually completed, so a
    // genuine re-approach re-reveals and a completed one snaps solid.
    this.reveal = null;
  }

  // ── Internals ─────────────────────────────────────────────────────

  _pickHeroSlot() {
    const spire = this.landmarks.find((s) => s.kind === 'spire');
    return spire || this.landmarks[0] || null;
  }

  async _loadAssetSafe(url, renderer, label, assetMeta) {
    try {
      return await loadInstance(url, this.matSet, renderer, assetMeta);
    } catch (err) {
      console.warn(`[Planet ${this.seed}] ${label} load failed (${url}):`, err.message);
      return null;
    }
  }

  _replaceGroup(key, newGroup) {
    const old = this[key];
    if (old) {
      this.group.remove(old);
      old.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          // Only dispose materials we cloned per-mesh; shared matSet templates
          // are owned by this.matSet and disposed in dispose().
          if (child.material.userData?.cloned) child.material.dispose();
        }
      });
    }
    this[key] = newGroup;
    this.group.add(newGroup);
  }

  _reTintVertexColors() {
    const colors = this.geometry.attributes.color.array;
    const pos = this.geometry.attributes.position;
    const tmp = new THREE.Vector3();
    const colWater = new THREE.Color(this.palette.water);
    const colLow   = new THREE.Color(this.palette.low);
    const colMid   = new THREE.Color(this.palette.mid);
    const colHigh  = new THREE.Color(this.palette.high);
    const colSnow  = new THREE.Color(this.palette.snow);
    const tmpColor = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      tmp.fromBufferAttribute(pos, i);
      const r = tmp.length();
      const above = (r - this.radius * 0.995) / (this.radius * 0.10 || 1);
      if (above < 0.001) tmpColor.copy(colWater);
      else if (above < 0.25) tmpColor.copy(colLow).lerp(colMid, ss(0, 0.25, above));
      else if (above < 0.65) tmpColor.copy(colMid).lerp(colHigh, ss(0.25, 0.65, above));
      else                   tmpColor.copy(colHigh).lerp(colSnow, ss(0.65, 1.0, above));
      colors[i * 3 + 0] = tmpColor.r;
      colors[i * 3 + 1] = tmpColor.g;
      colors[i * 3 + 2] = tmpColor.b;
    }
    this.geometry.attributes.color.needsUpdate = true;
  }
}

function ss(a, b, t) {
  const x = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
}

// Catalog records carry `scale_override` for hand-tuned outliers. Prefer
// it when present; otherwise fall back to `scale_range`; otherwise the
// caller's default.
function _scaleRangeOf(asset, fallback) {
  if (!asset) return fallback;
  return asset.scale_override ?? asset.scale_range ?? fallback;
}

// Build the meta object passed to AssetCache.loadInstance / applyMaterialSet.
function _assetMetaOf(asset) {
  if (!asset) return null;
  return { family: asset.family || null, assetId: asset.id || '' };
}
