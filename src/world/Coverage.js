// Coverage: how much of a planet's surface the player has "seen" while in
// atmosphere. Surface is sampled as N points distributed evenly on a unit
// sphere via the Fibonacci method (equal solid angle per point, no polar
// crowding). A point is marked "seen" once the plane's nadir direction
// (radial-down from current position) gets within COVERAGE_DOT of it.
//
// Coverage state lives on the Planet and is reset when the player leaves
// atmosphere without claiming. Once a planet is claimed, the entry is
// permanent in the logbook regardless of coverage going forward.

import * as THREE from 'three';
import { TUNING } from '../game/Tuning.js';

export class Coverage {
  constructor() {
    this.cells = makeFibonacciSphere(TUNING.CLAIM_COVERAGE_CELLS);
    this.seen = new Uint8Array(this.cells.length); // 0/1 per cell
    this._seenCount = 0;
    // After the first tick the player has automatically "seen" ~25% of the
    // sphere (the visible hemisphere within the COVERAGE_DOT cone). That
    // baseline isn't progress they made — it's just being in atmosphere.
    // Snapshot it so the HUD bar can render "progress toward claim" as
    // 0..1 spanning (baseline → CLAIM_COVERAGE) instead of (0 → 1).
    // -1 = not yet established (no tick() has run since construction/reset).
    this._baseline = -1;
  }

  /**
   * Update coverage given the plane's current position relative to the
   * planet center. Returns true if the seen-set grew this tick.
   */
  tick(planePos, planetCenter) {
    const nadir = _tmpA.copy(planePos).sub(planetCenter);
    const r2 = nadir.lengthSq();
    if (r2 < 1e-6) return false;
    nadir.multiplyScalar(1 / Math.sqrt(r2));
    const dotMin = TUNING.CLAIM_COVERAGE_DOT;
    let grew = false;
    const cells = this.cells;
    const seen = this.seen;
    for (let i = 0; i < cells.length; i++) {
      if (seen[i]) continue;
      const c = cells[i];
      const d = nadir.x * c.x + nadir.y * c.y + nadir.z * c.z;
      if (d >= dotMin) {
        seen[i] = 1;
        this._seenCount++;
        grew = true;
      }
    }
    // Capture baseline immediately after the first tick (= what's instantly
    // visible from the entry position). Subsequent ticks add the player's
    // actual surveying progress on top.
    if (this._baseline < 0) this._baseline = this._seenCount / this.cells.length;
    return grew;
  }

  /** 0-1 fraction of cells seen (absolute, including baseline). */
  pct() { return this._seenCount / this.cells.length; }

  /**
   * 0-1 fraction the player has surveyed *beyond* what was instantly
   * visible on atmosphere entry. Returns 0 before the first tick.
   * Used by the HUD progress bar so it starts at empty when the player
   * arrives, rather than at the cone-coverage baseline.
   */
  baseline() { return this._baseline < 0 ? 0 : this._baseline; }

  /** Forget everything; used when the player exits atmosphere before claiming. */
  reset() {
    this.seen.fill(0);
    this._seenCount = 0;
    this._baseline = -1;
  }
}

function makeFibonacciSphere(n) {
  const out = new Array(n);
  const ga = Math.PI * (Math.sqrt(5) - 1); // golden angle
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;       // -1 → 1
    const r = Math.sqrt(1 - y * y);
    const theta = ga * i;
    out[i] = new THREE.Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r);
  }
  return out;
}

const _tmpA = new THREE.Vector3();
