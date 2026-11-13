// Terrain detail (roadmap 1d): which planets get the fine terrain mesh, and
// when.
//
// Every planet is built coarse (detail 16, ~5.8k triangles; TerrainGen.js).
// The planet the player is at gets a mesh k times finer (smaller facets,
// truer slopes and silhouettes) and a collider to match. Placement never
// moves: it is always computed on the coarse mesh, and every coarse vertex
// is a fine vertex.
//
// When: a planet starts refining while the plane is still REFINE_AT metres
// above its surface (a few pixels per facet at that range; the build takes
// about a third of a second spread over frames), and goes back to coarse
// past RELEASE_AT. At most MAX_FINE planets are fine at once, nearest first.
// After a jump (spawn, warp, respawn: the plane moved more than JUMP_M in
// one update) or on the first update, every planet in range refines at
// once, inside that frame — a cut, so nothing visibly changes shape.
//
// The pure decisions (fineFactorFor, planDetail) are unit-tested; the
// scheduler below drives Planet.beginRefine / stepRefine / refineNow /
// coarsen.

export const DETAIL = {
  REFINE_AT: 1200,     // m above the surface: start refining
  RELEASE_AT: 2400,    // m above the surface: back to coarse
  MAX_FINE: 2,         // planets fine at once
  JUMP_M: 250,         // the plane moved this far in one update: a cut
  STEP_BUDGET_MS: 3,   // build time per frame for an async refine
  // Fine facet target: the coarse edge (0.0619 · radius at detail 16)
  // divided by k, aiming at about this many metres, k in [K_MIN, K_MAX].
  TARGET_EDGE_M: 2.6,
  K_MIN: 2,
  K_MAX: 4,
};

// Mean edge of three's icosphere at detail 16, as a fraction of radius
// (icosahedron edge 1.0515 / 17 segments).
const COARSE_EDGE_FRAC = 1.0515 / 17;

/** How many times finer than the coarse mesh a planet of `radius` gets. */
export function fineFactorFor(radius, d = DETAIL) {
  const k = Math.ceil((radius * COARSE_EDGE_FRAC) / d.TARGET_EDGE_M - 1e-9);
  return Math.max(d.K_MIN, Math.min(d.K_MAX, k));
}

/**
 * Decide each planet's detail.
 * @param {Array<{ id: any, surfaceDist: number, detail: 'coarse'|'building'|'fine' }>} planets
 * @param {{ jump?: boolean }} [opts]
 * @returns {{ refine: any[], refineNow: any[], release: any[] }} ids
 */
export function planDetail(planets, { jump = false } = {}, d = DETAIL) {
  const ranked = planets.slice().sort((a, b) => a.surfaceDist - b.surfaceDist);
  const refine = [], refineNow = [], release = [];
  ranked.forEach((p, rank) => {
    const keep = rank < d.MAX_FINE;
    if (p.detail === 'coarse') {
      if (keep && p.surfaceDist < d.REFINE_AT) (jump ? refineNow : refine).push(p.id);
    } else {
      if (!keep || p.surfaceDist > d.RELEASE_AT) release.push(p.id);
      else if (jump && p.detail === 'building') refineNow.push(p.id);
    }
  });
  return { refine, refineNow, release };
}

/**
 * Per-frame scheduler. `update(planets, planePos, galaxyPos)` with Planet
 * objects; `galaxyPos` (the plane in galaxy coordinates) detects jumps, so a
 * floating-origin rebase — which moves the plane's render position — is not
 * mistaken for one. Builds one planet at a time, nearest first, within
 * STEP_BUDGET_MS.
 */
export class TerrainDetail {
  constructor(d = DETAIL) {
    this.d = d;
    this.lastPos = null;
    this.stats = { refines: 0, syncRefines: 0, releases: 0, lastBuildMs: 0, maxStepMs: 0 };
  }

  update(planets, planePos, galaxyPos = planePos) {
    if (!Array.isArray(planets)) planets = Array.from(planets);
    const jump = !this.lastPos || this.lastPos.distanceTo(galaxyPos) > this.d.JUMP_M;
    this.lastPos = (this.lastPos || galaxyPos.clone()).copy(galaxyPos);
    const byId = new Map();
    const rows = planets.map((p, i) => {
      byId.set(i, p);
      return { id: i, surfaceDist: p.center.distanceTo(planePos) - p.radius, detail: p.detailState };
    });
    const plan = planDetail(rows, { jump }, this.d);
    for (const id of plan.release) { byId.get(id).coarsen(); this.stats.releases++; }
    for (const id of plan.refineNow) {
      const p = byId.get(id);
      const t0 = performance.now();
      p.refineNow(fineFactorFor(p.radius, this.d));
      this.stats.lastBuildMs = performance.now() - t0;
      this.stats.syncRefines++;
    }
    for (const id of plan.refine) {
      const p = byId.get(id);
      p.beginRefine(fineFactorFor(p.radius, this.d));
    }
    // Advance the nearest building planet within this frame's budget.
    const building = rows.filter((r) => byId.get(r.id).detailState === 'building')
      .sort((a, b) => a.surfaceDist - b.surfaceDist)[0];
    if (building) {
      const p = byId.get(building.id);
      const t0 = performance.now();
      const done = p.stepRefine(t0 + this.d.STEP_BUDGET_MS);
      const ms = performance.now() - t0;
      this.stats.maxStepMs = Math.max(this.stats.maxStepMs, ms);
      if (done) this.stats.refines++;
    }
  }
}
