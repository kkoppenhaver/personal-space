// Night-side lights (roadmap 1b): lit windows, glowing lamps, pools of lamp
// light on the ground, and a warm glint per light that still reads from
// orbit.
//
// One `PlanetNight` per planet with mounted models (Planet.applyVisuals
// builds it; Planet.dispose and a remount drop it). Three parts:
//
//   1. Material patch. Every model tagged by NightGlow.js (buildings, lamps,
//      crystals) gets an emission term added to its own Lambert material,
//      on top of the reveal dither (RevealMaterial.js), so an asset lights
//      up only where it has materialised. All patched materials share one
//      program ('planetRevealNight').
//        windows   the model's own panes, or a procedural grid on its walls
//        bulbs     the lamp's glass / bulbs
//        crystals  their own colour, faintly
//   2. Pools: soft additive discs of warm light on the ground under each
//      lamp (and a faint spill around buildings). One merged mesh, one
//      material; the discs follow the terrain facets. No real lights: a
//      PointLight per lamp would recompile and slow every lit material.
//   3. Glints: one additive point per lamp and per building, with a minimum
//      size on screen, so a lit settlement still reads as specks of warm
//      light from far away (and lamps glow on the `low` tier, which has no
//      bloom).
//
// Lights come on per fragment across the terminator: `night` is a
// smoothstep of the sun's elevation at that spot on the planet
// (look.night.dusk), staggered a little per window and per asset.
//
// Everything is planet-local (children of planet.group, or shader uniforms
// written each frame from planet.center), so floating-origin rebases need
// nothing extra. Nothing glows on the day side: every term is multiplied
// by `night`, which is exactly 0 there.

import * as THREE from 'three';
import { GAME_LOOK } from '../render/Looks.js';

const NIGHT = GAME_LOOK.night;

const _m = new THREE.Matrix4();
const _mi = new THREE.Matrix4();
const _rel = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _n3 = new THREE.Matrix3();
const _size2 = new THREE.Vector2();

const linearColor = (hex, k = 1) => new THREE.Color(hex).multiplyScalar(k);

/**
 * How much it is night at world position `pos` on a planet (0 day … 1
 * night), from the sun's elevation there. Eases over a wider band than the
 * lights themselves; used for the sky fill (Rig.setNight).
 */
export function nightAt(pos, center, sunPos) {
  _v.copy(pos).sub(center).normalize();
  _w.copy(sunPos).sub(center).normalize();
  return 1 - THREE.MathUtils.smoothstep(_v.dot(_w), -0.15, 0.2);
}

/**
 * The rig's night settings where the player is (Rig.setNight):
 *   fill  how far the sky fill has dimmed (nightAt)
 *   sun   how much of the sun to take away. A directional light has no
 *         horizon: once the star has set here, walls facing it would still
 *         be lit from below the ground. Only inside the atmosphere
 *         (scaled by `density`, fully from 0.67 up), so
 *         from space the day side keeps its sun.
 */
export function nightLighting(pos, center, sunPos, density = 1) {
  const fill = nightAt(pos, center, sunPos);
  const elev = _v.dot(_w);   // set by nightAt
  const set = 1 - THREE.MathUtils.smoothstep(elev, -0.2, -0.03);
  return { fill, sun: set * Math.min(1, Math.max(0, density * 1.5)) };
}

// ── 1. Material patch ────────────────────────────────────────────────

const VERT_HEAD = /* glsl */`
attribute vec2 nightMask;
uniform vec3 uNlCenter;
varying vec2 vNlMask;
varying vec3 vNlLocal;
varying vec3 vNlWorld;
flat varying float vNlSeed;
`;

const VERT_BODY = /* glsl */`
vNlMask = nightMask;
vNlLocal = transformed;
vec4 nlP = vec4( transformed, 1.0 );
vec4 nlO = vec4( 0.0, 0.0, 0.0, 1.0 );
#ifdef USE_INSTANCING
  nlP = instanceMatrix * nlP;
  nlO = instanceMatrix * nlO;
#endif
vNlWorld = ( modelMatrix * nlP ).xyz;
// Per-asset seed from where the asset stands on its planet (metre grid,
// so it survives floating-origin rebases).
vec3 nlOrigin = floor( ( modelMatrix * nlO ).xyz - uNlCenter + 0.5 );
vNlSeed = fract( sin( dot( nlOrigin, vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 );
`;

