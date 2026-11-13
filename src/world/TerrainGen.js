import * as THREE from 'three';
import { makeNoise3, fbm } from './Seed.js';
import { makeShaper } from './TerrainShapes.js';

// Generate a planet mesh: subdivided icosa, multi-octave noise displacement.
// Returns { geometry, elevations, palette, seaLevel, sample, field, ... }.
//
// elevations: per-vertex normalized elevation in [0..1] (used for landmark slot picking).
//
// Colour is not baked into the mesh (roadmap 1d). Each vertex carries two
// numbers and the ground shader (GroundMaterial.js) does the rest:
//   aAbove       shaped height above sea, 0..1 on land, -1 under water
//                (pattern gates: patchwork stops at 0.75, rows at 0.7)
//   aColorAbove  the colour height: the palette band the vertex is painted
//
// Two meshes come from one height function:
//   - buildPlanetGeometry: the COARSE mesh (detail 16). Every planet has it;
//     placement (landmark slots, scatter, ground snap) reads it, always.
//   - buildFineTerrain: a FINER mesh for the planet the player is at
//     (TerrainDetail.js). Same height function, same sea level, k times the
//     subdivisions; every coarse vertex is also a fine vertex, bit for bit,
//     so anything placed on a coarse vertex sits on the fine surface too.

const DEFAULT_PALETTE = {
  water:  '#21507e',
  low:    '#5b8a3a',
  mid:    '#a98a4b',
  high:   '#7a5a3c',
  snow:   '#f5f1e6',
  sky:    '#9ac4e8',
};

export const COARSE_DETAIL = 16;

export function buildPlanetGeometry({ seed, radius, palette = DEFAULT_PALETTE, subdivisions = COARSE_DETAIL, seaLevelQuantile = 0.42, ampScale = 1.0, shape = 'rolling', pattern = 'none' }) {
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

  // Color height: half absolute, half RANK among land vertices. Shapes
  // that push most land to one level (a rift world is one high plateau
  // with a canyon) would otherwise paint nearly everything snow; the
  // rank term guarantees every world spans its lowland→peak colors.
  const landIdx = [];
  for (let i = 0; i < vCount; i++) if (above[i] >= 0) landIdx.push(i);
  landIdx.sort((a, b) => above[a] - above[b]);
  const colorAbove = new Float32Array(vCount).fill(-1);
  const nLand = Math.max(1, landIdx.length - 1);
  const landAbove = new Float32Array(landIdx.length);
  for (let k = 0; k < landIdx.length; k++) {
    const i = landIdx[k];
    landAbove[k] = above[i];
    colorAbove[i] = 0.5 * above[i] + 0.5 * (k / nLand);
  }

  geom.setAttribute('aAbove', new THREE.BufferAttribute(above, 1));
  geom.setAttribute('aColorAbove', new THREE.BufferAttribute(colorAbove, 1));
  geom.deleteAttribute('uv');
  geom.computeVertexNormals();
  pos.needsUpdate = true;

  // Everything the fine mesh needs to evaluate the SAME surface: the raw
  // field, this planet's sea level and range (not re-derived from the fine
  // vertices, so the shape and `sample` never change), and the sorted land
  // heights for the colour rank.
  const field = { radius, subdivisions, rawAt, aboveOf, heightOfAbove, landAbove };

  return {
    geometry: geom, elevations, palette, seaLevel: seaNorm,
    sample, field, focus: shaper.focus, shape, pattern,
  };
}

// ── Fine mesh (roadmap 1d) ──────────────────────────────────────────────

// three's icosahedron (IcosahedronGeometry.js), copied so the fine mesh
// subdivides exactly the same base faces in the same order.
const ICO_T = (1 + Math.sqrt(5)) / 2;
const ICO_VERTS = [
  -1, ICO_T, 0, 1, ICO_T, 0, -1, -ICO_T, 0, 1, -ICO_T, 0,
  0, -1, ICO_T, 0, 1, ICO_T, 0, -1, -ICO_T, 0, 1, -ICO_T,
  ICO_T, 0, -1, ICO_T, 0, 1, -ICO_T, 0, -1, -ICO_T, 0, 1,
];
const ICO_FACES = [
  0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
  1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
  3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
  4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
];

/** Triangles in an icosphere of three's `detail`. */
export function icoTriangles(detail) { return 20 * (detail + 1) * (detail + 1); }

/** The detail of a mesh k times finer than `coarse` whose vertices include every coarse vertex. */
export function fineDetailOf(coarse, k) { return k * (coarse + 1) - 1; }

/**
 * Build the fine terrain mesh, in steps: a generator that does one base
 * face of the icosahedron per step and yields that face's collider piece
 * ({ face, vertices, indices }: the face's grid, indexed), so a caller can
 * spread the work, collider included, over frames (TerrainDetail.js) or
 * just drain it.
 *
 * The subdivision reproduces three's PolyhedronGeometry exactly (same
 * lerps, same rounding: grid point → normalize → ×radius → f32 → normalize
 * again, as buildPlanetGeometry reads it back). With detail k·17−1 the
 * grid point (k·i, k·j) of a face is the rational point (i, j) of the
 * coarse grid, and IEEE division rounds both to the same double, so every
 * coarse vertex comes out as a fine vertex with identical coordinates.
 *
 * Returns (as the generator's value) { geometry, pieces, triangles,
 * detail }. The geometry is non-indexed with face normals, like the coarse
 * mesh (shadow normal bias and the contact-shading prepass read the normal
 * attribute). Collider pieces are indexed (each grid point once): a third
 * of the vertices to hand to Rapier, and twenty small trimeshes build in
 * about a millisecond each where one big one stalls a frame.
 */
