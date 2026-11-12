// ConceptScheduler — decides which planets get a /concept call, and when.
//
// Concepts used to be requested eagerly for every planet of every streamed
// system (~45 paid calls right after START, almost all for planets the
// player never visits). Now a system is "charted" — its planets' concepts
// requested, once each — only when the player is in it, near it, or has
// held the nose on it long enough to mean it:
//
//   - it is the active system (holds the planet the player is nearest to);
//   - its sun is within TUNING.CONCEPT_NEAR_RADIUS of the plane;
//   - the plane, in open space, has been aimed at it (its sun or one of
//     its planets) at dot ≥ TUNING.CONCEPT_AIM_DOT continuously for
//     TUNING.CONCEPT_AIM_MS. (Not inside an atmosphere: the plane orbits on
//     its own there and its nose sweeps the whole sky.)
//     The player navigates BY teasers, so pointing at a distant system
//     must reveal its names.
//
// Concepts already known are delivered for free on track(): persisted real
// concepts (llm.peekConcept — returning players, systems streaming back in)
// and anything delivered earlier this session (including offline/fallback
// concepts, which LLMClient keeps session-only).
//
// No DOM, no renderer: unit-tested in node with a fake llm and fake systems
// ({ seed, sun: { position }, planets: [{ seed, radius, center }] }).

import { TUNING } from '../game/Tuning.js';
import { conceptContextFor } from '../world/ConceptSeed.js';

const SCAN_INTERVAL_MS = 250;   // ~4 scans a second

export class ConceptScheduler {
  /**
   * @param {object} opts
   * @param {{ concept: Function, peekConcept: Function }} opts.llm
   * @param {(planet, concept, system, index) => void} opts.onConcept
   * @param {object} [opts.tuning] defaults to TUNING (overridable in tests)
   */
  constructor({ llm, onConcept = () => {}, tuning = TUNING } = {}) {
    this.llm = llm;
    this.onConcept = onConcept;
    this.tuning = tuning;
    this._systems = new Map();    // system -> entry
    this._planets = new Map();    // planet -> { entry, index }
    this._known = new Map();      // planet seed -> concept delivered this session
    this._lastScanMs = -Infinity;
    // Cost-relevant counters (console: __GAME.conceptScheduler.stats).
    this.stats = { requested: 0, delivered: 0, freeOnTrack: 0, systemsCharted: 0 };
  }

  /** Register a freshly spawned system. Delivers known concepts immediately. */
  track(system) {
    if (!system || this._systems.has(system)) return;
    const entry = {
      system,
      charted: false,
      aimSince: null,
      slots: system.planets.map(() => ({ promise: null, concept: null })),
    };
    this._systems.set(system, entry);
    system.planets.forEach((planet, index) => {
      this._planets.set(planet, { entry, index });
      const known = this.llm.peekConcept?.(planet.seed) || this._known.get(planet.seed >>> 0) || null;
      if (known) {
        this.stats.freeOnTrack++;
        this._deliver(entry, index, known);
        entry.slots[index].promise = Promise.resolve(known);
      }
    });
  }

  /** Forget a despawned system; in-flight results for it are dropped. */
  untrack(system) {
    const entry = this._systems.get(system);
    if (!entry) return;
    this._systems.delete(system);
    for (const planet of system.planets) this._planets.delete(planet);
  }

  isTracked(planetOrSystem) {
    return this._systems.has(planetOrSystem) || this._planets.has(planetOrSystem);
  }

  isCharted(system) {
    return !!this._systems.get(system)?.charted;
  }