const FRAG_HEAD = /* glsl */`
uniform vec3 uNlCenter, uNlSun, uNlObjUp, uNlColor;
uniform float uNlOn, uNlMode, uNlLit;
uniform vec2 uNlRange, uNlCell, uNlDusk;
varying vec2 vNlMask;
varying vec3 vNlLocal;
varying vec3 vNlWorld;
flat varying float vNlSeed;
float nlHash( vec3 p ) { return fract( sin( dot( p, vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 ); }
vec3 nightEmission( vec3 albedo ) {
  if ( uNlOn < 0.5 ) return vec3( 0.0 );
  // Per-asset seed, flat: interpolation noise, amplified by the hash,
  // would speckle a window between on and off.
  float seed = vNlSeed;
  // Sun elevation (sine) at this spot on the planet.
  float sunH = dot( normalize( vNlWorld - uNlCenter ), uNlSun );
  if ( sunH > uNlDusk.x + 0.08 ) return vec3( 0.0 );     // broad daylight
  if ( uNlMode > 2.5 ) {                                   // crystal
    return albedo * uNlColor.r * vNlMask.y * smoothstep( uNlDusk.x, uNlDusk.y, sunH );
  }
  if ( uNlMode > 1.5 ) {                                   // lamp bulbs
    float on = smoothstep( uNlDusk.x, uNlDusk.y, sunH + ( seed - 0.5 ) * 0.06 );
    return uNlColor * vNlMask.y * on;
  }
  // Windows: on walls only (faces within ~15 degrees of vertical).
  vec3 nObj = cross( dFdx( vNlLocal ), dFdy( vNlLocal ) );
  nObj *= inversesqrt( max( dot( nObj, nObj ), 1e-12 ) );
  float wall = 1.0 - smoothstep( 0.22, 0.38, abs( dot( nObj, uNlObjUp ) ) );
  if ( wall <= 0.0 ) return vec3( 0.0 );
  float h = dot( vNlLocal, uNlObjUp );
  float hN = ( h - uNlRange.x ) / max( 1e-4, uNlRange.y - uNlRange.x );
  vec3 id;
  float shape;
  if ( uNlMode < 0.5 ) {
    // The model's own panes; one on/off roll per pane-sized cell.
    id = floor( vNlLocal / uNlCell.y + 0.5 );
    shape = vNlMask.x;
  } else {
    // Procedural: a grid of window rectangles on the wall, in the model's
    // own units, between the foundation and the eaves.
    vec3 t = cross( uNlObjUp, nObj );
    t *= inversesqrt( max( dot( t, t ), 1e-12 ) );
    float band0 = uNlRange.x + 0.14 * ( uNlRange.y - uNlRange.x );
    vec2 uv = vec2( dot( vNlLocal, t ), h - band0 ) / uNlCell;
    vec2 c = floor( uv );
    vec2 f = abs( fract( uv ) - 0.5 );
    vec2 aa = fwidth( uv ) * 0.75;
    shape = ( 1.0 - smoothstep( 0.17 - aa.x, 0.17 + aa.x, f.x ) )
          * ( 1.0 - smoothstep( 0.21 - aa.y, 0.21 + aa.y, f.y ) )
          * step( 0.14, hN ) * step( hN, 0.86 );
    // (Not keyed on the face normal: a screen-space normal is noisy per
    // pixel, and a window must be all on or all off.)
    id = vec3( c, 7.0 );
  }
  float r1 = nlHash( id + seed * 61.0 );
  float r2 = nlHash( id.zxy + seed * 23.0 + 5.0 );
  float lit = step( r1, uNlLit );
  // Windows come on one by one through dusk.
  float on = smoothstep( uNlDusk.x, uNlDusk.y, sunH + ( r2 - 0.5 ) * 0.12 );
  // A little warmth variation from window to window.
  vec3 col = uNlColor * mix( vec3( 1.0 ), vec3( 0.85, 0.78, 0.7 ), r2 );
  return col * shape * wall * lit * on;
}
`;