export function* buildFineTerrain(field, k) {
  const { radius, subdivisions, rawAt, aboveOf, heightOfAbove, landAbove } = field;
  const detail = fineDetailOf(subdivisions, k);
  const cols = detail + 1;
  const gridPerFace = (cols + 1) * (cols + 2) / 2;
  const trisPerFace = cols * cols;
  const triangles = 20 * trisPerFace;

  const position = new Float32Array(triangles * 9);
  const normal = new Float32Array(triangles * 9);
  const aboveAttr = new Float32Array(triangles * 3);
  const colorAttr = new Float32Array(triangles * 3);
  const pieces = [];

  const nLand = Math.max(1, landAbove.length - 1);
  const colorAboveOf = (a) => {
    if (a < 0) return -1;
    // Rank among the coarse land heights (upper bound), as the coarse mesh
    // ranks its own vertices.
    let lo = 0, hi = landAbove.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (landAbove[mid] <= a) lo = mid + 1; else hi = mid; }
    return 0.5 * a + 0.5 * (Math.max(0, lo - 1) / nLand);
  };

  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const aj = new THREE.Vector3(), bj = new THREE.Vector3(), p = new THREE.Vector3();
  const gx = new Float32Array(gridPerFace), gy = new Float32Array(gridPerFace), gz = new Float32Array(gridPerFace);
  const gAbove = new Float32Array(gridPerFace), gColor = new Float32Array(gridPerFace);
  // Row starts of the triangular grid: v[i][j] → rowStart[i] + j.
  const rowStart = new Int32Array(cols + 2);
  for (let i = 0, s = 0; i <= cols; i++) { rowStart[i] = s; s += cols - i + 1; }

  let tri = 0;
  for (let f = 0; f < 20; f++) {
    a.fromArray(ICO_VERTS, ICO_FACES[f * 3] * 3);
    b.fromArray(ICO_VERTS, ICO_FACES[f * 3 + 1] * 3);
    c.fromArray(ICO_VERTS, ICO_FACES[f * 3 + 2] * 3);
    const vertices = new Float32Array(gridPerFace * 3);
    const indices = new Uint32Array(trisPerFace * 3);
    const triBase = tri;
    for (let i = 0; i <= cols; i++) {
      aj.copy(a).lerp(c, i / cols);
      bj.copy(b).lerp(c, i / cols);
      const rows = cols - i;
      for (let j = 0; j <= rows; j++) {
        if (j === 0 && i === cols) p.copy(aj);
        else p.copy(aj).lerp(bj, j / rows);
        // As PolyhedronGeometry stores it (×radius, f32), then as
        // buildPlanetGeometry reads it back (normalize).
        p.normalize().multiplyScalar(radius);
        p.set(Math.fround(p.x), Math.fround(p.y), Math.fround(p.z)).normalize();
        const ab = aboveOf(rawAt(p));
        const h = heightOfAbove(ab);
        const g = rowStart[i] + j;
        gx[g] = p.x * h; gy[g] = p.y * h; gz[g] = p.z * h;   // f32, as pos.setXYZ stores it
        gAbove[g] = ab;
        gColor[g] = colorAboveOf(ab);
        vertices[g * 3] = gx[g]; vertices[g * 3 + 1] = gy[g]; vertices[g * 3 + 2] = gz[g];
      }
    }
    // Triangles in PolyhedronGeometry's order and winding.
    const put = (g0, g1, g2) => {
      const o = tri * 9;
      const ids = [g0, g1, g2];
      for (let q = 0; q < 3; q++) {
        const g = ids[q];
        position[o + q * 3] = gx[g]; position[o + q * 3 + 1] = gy[g]; position[o + q * 3 + 2] = gz[g];
        aboveAttr[tri * 3 + q] = gAbove[g];
        colorAttr[tri * 3 + q] = gColor[g];
        indices[(tri - triBase) * 3 + q] = g;
      }
      // Face normal (computeVertexNormals on a non-indexed mesh does the same).
      const e1x = position[o + 3] - position[o], e1y = position[o + 4] - position[o + 1], e1z = position[o + 5] - position[o + 2];
      const e2x = position[o + 6] - position[o + 3], e2y = position[o + 7] - position[o + 4], e2z = position[o + 8] - position[o + 5];
      // three: cb = c − b, ab = a − b, cb × ab
      let nx = e2y * -e1z - e2z * -e1y, ny = e2z * -e1x - e2x * -e1z, nz = e2x * -e1y - e2y * -e1x;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      for (let q = 0; q < 3; q++) { normal[o + q * 3] = nx; normal[o + q * 3 + 1] = ny; normal[o + q * 3 + 2] = nz; }
      tri++;
    };
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < 2 * (cols - i) - 1; j++) {
        const kk = Math.floor(j / 2);
        if (j % 2 === 0) put(rowStart[i] + kk + 1, rowStart[i + 1] + kk, rowStart[i] + kk);
        else put(rowStart[i] + kk + 1, rowStart[i + 1] + kk + 1, rowStart[i + 1] + kk);
      }
    }
    const piece = { face: f, vertices, indices };
    pieces.push(piece);
    if (f < 19) yield piece;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('aAbove', new THREE.BufferAttribute(aboveAttr, 1));
  geometry.setAttribute('aColorAbove', new THREE.BufferAttribute(colorAttr, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius * 2);
  return { geometry, pieces, triangles, detail };
}

/** Drain buildFineTerrain in one go. */
export function buildFineTerrainNow(field, k) {
  const it = buildFineTerrain(field, k);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}
