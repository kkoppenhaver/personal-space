// The ground's material (roadmap 1d).
//
// Still the flat-shaded MeshLambertMaterial the look was tuned on (sunlit
// low-poly: plain cosine shading, crisp facets), patched with
// onBeforeCompile so it keeps everything three gives a lit material: the
// sun's shadow, the contact-shading prepass, fog, tone mapping on the low
// tier. What the patch adds, all computed per pixel from PLANET-LOCAL
// position (the mesh's own coordinates, so nothing swims on a
// floating-origin rebase):
//
//   1. Palette bands. Each vertex carries its colour height (aColorAbove);
//      the vertex shader turns it into the band colour, as the old CPU
//      colouring did, so a palette change is a uniform update. Below the
//      waterline it is the water colour, cut at the waterline per pixel
//      (it used to bleed up every coastal face as a dark rim).
//   2. The ground pattern (rings, rows, patchwork, spots, veins, stripes),
//      a port of TerrainShapes.makePattern with the same seeded layout,
//      evaluated per pixel with anti-aliased edges. Patterns cut cleanly
//      across facets instead of being painted one colour per triangle.
//   3. Rock on steep faces (from the flat face normal, so it follows the
//      facets), a pale foam band at the waterline, and a fine grain.
//      Restrained, and none of it brightens (Looks.js `ground`).
//
// The shader reads only uniforms and two float attributes; the same program
// serves every planet with the same pattern (customProgramCacheKey +
// defines), and the coarse and fine meshes share one material.

import * as THREE from 'three';
import { noise3Tables } from './Seed.js';
import { patternParams } from './TerrainShapes.js';
import { SEA_R } from './Water.js';

export const PATTERN_CODES = { none: 0, patchwork: 1, rows: 2, rings: 3, spots: 4, veins: 5, stripes: 6 };

const DEFAULT_GROUND = {
  rock: { from: 0.2, to: 0.45, amount: 0.45 },
  foam: { width: 0.35, amount: 0.5 },
  grain: { amount: 0.06, size: 1.4 },
};

/**
 * The colours the ground paints with, from a planet palette (linear, as
 * THREE.Color holds them). The band and pattern colours are the ones the
 * CPU colouring used before 1d; rock and foam are new.
 */
export function groundColors(palette) {
  const water = new THREE.Color(palette.water);
  const low = new THREE.Color(palette.low);
  const mid = new THREE.Color(palette.mid);
  const high = new THREE.Color(palette.high);
  const snow = new THREE.Color(palette.snow);
  const sky = new THREE.Color(palette.sky || palette.snow);
  // Pattern colours: 0 = a sibling of the lowland colour (fields, furrows —
  // variation you'd expect of the same ground), 1 = an accent pulled from
  // the palette's light end (rings, spots, veins — a mark someone made),
  // 2 = a darker sibling.
  const pat0 = low.clone().lerp(mid, 0.3).offsetHSL(0.06, 0.12, 0.12);
  const pat2 = low.clone().offsetHSL(-0.04, 0.02, -0.11);
  const pat1 = sky.clone();
  const hsl = {};
  pat1.getHSL(hsl);
  pat1.setHSL(hsl.h, Math.max(0.5, hsl.s), 0.62);
  // Rock: the highland colour, greyed and a little darker.
  const rock = high.clone().lerp(mid, 0.3);
  rock.getHSL(hsl);
  rock.setHSL(hsl.h, hsl.s * 0.45, hsl.l * 0.8);
  // Foam: the water's pale accent toward the palette's white.
  const foam = water.clone().lerp(sky, 0.45).lerp(snow, 0.65);
  return { water, low, mid, high, snow, pat: [pat0, pat1, pat2], rock, foam };
}

function noiseTexture(seed) {
  const { grad, perm } = noise3Tables(seed);
  const data = new Float32Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    data[i * 4] = grad[i * 3];
    data[i * 4 + 1] = grad[i * 3 + 1];
    data[i * 4 + 2] = grad[i * 3 + 2];
    data[i * 4 + 3] = perm[i];
  }
  const tex = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * @param {object} o
 * @param {number} o.seed        planet seed (pattern layout, grain offset)
 * @param {string} o.pattern     a GROUND_PATTERNS name
 * @param {THREE.Vector3|null} o.focus  the shape's focal direction (rings centre on it)
 * @param {object} o.palette
 * @param {number} o.radius
 * @param {object} [o.ground]    the look's `ground` settings
 */
