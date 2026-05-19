import * as THREE from 'three';
import { makeNoise3, fbm, mulberry32 } from './Seed.js';

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

export function buildPlanetGeometry({ seed, radius, palette = DEFAULT_PALETTE, subdivisions = 5 }) {
  const noise = makeNoise3(seed);
  const noise2 = makeNoise3(seed ^ 0x9e3779b9);

  const geom = new THREE.IcosahedronGeometry(radius, subdivisions);
  const pos = geom.attributes.position;
  const vCount = pos.count;

  const elevations = new Float32Array(vCount);
  const colors = new Float32Array(vCount * 3);

  // Elevation amplitude (in world units) — keep small relative to radius.
  const amp = radius * 0.10;

  const tmp = new THREE.Vector3();
  const colWater = new THREE.Color(palette.water);
  const colLow   = new THREE.Color(palette.low);
  const colMid   = new THREE.Color(palette.mid);
  const colHigh  = new THREE.Color(palette.high);
  const colSnow  = new THREE.Color(palette.snow);

  let minE = Infinity, maxE = -Infinity;
  const raw = new Float32Array(vCount);

  for (let i = 0; i < vCount; i++) {
    tmp.fromBufferAttribute(pos, i);
    tmp.normalize();
    // continents
    const c = fbm(noise, tmp.x * 1.2, tmp.y * 1.2, tmp.z * 1.2, 5, 2.0, 0.5);
    // ridges (abs noise)
    const r = 1.0 - Math.abs(fbm(noise2, tmp.x * 3.0, tmp.y * 3.0, tmp.z * 3.0, 4, 2.0, 0.55));
    const e = c * 0.7 + (r - 0.5) * 0.6;
    raw[i] = e;
    if (e < minE) minE = e;
    if (e > maxE) maxE = e;
  }

  const range = maxE - minE || 1;
  // Sea level chosen so ~40% of surface is below it.
  const seaLevel = minE + range * 0.42;

  const tmpColor = new THREE.Color();
  for (let i = 0; i < vCount; i++) {
    tmp.fromBufferAttribute(pos, i);
    tmp.normalize();
    const e = raw[i];
    const norm = (e - minE) / range; // 0..1
    elevations[i] = norm;

    let h;
    if (e < seaLevel) {
      // flatten oceans
      h = radius * 0.995;
      tmpColor.copy(colWater);
    } else {
      const above = (e - seaLevel) / (maxE - seaLevel || 1); // 0..1
      h = radius + amp * Math.pow(above, 1.05);

      if (above < 0.25)      tmpColor.copy(colLow).lerp(colMid, smoothstep(0.0, 0.25, above));
      else if (above < 0.65) tmpColor.copy(colMid).lerp(colHigh, smoothstep(0.25, 0.65, above));
      else                   tmpColor.copy(colHigh).lerp(colSnow, smoothstep(0.65, 1.0, above));
    }

    pos.setXYZ(i, tmp.x * h, tmp.y * h, tmp.z * h);
    colors[i * 3 + 0] = tmpColor.r;
    colors[i * 3 + 1] = tmpColor.g;
    colors[i * 3 + 2] = tmpColor.b;
  }

  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geom.computeVertexNormals();
  pos.needsUpdate = true;

  return { geometry: geom, elevations, palette, seaLevel: 0.42 };
}

function smoothstep(a, b, t) {
  const x = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
}

// Sample terrain radius along a normalized direction. Used for altitude-above-terrain.
// Walks the mesh by re-running the noise — cheaper than mesh raycast for a frequent query.
export function makeTerrainSampler({ seed, radius, seaLevel = 0.42 }) {
  const noise = makeNoise3(seed);
  const noise2 = makeNoise3(seed ^ 0x9e3779b9);
  const amp = radius * 0.10;

  // We have to re-derive minE/maxE to be consistent with builder. Use a cheap fixed sample.
  // (For Phase 1 we approximate — actual mesh is what matters for collisions.)
  return function sampleHeight(dirX, dirY, dirZ) {
    const c = fbm(noise, dirX * 1.2, dirY * 1.2, dirZ * 1.2, 5, 2.0, 0.5);
    const r = 1.0 - Math.abs(fbm(noise2, dirX * 3.0, dirY * 3.0, dirZ * 3.0, 4, 2.0, 0.55));
    const e = c * 0.7 + (r - 0.5) * 0.6;
    // approx range [-0.6 .. 0.7]
    const norm = (e + 0.6) / 1.3;
    if (norm < seaLevel) return radius * 0.995;
    const above = (norm - seaLevel) / (1 - seaLevel);
    return radius + amp * Math.pow(Math.max(0, above), 1.05);
  };
}
