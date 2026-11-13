import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { DETAIL, fineFactorFor, planDetail, TerrainDetail } from '../../src/world/TerrainDetail.js';
import {
  buildPlanetGeometry, buildFineTerrain, buildFineTerrainNow,
  fineDetailOf, icoTriangles, COARSE_DETAIL,
} from '../../src/world/TerrainGen.js';

describe('fine detail factor', () => {
  it('aims at about TARGET_EDGE_M facets, within [K_MIN, K_MAX]', () => {
    expect(fineFactorFor(60)).toBe(2);    // the bench planets
    expect(fineFactorFor(80)).toBe(2);    // smallest game planet
    expect(fineFactorFor(100)).toBe(3);
    expect(fineFactorFor(140)).toBe(4);   // largest game planet
    expect(fineFactorFor(240)).toBe(4);   // clamped
    expect(fineFactorFor(10)).toBe(DETAIL.K_MIN);
    for (const r of [60, 80, 100, 120, 140]) {
      const edge = (r * 1.0515 / 17) / fineFactorFor(r);
      expect(edge).toBeLessThanOrEqual(DETAIL.TARGET_EDGE_M + 1e-9);
    }
  });

  it('fine detail keeps every coarse grid point: (detail+1) is a multiple of 17', () => {
    for (const k of [2, 3, 4]) {
      const d = fineDetailOf(COARSE_DETAIL, k);
      expect((d + 1) % (COARSE_DETAIL + 1)).toBe(0);
      expect(icoTriangles(d)).toBe(k * k * icoTriangles(COARSE_DETAIL));
    }
  });
});

describe('planDetail', () => {
  const row = (id, surfaceDist, detail = 'coarse') => ({ id, surfaceDist, detail });

  it('starts an async refine inside REFINE_AT, nearest MAX_FINE only', () => {
    const plan = planDetail([row('a', 900), row('b', 300), row('c', 1100), row('d', 5000)]);
    expect(plan.refine.sort()).toEqual(['a', 'b']);
    expect(plan.refineNow).toEqual([]);
    expect(plan.release).toEqual([]);
  });

  it('refines inside the frame after a jump', () => {
    const plan = planDetail([row('a', 40), row('b', 1500)], { jump: true });
    expect(plan.refineNow).toEqual(['a']);
    expect(plan.refine).toEqual([]);
  });

  it('finishes a running build at once after a jump', () => {
    const plan = planDetail([row('a', 40, 'building')], { jump: true });
    expect(plan.refineNow).toEqual(['a']);
  });

  it('keeps a fine planet until RELEASE_AT (hysteresis), then releases it', () => {
    expect(planDetail([row('a', DETAIL.REFINE_AT + 100, 'fine')]).release).toEqual([]);
    expect(planDetail([row('a', DETAIL.RELEASE_AT + 1, 'fine')]).release).toEqual(['a']);
    // and does not re-refine a coarse planet between the two thresholds
    expect(planDetail([row('a', DETAIL.REFINE_AT + 100)]).refine).toEqual([]);
  });

  it('releases a fine or building planet pushed out of the nearest MAX_FINE', () => {
    const plan = planDetail([row('a', 100, 'fine'), row('b', 200, 'fine'), row('c', 50)]);
    expect(plan.refine).toEqual(['c']);
    expect(plan.release).toEqual(['b']);
    expect(planDetail([row('a', 10), row('b', 20), row('c', 30, 'building')]).release).toEqual(['c']);
  });
});

describe('TerrainDetail scheduler', () => {
  const fakePlanet = (x, radius = 100) => {
    const p = {
      center: new THREE.Vector3(x, 0, 0), radius, detailState: 'coarse', calls: [],
      beginRefine(k) { this.calls.push(['begin', k]); this.detailState = 'building'; },
      stepRefine() { this.calls.push(['step']); this.detailState = 'fine'; return true; },
      refineNow(k) { this.calls.push(['now', k]); this.detailState = 'fine'; },
      coarsen() { this.calls.push(['coarsen']); this.detailState = 'coarse'; },
    };
    return p;
  };

  it('refines in the frame on the first update, and asynchronously when flown into range', () => {
    const td = new TerrainDetail();
    const near = fakePlanet(0), far = fakePlanet(5000);
    const pos = new THREE.Vector3(400, 0, 0);
    td.update([near, far], pos);
    expect(near.calls).toEqual([['now', 3]]);
    expect(far.calls).toEqual([]);
    // fly toward `far` a few metres a frame: no jump → begin + step
    const g = pos.clone();
    for (let x = 400; x <= 3900; x += 5) { pos.set(x, 0, 0); g.copy(pos); td.update([near, far], pos, g); }
    expect(far.calls[0]).toEqual(['begin', 3]);
    expect(far.calls.some((c) => c[0] === 'now')).toBe(false);
  });

  it('does not take a floating-origin rebase for a jump', () => {
    const td = new TerrainDetail();
    const a = fakePlanet(0);
    td.update([a], new THREE.Vector3(5000, 0, 0), new THREE.Vector3(5000, 0, 0));   // out of range
    // The world shifts by −4000: render position jumps, galaxy position does not.
    a.center.x -= 4000;
    td.update([a], new THREE.Vector3(1000, 0, 0), new THREE.Vector3(5002, 0, 0));
    expect(a.calls).toEqual([]);
    // Next frame, plane flies into range of `a` normally.
    td.update([a], new THREE.Vector3(-2900, 0, 0), new THREE.Vector3(5004, 0, 0));
    expect(a.calls[0][0]).toBe('begin');
  });
});

