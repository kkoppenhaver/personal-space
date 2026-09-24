import * as THREE from 'three';
import { makeNoise3, fbm } from './Seed.js';
import { makeShaper, makePattern, patternIsSoft } from './TerrainShapes.js';

// Generate a planet mesh: subdivided icosa, multi-octave noise displacement,
// vertex colors banded by elevation. Returns { geometry, bands, elevations, palette }.
//
// elevations: per-vertex normalized elevation in [0..1] (used for landmark slot picking).

const DEFAULT_PALETTE = {
  water:  '#21507e',
  low:    '#5b8a3a',
  mid:    '#a98a4b',
  high:   '#7a5a3c',
  snow:   '#f5f1e6',
  sky:    '#9ac4e8',
};

export function buildPlanetGeometry({ seed, radius, palette = DEFAULT_PALETTE, subdivisions = 16, seaLevelQuantile = 0.42, ampScale = 1.0, shape = 'rolling', pattern = 'none' }) {
  const noise = makeNoise3(seed);
  const noise2 = makeNoise3(seed ^ 0x9e3779b9);
  const shaper = makeShaper(seed, shape);
  seaLevelQuantile = Math.max(seaLevelQuantile, shaper.minSea);

  // three's IcosahedronGeometry(detail) is non-indexed with 20·(detail+1)²
  // faces — detail 5 was only 720 triangles (~13m facets on a 100m world,
  // which is what made ground-snapped assets float/stab). 16 → 5780 tris,
  // ~5ms to build, facets ~4m: still low-poly, no longer spiky.
  const geom = new THREE.IcosahedronGeometry(radius, subdivisions);
  const pos = geom.attributes.position;
  const vCount = pos.count;

  const elevations = new Float32Array(vCount);

  // Elevation amplitude (in world units) — keep small relative to radius.
  // ampScale comes from the concept; the shape multiplies it (a lone
  // mountain needs more relief than rolling hills).
  const amp = radius * 0.10 * ampScale * shaper.ampMul;

  const tmp = new THREE.Vector3();
  const rawAt = (d) => {
    // continents
    const c = fbm(noise, d.x * 1.2, d.y * 1.2, d.z * 1.2, 5, 2.0, 0.5);
    // ridges (abs noise)
    const r = 1.0 - Math.abs(fbm(noise2, d.x * 3.0, d.y * 3.0, d.z * 3.0, 4, 2.0, 0.55));
    // Math.fround: match the stored f32 value so min/max tracking agrees
    // with what's compared later (a handful of vertices used to round
    // just below the f64 minimum and read as underwater on a waterless
    // world).
    return Math.fround(shaper.raw(d, c * 0.7 + (r - 0.5) * 0.6));
  };

  let minE = Infinity, maxE = -Infinity;
  const raw = new Float32Array(vCount);
  for (let i = 0; i < vCount; i++) {
    tmp.fromBufferAttribute(pos, i).normalize();
    const e = raw[i] = rawAt(tmp);
    if (e < minE) minE = e;
    if (e > maxE) maxE = e;
  }

  const range = maxE - minE || 1;
  // Sea level as a TRUE quantile of the surface: sea_level 0.3 means 30%
  // of the planet is underwater, whatever the shape. (It used to be a
  // fraction of the elevation RANGE — harmless on noise balls, but one
  // colossal mountain stretches the range and drowned everything else.)
  // Vertices are ~uniform over the sphere, so a vertex percentile is an
  // area percentile.
  let seaLevel = minE;
  if (seaLevelQuantile > 0) {
    const sorted = Float32Array.from(raw).sort();
    seaLevel = sorted[Math.min(vCount - 1, Math.floor(seaLevelQuantile * vCount))];
  }
  // Downstream bands (landmarks, features) compare against the
  // range-normalized `elevations`, so hand them sea level in that space.
  const seaNorm = (seaLevel - minE) / range;

  // Exact height function — used for the mesh AND the altitude sampler,
  // so ALT on the HUD agrees with the ground you're about to hit (the old
  // sampler re-derived an approximate range and drifted).
  const aboveOf = (e) => (e < seaLevel ? -1 : shaper.above((e - seaLevel) / (maxE - seaLevel || 1)));
  const heightOfAbove = (a) => (a < 0 ? radius * 0.995 : radius + amp * Math.pow(Math.max(0, a), 1.05));
  const sample = (x, y, z) => heightOfAbove(aboveOf(rawAt(tmp.set(x, y, z))));

  const above = new Float32Array(vCount);
  for (let i = 0; i < vCount; i++) {
    tmp.fromBufferAttribute(pos, i).normalize();
    const e = raw[i];
    elevations[i] = (e - minE) / range; // 0..1
    const a = above[i] = aboveOf(e);
    const h = heightOfAbove(a);
    pos.setXYZ(i, tmp.x * h, tmp.y * h, tmp.z * h);
  }

  // Per-face pattern weights (crisp tiles: one value per triangle,
  // evaluated at the centroid).
  const patternFn = makePattern(seed, pattern, shaper.focus);
  const patMix = new Float32Array(vCount);
  const patWhich = new Uint8Array(vCount);
  const cen = new THREE.Vector3();
  if (patternIsSoft(pattern)) {
    for (let i = 0; i < vCount; i++) {
      const r = patternFn(tmp.fromBufferAttribute(pos, i).normalize(), above[i]);
      patMix[i] = r.mix; patWhich[i] = r.which;
    }
  } else {
    for (let f = 0; f < vCount; f += 3) {
      cen.set(0, 0, 0);
      for (let k = 0; k < 3; k++) cen.add(tmp.fromBufferAttribute(pos, f + k));
      cen.normalize();
      const faceAbove = Math.min(above[f], above[f + 1], above[f + 2]);
      const r = patternFn(cen, faceAbove);
      for (let k = 0; k < 3; k++) { patMix[f + k] = r.mix; patWhich[f + k] = r.which; }
    }
  }

  // Color height: half absolute, half RANK among land vertices. Shapes
  // that push most land to one level (a rift world is one high plateau
  // with a canyon) would otherwise paint nearly everything snow; the
  // rank term guarantees every world spans its lowland→peak colors.
  const landIdx = [];
  for (let i = 0; i < vCount; i++) if (above[i] >= 0) landIdx.push(i);
  landIdx.sort((a, b) => above[a] - above[b]);
  const colorAbove = new Float32Array(vCount).fill(-1);
  const nLand = Math.max(1, landIdx.length - 1);
  for (let k = 0; k < landIdx.length; k++) {
    const i = landIdx[k];
    colorAbove[i] = 0.5 * above[i] + 0.5 * (k / nLand);
  }

  geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(vCount * 3), 3));
  const surface = { above: colorAbove, patMix, patWhich };
  colorizeTerrain(geom, surface, palette);
  geom.computeVertexNormals();
  pos.needsUpdate = true;

  return {
    geometry: geom, elevations, palette, seaLevel: seaNorm,
    sample, surface, focus: shaper.focus, shape, pattern,
  };
}