export function createGroundMaterial({ seed, pattern, focus = null, palette, radius, ground = DEFAULT_GROUND }) {
  const code = PATTERN_CODES[pattern] ?? 0;
  const params = patternParams(seed, pattern, focus);
  const cellCount = Math.max(1, params.cells.length);
  const g = { ...DEFAULT_GROUND, ...ground };

  const mat = new THREE.MeshLambertMaterial({ flatShading: true });
  const u = {
    uBandWater: { value: new THREE.Color() },
    uBandLow: { value: new THREE.Color() },
    uBandMid: { value: new THREE.Color() },
    uBandHigh: { value: new THREE.Color() },
    uBandSnow: { value: new THREE.Color() },
    uPatCol: { value: [new THREE.Color(), new THREE.Color(), new THREE.Color()] },
    uRockCol: { value: new THREE.Color() },
    uFoamCol: { value: new THREE.Color() },
    uPatAxis: { value: params.axis.clone() },
    uPatCenter: { value: params.center.clone() },
    uPatCells: { value: Array.from({ length: cellCount }, (_, i) => {
      const c = params.cells[i];
      return c ? new THREE.Vector4(c.c.x, c.c.y, c.c.z, c.k) : new THREE.Vector4();
    }) },
    uPatNoise: { value: (code === PATTERN_CODES.spots || code === PATTERN_CODES.stripes) ? noiseTexture(params.noiseSeed) : null },
    // The waterline: the sea sphere's radius (Water.js SEA_R), less the most
    // its faces sag below a true sphere between vertices. Ground between
    // the two shows at the shore; it must read as land (and foam), not as
    // a dark rim of the sea-floor colour.
    uSeaR: { value: radius * (SEA_R - 0.0008) },
    uRock: { value: new THREE.Vector3(g.rock.from, g.rock.to, g.rock.amount) },
    uFoam: { value: new THREE.Vector2(g.foam.width, 0) },   // amount set by setSea
    uGrain: { value: new THREE.Vector2(g.grain.amount, g.grain.size) },
    uGrainOffset: { value: new THREE.Vector3(((seed * 0.6180339) % 1) * 97, ((seed * 0.4142135) % 1) * 89, ((seed * 0.7320508) % 1) * 83) },
  };
  const foamAmount = g.foam.amount;

  mat.defines = { GROUND_PATTERN: code, PAT_CELLS: cellCount };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aAbove;
        attribute float aColorAbove;
        uniform vec3 uBandWater, uBandLow, uBandMid, uBandHigh, uBandSnow;
        varying vec3 vGroundLocal;
        varying vec3 vGroundUp;
        varying float vGroundAbove;
        varying vec3 vGroundBand;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vGroundLocal = position;
        vGroundUp = normalMatrix * normalize(position);
        vGroundAbove = aAbove;
        {
          // Sea-floor vertices band as the lowest land: the faces that
          // climb out of the sea are land above the waterline, and the
          // fragment shader paints the water colour below it.
          float ca = max(aColorAbove, 0.0);
          if (ca < 0.25) vGroundBand = mix(uBandLow, uBandMid, smoothstep(0.0, 0.25, ca));
          else if (ca < 0.65) vGroundBand = mix(uBandMid, uBandHigh, smoothstep(0.25, 0.65, ca));
          else vGroundBand = mix(uBandHigh, uBandSnow, smoothstep(0.65, 1.0, ca));
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GROUND_FRAGMENT_PARS}`)
      .replace('#include <lights_lambert_fragment>', `${GROUND_FRAGMENT_MAIN}\n#include <lights_lambert_fragment>`);
  };
  mat.customProgramCacheKey = () => 'ground-1d';

  mat.userData.ground = {
    uniforms: u,
    setPalette(palette) {
      const c = groundColors(palette);
      u.uBandWater.value.copy(c.water);
      u.uBandLow.value.copy(c.low);
      u.uBandMid.value.copy(c.mid);
      u.uBandHigh.value.copy(c.high);
      u.uBandSnow.value.copy(c.snow);
      for (let i = 0; i < 3; i++) u.uPatCol.value[i].copy(c.pat[i]);
      u.uRockCol.value.copy(c.rock);
      u.uFoamCol.value.copy(c.foam);
    },
    /** Foam only where there is a sea to meet. */
    setSea(on) { u.uFoam.value.y = on ? foamAmount : 0; },
  };
  mat.userData.ground.setPalette(palette);
  return mat;
}

export function disposeGroundMaterial(mat) {
  if (!mat) return;
  mat.userData.ground?.uniforms.uPatNoise.value?.dispose();
  mat.dispose();
}