function patchNightMaterial(material, uniforms) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_HEAD}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_HEAD}`)
      .replace('#include <opaque_fragment>', `outgoingLight += nightEmission( diffuseColor.rgb );\n#include <opaque_fragment>`);
  };
  // One program for every night-lit asset material (reveal included).
  material.customProgramCacheKey = () => 'planetRevealNight';
  material.needsUpdate = true;
}

// ── 2/3. Pools and glints ────────────────────────────────────────────

const POOL_VERT = /* glsl */`
attribute vec3 aPool;      // x, y: offset / radius; z: intensity
varying vec3 vPool;
varying vec3 vUp;
void main() {
  vPool = aPool;
  vUp = normalize( position );   // planet-local: the group sits on the planet centre
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const POOL_FRAG = /* glsl */`
uniform vec3 uSun, uColor;
uniform vec2 uDusk;
uniform float uOn;
varying vec3 vPool;
varying vec3 vUp;
void main() {
  float d2 = dot( vPool.xy, vPool.xy );
  float fall = pow( max( 0.0, 1.0 - d2 ), 2.0 );
  float night = smoothstep( uDusk.x, uDusk.y, dot( vUp, uSun ) );
  gl_FragColor = vec4( uColor * vPool.z * fall * night * uOn, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const GLINT_VERT = /* glsl */`
attribute vec4 aGlint;     // x: world size (m), y: push toward camera (m), z: intensity, w: kind (0 lamp, 1 building)
uniform float uViewH;
uniform vec3 uSun;
uniform vec2 uDusk;
varying float vI;
void main() {
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  float dist = max( 0.5, -mv.z );
  mv.xyz += normalize( -mv.xyz ) * aGlint.y;
  gl_Position = projectionMatrix * mv;
  float proj = projectionMatrix[1][1] * uViewH * 0.5;
  // Buildings show their real windows up close; their glint is for distance.
  float far = aGlint.w > 0.5 ? smoothstep( 150.0, 320.0, dist ) : 1.0;
  float night = smoothstep( uDusk.x, uDusk.y, dot( normalize( position ), uSun ) );
  vI = aGlint.z * far * night;
  gl_PointSize = clamp( aGlint.x * proj / dist, 2.5, 48.0 );
  if ( vI <= 0.001 ) gl_PointSize = 0.0;
}
`;

const GLINT_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uOn;
varying float vI;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length( c ) * 2.0;
  if ( d > 1.0 ) discard;
  float core = exp( -d * d * 9.0 ) + 0.25 * exp( -d * d * 2.5 );
  gl_FragColor = vec4( uColor * vI * core * uOn, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Height of the terrain facet under planet-local direction `dir` (unit). */
function makeGroundProbe(planet) {
  const geom = planet.mesh?.geometry || planet.geometry;
  const pos = geom.attributes.position;
  const index = geom.index;
  const triCount = (index ? index.count : pos.count) / 3;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3());
  const hit = new THREE.Vector3();
  // Triangles near one anchor, gathered once per pool.
  return (anchorDir, angle) => {
    const minDot = Math.cos(angle);
    const near = [];
    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      a.fromBufferAttribute(pos, i0);
      if (a.dot(anchorDir) / a.length() < minDot) continue;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      near.push(i0, i1, i2);
    }
    return (dir) => {
      ray.direction.copy(dir);
      for (let k = 0; k < near.length; k += 3) {
        a.fromBufferAttribute(pos, near[k]);
        b.fromBufferAttribute(pos, near[k + 1]);
        c.fromBufferAttribute(pos, near[k + 2]);
        if (ray.intersectTriangle(a, b, c, false, hit)) return hit.length();
      }
      return null;
    };
  };
}

/** Night-light uniforms for one tagged material, from where it stands. */
function materialUniforms(info, rel, shared) {
  const look = NIGHT;
  // The planet's up at the asset, in the model's own space.
  _v.setFromMatrixPosition(rel);
  const radial = _v.lengthSq() > 0 ? _v.clone().normalize() : new THREE.Vector3(0, 1, 0);
  _n3.setFromMatrix4(rel).invert();
  const objUp = radial.applyMatrix3(_n3).normalize();
  const scale = new THREE.Vector3().setFromMatrixScale(rel).x || 1;
  // Height range of the model along that up.
  let lo = Infinity, hi = -Infinity;
  const { min, max } = info.box;
  for (let i = 0; i < 8; i++) {
    _w.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z);
    const h = _w.dot(objUp);
    lo = Math.min(lo, h); hi = Math.max(hi, h);
  }
  const heightWorld = (hi - lo) * scale;
  // Storey height in metres, a quarter of the building, kept sensible.
  // Two to five storeys of windows between the foundation and the eaves
  // (14% to 86% of the height): toy-like proportions at any model size.
  const floors = THREE.MathUtils.clamp(Math.round(heightWorld / 3.5), 2, 5);
  const storey = ((hi - lo) * 0.72) / floors;   // model units
  let mode, color;
  if (info.role === 'lamp') {
    // A light-tree whose whole canopy is "bulb" glows softly, not like a lamp.
    const k = info.bulbShare > 0.3 ? 0.3 : 1;
    mode = 2; color = linearColor(look.lamps.color, look.lamps.intensity * k);
  }
  else if (info.role === 'crystal') { mode = 3; color = new THREE.Color(look.crystals.intensity, 0, 0); }
  else { mode = info.mode === 'panes' ? 0 : 1; color = linearColor(look.windows.color, look.windows.intensity); }
  return {
    ...shared,
    uNlMode: { value: mode },
    uNlColor: { value: color },
    uNlLit: { value: look.windows.lit },
    uNlObjUp: { value: objUp },
    uNlRange: { value: new THREE.Vector2(lo, hi) },
    uNlCell: { value: new THREE.Vector2(storey * 0.85, storey) },
    // for pools/glints
    _heightWorld: heightWorld,
    _footWorld: Math.max(max.x - min.x, max.z - min.z) * scale,
  };
}