/**
 * (Re)paint vertex colors from the palette: elevation bands + the ground
 * pattern. Shared by the builder and Planet's palette retint so an LLM
 * palette never wipes the pattern.
 */
export function colorizeTerrain(geom, surface, palette) {
  const { above, patMix, patWhich } = surface;
  const colors = geom.attributes.color.array;
  const colWater = new THREE.Color(palette.water);
  const colLow   = new THREE.Color(palette.low);
  const colMid   = new THREE.Color(palette.mid);
  const colHigh  = new THREE.Color(palette.high);
  const colSnow  = new THREE.Color(palette.snow);
  // Pattern colors: 0 = a sibling of the lowland color (fields, furrows —
  // variation you'd expect of the same ground), 1 = an accent pulled from
  // the palette's light end (rings, spots, veins — a mark someone made).
  const pat0 = colLow.clone().lerp(colMid, 0.3).offsetHSL(0.06, 0.12, 0.12);
  const pat2 = colLow.clone().offsetHSL(-0.04, 0.02, -0.11);
  const pat1 = new THREE.Color(palette.sky || palette.snow);
  {
    const hsl = {};
    pat1.getHSL(hsl);
    pat1.setHSL(hsl.h, Math.max(0.5, hsl.s), 0.62);
  }
  const patColors = [pat0, pat1, pat2];
  const waterAccent = colWater.clone().lerp(new THREE.Color(palette.sky || palette.snow), 0.45);
  const c = new THREE.Color();
  for (let i = 0; i < above.length; i++) {
    const a = above[i];
    if (a < 0) {
      c.copy(colWater);
      if (patMix[i] > 0) c.lerp(waterAccent, patMix[i] * 0.6);
    } else {
      if (a < 0.25)      c.copy(colLow).lerp(colMid, smoothstep(0.0, 0.25, a));
      else if (a < 0.65) c.copy(colMid).lerp(colHigh, smoothstep(0.25, 0.65, a));
      else               c.copy(colHigh).lerp(colSnow, smoothstep(0.65, 1.0, a));
      if (patMix[i] > 0) c.lerp(patColors[patWhich[i]], patMix[i]);
    }
    colors[i * 3 + 0] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geom.attributes.color.needsUpdate = true;
}

function smoothstep(a, b, t) {
  const x = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
}