  /**
   * Per fixed step. Throttled internally to SCAN_INTERVAL_MS.
   * @param {{ planePos: Vector3, planeFwd: Vector3, activeSystem?: object, nowMs: number, inAtmosphere?: boolean }} s
   */
  update({ planePos, planeFwd, activeSystem = null, nowMs, inAtmosphere = false }) {
    if (nowMs - this._lastScanMs < SCAN_INTERVAL_MS) return;
    this._lastScanMs = nowMs;
    const { CONCEPT_NEAR_RADIUS, CONCEPT_AIM_DOT, CONCEPT_AIM_MS } = this.tuning;
    const nearSq = CONCEPT_NEAR_RADIUS * CONCEPT_NEAR_RADIUS;

    for (const entry of this._systems.values()) {
      if (entry.charted) continue;
      const sys = entry.system;
      if (sys === activeSystem) { this.chart(sys); continue; }
      const sunPos = sys.sun?.position;
      if (sunPos && planePos.distanceToSquared(sunPos) <= nearSq) { this.chart(sys); continue; }

      // Aim only counts in open space, where the nose goes where the player
      // points it. Inside an atmosphere the plane orbits on its own and its
      // nose sweeps the whole sky at about 10 degrees a second: on the live
      // site an idle plane charted 4 extra systems (20 calls) that way.
      if (!inAtmosphere && planeFwd && this._aimedAt(sys, planePos, planeFwd, CONCEPT_AIM_DOT)) {
        if (entry.aimSince == null) entry.aimSince = nowMs;
        else if (nowMs - entry.aimSince >= CONCEPT_AIM_MS) this.chart(sys);
      } else {
        entry.aimSince = null;
      }
    }
  }

  /** Request concepts for every planet of `system` (each at most once). */
  chart(system) {
    const entry = this._systems.get(system);
    if (!entry) return Promise.resolve([]);
    if (!entry.charted) {
      entry.charted = true;
      entry.aimSince = null;
      this.stats.systemsCharted++;
    }
    return Promise.all(system.planets.map((_, i) => this._request(entry, i)));
  }

  /**
   * Promise for this planet's concept (null when unobtainable), charting
   * its system on demand. Resolves AFTER onConcept has run for it.
   */
  ensure(planet) {
    const ref = this._planets.get(planet);
    if (!ref) return Promise.resolve(planet?.concept || null);
    this.chart(ref.entry.system);
    return ref.entry.slots[ref.index].promise;
  }

  // ── internals ──────────────────────────────────────────────────────

  _aimedAt(sys, planePos, planeFwd, minDot) {
    const targets = [sys.sun?.position, ...sys.planets.map((p) => p.center)];
    for (const t of targets) {
      if (!t) continue;
      const dx = t.x - planePos.x, dy = t.y - planePos.y, dz = t.z - planePos.z;
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-6) return true;
      if ((planeFwd.x * dx + planeFwd.y * dy + planeFwd.z * dz) / len >= minDot) return true;
    }
    return false;
  }

  _request(entry, index) {
    const slot = entry.slots[index];
    if (slot.promise) return slot.promise;
    const sys = entry.system;
    const planet = sys.planets[index];
    const identity = { system_seed: sys.seed >>> 0, planet_index: index, radius: Math.round(planet.radius) };
    const context = conceptContextFor({ systemSeed: sys.seed, planetIndex: index, radius: planet.radius });
    this.stats.requested++;
    slot.promise = Promise.resolve()
      .then(() => this.llm.concept(planet.seed, context, identity))
      .then((c) => {
        if (!c?.teaser) return null;
        this._known.set(planet.seed >>> 0, c);
        // Dropped if the system despawned while the call was in flight.
        if (this._systems.get(sys) === entry) this._deliver(entry, index, c);
        return c;
      })
      .catch((err) => {
        console.warn('[ConceptScheduler] concept failed:', err?.message || err);
        return null;
      });
    return slot.promise;
  }

  _deliver(entry, index, concept) {
    const slot = entry.slots[index];
    if (slot.concept) return;
    slot.concept = concept;
    this.stats.delivered++;
    try {
      this.onConcept(entry.system.planets[index], concept, entry.system, index);
    } catch (err) {
      console.warn('[ConceptScheduler] onConcept handler failed:', err);
    }
  }
}