export class PlanetNight {
  constructor(planet) {
    this.planet = planet;
    this.shared = {
      uNlCenter: { value: new THREE.Vector3() },
      uNlSun: { value: new THREE.Vector3(0, 1, 0) },
      uNlOn: { value: 0 },
      uNlDusk: { value: new THREE.Vector2(NIGHT.dusk[0], NIGHT.dusk[1]) },
    };
    this.group = new THREE.Group();
    this.group.name = 'nightLights';
    this.lit = 0;
    this._patched = [];

    const pools = [];    // { at: Vector3 (planet-local ground anchor), radius, intensity }
    const glints = [];   // { at, size, push, intensity, kind }
    planet.group.updateMatrixWorld(true);
    _mi.copy(planet.group.matrixWorld).invert();

    const visit = (o) => {
      if (!o.isMesh || Array.isArray(o.material)) return;
      const info = o.material?.userData?.night;
      if (!info || info.mode === 'none') return;
      const count = o.isInstancedMesh ? o.count : 1;
      if (!count) return;
      let uniforms = null;
      for (let i = 0; i < count; i++) {
        _rel.multiplyMatrices(_mi, o.matrixWorld);
        if (o.isInstancedMesh) { o.getMatrixAt(i, _m); _rel.multiply(_m); }
        if (!uniforms) uniforms = materialUniforms(info, _rel, this.shared);
        if (info.role === 'lamp') {
          // The pool sits straight under the bulb, sized by its height.
          const bulb = info.bulb.clone().applyMatrix4(_rel);
          const d = bulb.clone().normalize();
          const ground = planet.sample ? planet.sample(d.x, d.y, d.z) : planet.radius;
          const rise = Math.max(0.5, bulb.length() - ground);
          pools.push({ at: bulb, radius: THREE.MathUtils.clamp(rise * NIGHT.pools.lampReach, 2.5, 10), intensity: NIGHT.pools.lamp });
          glints.push({ at: bulb, size: NIGHT.glints.lampSize, push: 0.4, intensity: NIGHT.glints.lamp, kind: 0 });
        } else if (info.role === 'building') {
          // Faint spill around the footprint; a glint at mid-height, pushed
          // out of the walls toward the camera.
          const centre = info.box.getCenter(new THREE.Vector3()).applyMatrix4(_rel);
          pools.push({ at: centre, radius: THREE.MathUtils.clamp(uniforms._footWorld * 0.8 + 2, 3, 14), intensity: NIGHT.pools.building });
          glints.push({
            at: centre, size: NIGHT.glints.buildingSize, push: uniforms._footWorld * 0.6 + 0.5,
            intensity: NIGHT.glints.building, kind: 1,
          });
        }
      }
      delete uniforms._heightWorld;
      delete uniforms._footWorld;
      patchNightMaterial(o.material, uniforms);
      this._patched.push(o.material);
    };
    planet.landmarkGroup?.traverse(visit);
    planet.featuresGroup?.traverse(visit);

    // Kept so the pools can be laid again when the terrain mesh changes
    // (TerrainDetail swaps a planet between its coarse and fine mesh).
    this._pools = pools;
    this._poolMesh = null;
    this._groundDirty = false;
    if (pools.length) { this._poolMesh = this._buildPools(pools); this.group.add(this._poolMesh); }
    if (glints.length) this.group.add(this._buildGlints(glints));
    planet.group.add(this.group);
  }

