// Per-attempt flight statistics: top speed, distance flown, time to land,
// crashes-during-this-attempt. Reset on every spawn/respawn so the numbers
// stored with a logbook entry describe the flight that *actually landed*,
// not the cumulative session.

export class FlightStats {
  constructor() {
    this._reset();
  }

  /**
   * Call on every fresh spawn (game start, R reset, crash respawn).
   * Increment crash counter optionally so respawn-after-crash carries it forward.
   */
  resetAttempt({ incrementCrashes = false } = {}) {
    const carriedCrashes = incrementCrashes ? this.crashes + 1 : 0;
    this._reset();
    this.crashes = carriedCrashes;
  }

  /**
   * Called once per fixed step. dt in seconds; planeVelocityMagnitude in m/s.
   * Distance is integrated from velocity so it stays correct across
   * floating-origin rebases (which would nuke a position-delta approach).
   */
  tick(dt, planeVelocityMagnitude) {
    if (planeVelocityMagnitude > this.topSpeed) this.topSpeed = planeVelocityMagnitude;
    this.distanceM += planeVelocityMagnitude * dt;
  }

  /**
   * Stamp the moment the plane left the spawn point. Called from main.js
   * boot + reset paths so time-to-land measures the right interval.
   */
  startAttempt() {
    this.startedAtMs = performance.now();
  }

  /**
   * Snapshot the stats at the moment of claim, then start a fresh attempt
   * so the NEXT claim describes the flight from here to there. (This used
   * to freeze until an unfreeze() nobody called — every claim after the
   * first saved the stale numbers from the first.)
   */
  capture() {
    const snap = {
      time_to_land_ms: Math.round(performance.now() - this.startedAtMs),
      top_speed: round1(this.topSpeed),
      crashes: this.crashes,
      distance_m: Math.round(this.distanceM),
    };
    this._reset();
    return snap;
  }

  _reset() {
    this.topSpeed = 0;
    this.distanceM = 0;
    this.crashes = 0;
    this.startedAtMs = performance.now();
  }
}

function round1(n) { return Math.round(n * 10) / 10; }