describe('fine terrain mesh', () => {
  const key = (x, y, z) => `${x},${y},${z}`;
  const cases = [
    { seed: 101, radius: 60, shape: 'rolling', sea: 0.42, k: 2 },
    { seed: 808, radius: 100, shape: 'spires', sea: 0.3, k: 3 },
    { seed: 404, radius: 140, shape: 'mesas', sea: 0.15, k: 4 },
  ];

  for (const c of cases) {
    it(`${c.shape} r=${c.radius} k=${c.k}: every coarse vertex is a fine vertex, bit for bit`, () => {
      const built = buildPlanetGeometry({ seed: c.seed, radius: c.radius, shape: c.shape, seaLevelQuantile: c.sea });
      const fine = buildFineTerrainNow(built.field, c.k);
      const fp = fine.geometry.attributes.position.array;
      const set = new Set();
      for (let i = 0; i < fp.length; i += 3) set.add(key(fp[i], fp[i + 1], fp[i + 2]));
      const cp = built.geometry.attributes.position.array;
      let missing = 0;
      for (let i = 0; i < cp.length; i += 3) if (!set.has(key(cp[i], cp[i + 1], cp[i + 2]))) missing++;
      expect(missing).toBe(0);
      expect(fine.triangles).toBe(c.k * c.k * icoTriangles(COARSE_DETAIL));
      expect(fp.length).toBe(fine.triangles * 9);
    });
  }

  it('lies on the planet\'s height function (the HUD/flight sampler) at every vertex', () => {
    const built = buildPlanetGeometry({ seed: 202, radius: 100, shape: 'one-mountain', seaLevelQuantile: 0.42 });
    const fine = buildFineTerrainNow(built.field, 3);
    const p = fine.geometry.attributes.position.array;
    const v = new THREE.Vector3();
    let worst = 0;
    for (let i = 0; i < p.length; i += 9 * 37) {   // a spread sample
      v.set(p[i], p[i + 1], p[i + 2]);
      const r = v.length();
      v.normalize();
      worst = Math.max(worst, Math.abs(built.sample(v.x, v.y, v.z) - r));
    }
    expect(worst).toBeLessThan(1e-3);   // f32 storage only
  });

  it('is deterministic, and the stepped build matches the one-shot build', () => {
    const a = buildPlanetGeometry({ seed: 707, radius: 90, shape: 'crater', seaLevelQuantile: 0 });
    const b = buildPlanetGeometry({ seed: 707, radius: 90, shape: 'crater', seaLevelQuantile: 0 });
    const fa = buildFineTerrainNow(a.field, 2);
    const it = buildFineTerrain(b.field, 2);
    let steps = 0, r = it.next();
    while (!r.done) { steps++; expect(r.value.vertices).toBeInstanceOf(Float32Array); r = it.next(); }
    expect(steps).toBe(19);
    for (const name of ['position', 'normal', 'aAbove', 'aColorAbove']) {
      expect(r.value.geometry.attributes[name].array).toEqual(fa.geometry.attributes[name].array);
    }
  });

  it('collider pieces carry exactly the drawn triangles, and normals face outward', () => {
    const built = buildPlanetGeometry({ seed: 303, radius: 80, shape: 'terraced', seaLevelQuantile: 0.6 });
    const fine = buildFineTerrainNow(built.field, 2);
    expect(fine.pieces.length).toBe(20);
    const pos = fine.geometry.attributes.position.array;
    const nor = fine.geometry.attributes.normal.array;
    let t = 0;
    for (const piece of fine.pieces) {
      for (let i = 0; i < piece.indices.length; i++, t++) {
        const g = piece.indices[i];
        expect(piece.vertices[g * 3]).toBe(pos[t * 3]);
        expect(piece.vertices[g * 3 + 1]).toBe(pos[t * 3 + 1]);
        expect(piece.vertices[g * 3 + 2]).toBe(pos[t * 3 + 2]);
      }
    }
    expect(t).toBe(fine.triangles * 3);
    let inward = 0;
    for (let i = 0; i < pos.length; i += 9) {
      const cx = pos[i] + pos[i + 3] + pos[i + 6], cy = pos[i + 1] + pos[i + 4] + pos[i + 7], cz = pos[i + 2] + pos[i + 5] + pos[i + 8];
      if (cx * nor[i] + cy * nor[i + 1] + cz * nor[i + 2] < 0) inward++;
    }
    // Cliff faces can tilt past vertical; nearly all faces point out.
    expect(inward / fine.triangles).toBeLessThan(0.01);
  });

  it('colours by the same rank as the coarse mesh at shared vertices', () => {
    const built = buildPlanetGeometry({ seed: 505, radius: 100, shape: 'dunes', seaLevelQuantile: 0 });
    const fine = buildFineTerrainNow(built.field, 3);
    const fineColor = new Map();
    const fp = fine.geometry.attributes.position.array, fc = fine.geometry.attributes.aColorAbove.array;
    for (let i = 0; i < fc.length; i++) fineColor.set(key(fp[i * 3], fp[i * 3 + 1], fp[i * 3 + 2]), fc[i]);
    const cp = built.geometry.attributes.position.array, cc = built.geometry.attributes.aColorAbove.array;
    let worst = 0;
    for (let i = 0; i < cc.length; i++) worst = Math.max(worst, Math.abs(fineColor.get(key(cp[i * 3], cp[i * 3 + 1], cp[i * 3 + 2])) - cc[i]));
    // Ties in the coarse rank are the only difference.
    expect(worst).toBeLessThan(0.02);
  });
});