  /**
   * The terrain mesh under the pools changed (coarse ↔ fine): lay them
   * again on the next update. Pools follow the drawn facets, so on the old
   * mesh they would hover over hollows the fine mesh opens up.
   */
  refreshGround() {
    if (this._pools.length) this._groundDirty = true;
  }

  get empty() { return this._patched.length === 0; }

  _buildPools(pools) {
    // Overlapping pools add up: a lamp-lined path would burn into one
    // orange strip. Each pool is dimmed by how much it overlaps others.
    for (const p of pools) {
      let overlap = 0;
      for (const q of pools) {
        if (q === p) continue;
        overlap += Math.max(0, 1 - p.at.distanceTo(q.at) / (p.radius + q.radius));
      }
      p.dim = 1 / (1 + overlap);
    }
    const RINGS = 6, SEG = 18;
    // On a coarse mesh the drawn facets can sit metres off the exact
    // surface, so each pool vertex is dropped onto the facet under it. On
    // the fine mesh (TerrainDetail) the facets follow the surface closely
    // and there are many more of them: probing them cost 83 ms for 76 lamps
    // at k=2, so there the exact surface alone is used, lifted a little more.
    const fine = !!this.planet.fine;
    const probe = fine ? null : makeGroundProbe(this.planet);
    const lift = fine ? 0.25 : 0.12;
    const sample = this.planet.sample;
    const verts = [], attrs = [], idx = [];
    const t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), d = new THREE.Vector3();
    for (const p of pools) {
      const up = p.at.clone().normalize();
      t1.set(Math.abs(up.y) < 0.9 ? 0 : 1, Math.abs(up.y) < 0.9 ? 1 : 0, 0).cross(up).normalize();
      t2.crossVectors(up, t1);
      const R = p.at.length();
      const ground = probe ? probe(up, (p.radius + 6) / R) : null;
      const base = verts.length / 3;
      for (let r = 0; r <= RINGS; r++) {
        const rr = r / RINGS;
        const segs = r === 0 ? 1 : SEG;
        for (let s = 0; s < segs; s++) {
          const a = (s / SEG) * Math.PI * 2;
          const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
          d.copy(p.at).addScaledVector(t1, x * p.radius).addScaledVector(t2, y * p.radius).normalize();
          // The higher of the facet and the exact surface, lifted a touch:
          // follows the faceted mesh today and a finer one later.
          const h = Math.max(ground ? (ground(d) ?? 0) : 0, sample ? sample(d.x, d.y, d.z) : R) + lift;
          verts.push(d.x * h, d.y * h, d.z * h);
          attrs.push(x, y, p.intensity * p.dim);
        }
      }
      // centre fan, then ring quads
      for (let s = 0; s < SEG; s++) idx.push(base, base + 1 + s, base + 1 + ((s + 1) % SEG));
      for (let r = 1; r < RINGS; r++) {
        const a0 = base + 1 + (r - 1) * SEG, b0 = base + 1 + r * SEG;
        for (let s = 0; s < SEG; s++) {
          const s1 = (s + 1) % SEG;
          idx.push(a0 + s, b0 + s, b0 + s1, a0 + s, b0 + s1, a0 + s1);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('aPool', new THREE.Float32BufferAttribute(attrs, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    this.poolUniforms = {
      uSun: this.shared.uNlSun,
      uDusk: this.shared.uNlDusk,
      uOn: { value: 0 },
      uColor: { value: linearColor(NIGHT.pools.color) },
    };
    const m = new THREE.ShaderMaterial({
      uniforms: this.poolUniforms,
      vertexShader: POOL_VERT,
      fragmentShader: POOL_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.name = 'nightPools';
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    return mesh;
  }

  _buildGlints(glints) {
    const pos = new Float32Array(glints.length * 3);
    const at = new Float32Array(glints.length * 4);
    glints.forEach((g, i) => {
      pos.set([g.at.x, g.at.y, g.at.z], i * 3);
      at.set([g.size, g.push, g.intensity, g.kind], i * 4);
    });
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('aGlint', new THREE.BufferAttribute(at, 4));
    this.glintUniforms = {
      uSun: this.shared.uNlSun,
      uDusk: this.shared.uNlDusk,
      uOn: { value: 0 },
      uViewH: { value: 720 },
      uColor: { value: linearColor(NIGHT.glints.color) },
    };
    const m = new THREE.ShaderMaterial({
      uniforms: this.glintUniforms,
      vertexShader: GLINT_VERT,
      fragmentShader: GLINT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(geom, m);
    pts.name = 'nightGlints';
    pts.frustumCulled = false;
    pts.renderOrder = 2;
    const u = this.glintUniforms.uViewH;
    pts.onBeforeRender = (renderer) => {
      const rt = renderer.getRenderTarget();
      u.value = rt ? rt.height : renderer.getDrawingBufferSize(_size2).y;
    };
    return pts;
  }

  /**
   * Per frame. `sunPos` is the planet's own star (world space); without
   * one the lights stay off.
   */
  update(sunPos) {
    const p = this.planet;
    const s = this.shared;
    if (!sunPos) { s.uNlOn.value = 0; this.group.visible = false; return; }
    s.uNlCenter.value.copy(p.center);
    s.uNlSun.value.copy(sunPos).sub(p.center).normalize();
    s.uNlOn.value = 1;
    if (this._groundDirty) {
      this._groundDirty = false;
      const on = this.poolUniforms?.uOn.value ?? 0;
      if (this._poolMesh) {
        this.group.remove(this._poolMesh);
        this._poolMesh.geometry.dispose();
        this._poolMesh.material.dispose();
      }
      this._poolMesh = this._buildPools(this._pools);
      this.poolUniforms.uOn.value = on;
      this.group.add(this._poolMesh);
    }
    // Pools and glints appear with the models (the models' own lights are
    // already gated by their reveal dither).
    const rv = p.reveal;
    const reveal = !rv ? 0 : rv.state === 'REVEALED' ? 1 : (rv.uniforms[0]?.value ?? 0);
    if (this.poolUniforms) this.poolUniforms.uOn.value = reveal;
    if (this.glintUniforms) this.glintUniforms.uOn.value = reveal;
    this.group.visible = reveal > 0;
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose();
    });
  }
}

/** Build the night lights for a planet's freshly mounted models (or null). */
export function mountNightLights(planet) {
  const night = new PlanetNight(planet);
  if (night.empty) { night.dispose(); return null; }
  return night;
}