const GROUND_FRAGMENT_PARS = /* glsl */`
  uniform vec3 uPatCol[3];
  uniform vec3 uRockCol, uFoamCol, uBandWater;
  uniform vec3 uPatAxis, uPatCenter;
  uniform vec4 uPatCells[PAT_CELLS];
  uniform sampler2D uPatNoise;
  uniform float uSeaR;
  uniform vec3 uRock;       // from, to, amount
  uniform vec2 uFoam;       // width (m), amount
  uniform vec2 uGrain;      // amount, size (m)
  uniform vec3 uGrainOffset;
  varying vec3 vGroundLocal;
  varying vec3 vGroundUp;
  varying float vGroundAbove;
  varying vec3 vGroundBand;

  // Hash without sine (Dave Hoskins): stable at large coordinates.
  float groundHash(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  float groundValueNoise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(groundHash(i), groundHash(i + vec3(1, 0, 0)), f.x),
          mix(groundHash(i + vec3(0, 1, 0)), groundHash(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(groundHash(i + vec3(0, 0, 1)), groundHash(i + vec3(1, 0, 1)), f.x),
          mix(groundHash(i + vec3(0, 1, 1)), groundHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }

  #if GROUND_PATTERN == 4 || GROUND_PATTERN == 6
  // Seed.js makeNoise3, per pixel: gradients in rgb, permutation in a.
  float patPerm(float i) { return texelFetch(uPatNoise, ivec2(int(i), 0), 0).a; }
  float patGradDot(float ix, float iy, float iz, vec3 f) {
    float idx = patPerm(mod(ix + patPerm(mod(iy + patPerm(iz), 256.0)), 256.0));
    return dot(texelFetch(uPatNoise, ivec2(int(idx), 0), 0).rgb, f);
  }
  float patNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = p - i;
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    vec3 a = mod(i, 256.0), b = mod(i + 1.0, 256.0);
    float n000 = patGradDot(a.x, a.y, a.z, f);
    float n100 = patGradDot(b.x, a.y, a.z, f - vec3(1, 0, 0));
    float n010 = patGradDot(a.x, b.y, a.z, f - vec3(0, 1, 0));
    float n110 = patGradDot(b.x, b.y, a.z, f - vec3(1, 1, 0));
    float n001 = patGradDot(a.x, a.y, b.z, f - vec3(0, 0, 1));
    float n101 = patGradDot(b.x, a.y, b.z, f - vec3(1, 0, 1));
    float n011 = patGradDot(a.x, b.y, b.z, f - vec3(0, 1, 1));
    float n111 = patGradDot(b.x, b.y, b.z, f - vec3(1, 1, 1));
    return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
               mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
  }
  float patFbm(vec3 p, int octaves) {
    float amp = 1.0, freq = 1.0, sum = 0.0, norm = 0.0;
    for (int i = 0; i < 3; i++) {
      if (i >= octaves) break;
      sum += amp * patNoise(p * freq);
      norm += amp;
      amp *= 0.5;
      freq *= 2.0;
    }
    return sum / norm;
  }
  #endif

  #if GROUND_PATTERN == 1
  vec4 patchColor(float k) {
    if (k < 0.3) return vec4(0.0);
    vec3 c = k < 0.62 ? uPatCol[0] : (k < 0.94 ? uPatCol[2] : uPatCol[1]);
    return vec4(c * 0.85, 0.85);
  }
  #endif

  // The pattern at direction d: premultiplied colour + weight.
  vec4 groundPattern(vec3 d, float above) {
    vec4 r = vec4(0.0);
    float aw = fwidth(above);
  #if GROUND_PATTERN == 1
    // patchwork: Voronoi fields, the cell's draw decides its colour.
    float d1 = -2.0, d2 = -2.0, k1 = 0.0, k2 = 0.0;
    for (int i = 0; i < PAT_CELLS; i++) {
      vec4 c = uPatCells[i];
      float v = dot(d, c.xyz);
      if (v > d1) { d2 = d1; k2 = k1; d1 = v; k1 = c.w; }
      else if (v > d2) { d2 = v; k2 = c.w; }
    }
    float t = 0.5 + 0.5 * clamp((d1 - d2) / max(fwidth(d1) * 1.5, 1e-7), 0.0, 1.0);
    r = mix(patchColor(k2), patchColor(k1), t);
    r *= 1.0 - smoothstep(0.75 - aw, 0.75 + aw, above);
  #elif GROUND_PATTERN == 2
    // rows: soft furrows on one heading.
    float lat = asin(clamp(dot(d, uPatAxis), -1.0, 1.0));
    float f = fract(lat * 9.0);
    float m = 0.75 * smoothstep(0.2, 0.5, abs(f - 0.5) * 2.0);
    r = vec4(uPatCol[2] * m, m);
    r *= 1.0 - smoothstep(0.7 - aw, 0.7 + aw, above);
  #elif GROUND_PATTERN == 3
    // rings: bands [0, 0.4) of every 1/7 radian around the centre.
    float x = acos(min(1.0, dot(d, uPatCenter))) * 7.0;
    float dist = abs(fract(x - 0.2 + 0.5) - 0.5);
    float w = fwidth(x);
    float on = 1.0 - smoothstep(0.2 - w, 0.2 + w, dist);
    on = mix(on, 0.4, smoothstep(0.2, 0.6, w));
    r = vec4(uPatCol[1], 1.0) * (0.8 * on);
  #elif GROUND_PATTERN == 4
    // spots: noise above a threshold.
    float v = patFbm(d * 8.0, 2);
    float w = fwidth(v);
    float on = smoothstep(0.24 - w, 0.24 + w, v);
    r = vec4(uPatCol[1], 1.0) * (0.85 * on);
  #elif GROUND_PATTERN == 5
    // veins: thin lines where two Voronoi cells meet.
    float d1 = -2.0, d2 = -2.0;
    for (int i = 0; i < PAT_CELLS; i++) {
      float v = dot(d, uPatCells[i].xyz);
      if (v > d1) { d2 = d1; d1 = v; } else if (v > d2) d2 = v;
    }
    float gap = d1 - d2;
    float w = fwidth(gap);
    float on = 1.0 - smoothstep(0.025 - w, 0.025 + w, gap);
    r = vec4(uPatCol[1], 1.0) * on;
  #elif GROUND_PATTERN == 6
    // stripes: wobbling latitude bands in two field colours.
    float s = asin(clamp(dot(d, uPatAxis), -1.0, 1.0)) * 4.5 + patFbm(d * 2.0, 3) * 1.2;
    float f = fract(s);
    float m = 0.7 * smoothstep(0.15, 0.45, abs(f - 0.5) * 2.0);
    float w = fwidth(s);
    float t = smoothstep(-w, w, f > 0.5 ? f - 1.0 : f);
    r = vec4(mix(uPatCol[2], uPatCol[0], t) * m, m);
  #endif
    return r;
  }
`;

const GROUND_FRAGMENT_MAIN = /* glsl */`
  {
    vec3 gLocal = vGroundLocal;
    float gR = length(gLocal);
    vec3 gDir = gLocal / gR;
    float rw = max(fwidth(gR), 1e-5);
    // Above the waterline (the sea shell hides everything below it).
    float land = smoothstep(uSeaR, uSeaR + rw, gR);
    vec3 col = mix(uBandWater, vGroundBand, land);

  #if GROUND_PATTERN > 0
    vec4 pat = groundPattern(gDir, vGroundAbove) * land;
    col = col * (1.0 - pat.a) + pat.rgb;
  #endif

    // Grain: two sizes of value noise, faded toward its mean where a pixel
    // covers more than a grain (no shimmer from orbit).
    vec3 gp = gLocal / uGrain.y + uGrainOffset;
    float grainA = groundValueNoise(gp);
    float grainB = groundValueNoise(gp * 2.7 + 17.0);
    float grain = grainA * 0.6 + grainB * 0.4;
    float foot = length(fwidth(gLocal)) / (uGrain.y * 0.37);
    grain = mix(0.5, grain, 1.0 - smoothstep(0.35, 1.0, foot));

    // Rock on steep faces: the flat face normal against the planet's up.
    float slope = 1.0 - dot(normal, normalize(vGroundUp));
    col = mix(col, uRockCol, smoothstep(uRock.x, uRock.y, slope) * uRock.z * land);

    // Foam: a pale band just above the waterline, its width wavering with
    // the coarse grain; faded where the band is thinner than a pixel.
    if (uFoam.y > 0.0) {
      float fw = uFoam.x * (0.6 + 0.8 * grainA);
      float foam = (1.0 - smoothstep(0.0, fw, gR - uSeaR)) * land;
      foam *= clamp(fw / (rw * 1.5), 0.0, 1.0);
      col = mix(col, uFoamCol, foam * uFoam.y);
    }

    diffuseColor.rgb *= col * (1.0 - uGrain.x * grain);
  }
`;
