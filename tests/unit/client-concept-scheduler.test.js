import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { ConceptScheduler } from '../../src/llm/ConceptScheduler.js';
import { planetSeedFor } from '../../shared/planet-dice.js';

const TUNING = { CONCEPT_NEAR_RADIUS: 8000, CONCEPT_AIM_DOT: 0.97, CONCEPT_AIM_MS: 700 };

// Fake system: sun at `at`, planets on a small ring around it.
function makeSystem(seed, at, n = 3) {
  const sun = { position: at.clone() };
  const planets = [];
  for (let i = 0; i < n; i++) {
    planets.push({
      seed: planetSeedFor(seed, i),
      radius: 100 + i * 7.4,
      center: at.clone().add(new Vector3(300 * (i + 1), 0, 0)),
    });
  }
  return { seed, sun, planets };
}

function makeLlm({ cached = {} } = {}) {
  const calls = [];
  return {
    calls,
    netCalls: 0,
    peekConcept(seed) { return cached[seed] || null; },
    concept(seed, context, identity) {
      calls.push({ seed, context, identity });
      this.netCalls++;
      return Promise.resolve({ name: `N${seed}`, teaser: `teaser ${seed}` });
    },
  };
}

function setup(opts) {
  const llm = makeLlm(opts);
  const delivered = [];
  const sched = new ConceptScheduler({
    llm,
    tuning: TUNING,
    onConcept: (planet, concept, system, index) => delivered.push({ planet, concept, system, index }),
  });
  return { llm, sched, delivered };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const ORIGIN = new Vector3(0, 0, 0);
const FWD_X = new Vector3(1, 0, 0);
const FWD_Y = new Vector3(0, 1, 0);

// Drive update() every `stepMs` from t0 to t1 (inclusive of t0).
function drive(sched, { from, to, stepMs = 16, planePos = ORIGIN, planeFwd, activeSystem = null }) {
  for (let t = from; t <= to; t += stepMs) sched.update({ planePos, planeFwd, activeSystem, nowMs: t });
}

describe('ConceptScheduler', () => {
  it('charts only the active system at start', async () => {
    const { llm, sched, delivered } = setup();
    const home = makeSystem(11, new Vector3(0, 0, 0), 4);
    const far = makeSystem(22, new Vector3(20000, 0, 0), 5);
    sched.track(home);
    sched.track(far);
    drive(sched, { from: 0, to: 2000, planeFwd: FWD_Y, activeSystem: home, planePos: new Vector3(0, 0, -100) });
    await flush();
    expect(llm.calls.map((c) => c.seed).sort()).toEqual(home.planets.map((p) => p.seed).sort());
    expect(delivered).toHaveLength(4);
    expect(sched.isCharted(home)).toBe(true);
    expect(sched.isCharted(far)).toBe(false);
  });

  it('sends identity + the shared concept context', async () => {
    const { llm, sched } = setup();
    const home = makeSystem(11, ORIGIN, 2);
    sched.track(home);
    await sched.chart(home);
    const c = llm.calls[1];
    expect(c.identity).toEqual({ system_seed: 11, planet_index: 1, radius: Math.round(home.planets[1].radius) });
    expect(c.context).toMatchObject({ radius: 107, tier: expect.any(String), register: expect.any(String) });
    expect(c.context.sparks).toHaveLength(4);
  });

  it('charts a system whose sun is inside the near radius', async () => {
    const { llm, sched } = setup();
    const near = makeSystem(33, new Vector3(7000, 0, 0));
    sched.track(near);
    drive(sched, { from: 0, to: 100, planeFwd: FWD_Y });
    await flush();
    expect(llm.calls).toHaveLength(3);
  });

  it('requires sustained aim: a 300 ms glance does not chart, 800 ms does', async () => {
    const { llm, sched } = setup();
    const far = makeSystem(44, new Vector3(20000, 0, 0));
    sched.track(far);
    // glance
    drive(sched, { from: 0, to: 300, planeFwd: FWD_X });
    drive(sched, { from: 316, to: 2000, planeFwd: FWD_Y });
    await flush();
    expect(llm.calls).toHaveLength(0);
    // sustained
    drive(sched, { from: 3000, to: 3800, planeFwd: FWD_X });
    await flush();
    expect(llm.calls).toHaveLength(3);
  });

  it('counts aim at one of the system planets, not just the sun', async () => {
    const { llm, sched } = setup();
    const far = makeSystem(45, new Vector3(20000, 0, 0));
    // Put planet 2 well off the sun's axis (dot with the sun direction is
    // ~0.93, below the aim threshold) and aim at the planet only.
    far.planets[2].center.set(20000, 8000, 0);
    const toPlanet = far.planets[2].center.clone().normalize();
    sched.track(far);
    drive(sched, { from: 0, to: 1000, planeFwd: toPlanet });
    await flush();
    expect(llm.calls).toHaveLength(3);
  });

  it('never charts a far, un-aimed system', async () => {
    const { llm, sched } = setup();
    const far = makeSystem(55, new Vector3(20000, 0, 0));
    sched.track(far);
    drive(sched, { from: 0, to: 20000, stepMs: 50, planeFwd: FWD_Y.clone().negate() });
    await flush();
    expect(llm.calls).toHaveLength(0);
    expect(sched.isCharted(far)).toBe(false);
  });

  it('requests each planet at most once', async () => {
    const { llm, sched } = setup();
    const home = makeSystem(66, ORIGIN, 4);
    sched.track(home);
    drive(sched, { from: 0, to: 5000, planeFwd: FWD_X, activeSystem: home });
    await sched.chart(home);
    await sched.chart(home);
    await Promise.all(home.planets.map((p) => sched.ensure(p)));
    expect(llm.calls).toHaveLength(4);
    expect(new Set(llm.calls.map((c) => c.seed)).size).toBe(4);
  });

  it('delivers cached concepts on track with zero network calls', () => {
    const sys = makeSystem(77, new Vector3(20000, 0, 0), 3);
    const cached = Object.fromEntries(sys.planets.map((p) => [p.seed, { name: 'C', teaser: 'cached' }]));
    const { llm, sched, delivered } = setup({ cached });
    sched.track(sys);
    expect(delivered).toHaveLength(3);                 // synchronous
    expect(delivered.every((d) => d.concept.teaser === 'cached')).toBe(true);
    expect(llm.calls).toHaveLength(0);
    return sched.chart(sys).then(() => expect(llm.calls).toHaveLength(0));
  });

  it('re-tracking a system this session is free (no second request)', async () => {
    const { llm, sched, delivered } = setup();
    const sys = makeSystem(78, ORIGIN, 2);
    sched.track(sys);
    await sched.chart(sys);
    sched.untrack(sys);
    sched.track(sys);
    expect(llm.calls).toHaveLength(2);
    expect(delivered).toHaveLength(4);
  });

  it('ensure() charts on demand and resolves after delivery', async () => {
    const { llm, sched, delivered } = setup();
    const far = makeSystem(88, new Vector3(20000, 0, 0), 3);
    sched.track(far);
    const c = await sched.ensure(far.planets[1]);
    expect(c).toEqual({ name: `N${far.planets[1].seed}`, teaser: `teaser ${far.planets[1].seed}` });
    expect(delivered.some((d) => d.planet === far.planets[1])).toBe(true);
    expect(sched.isCharted(far)).toBe(true);
    expect(llm.calls).toHaveLength(3);
  });

  it('untrack stops delivery of in-flight results', async () => {
    const { llm, sched, delivered } = setup();
    const sys = makeSystem(99, ORIGIN, 3);
    sched.track(sys);
    const p = sched.chart(sys);
    sched.untrack(sys);
    await p;
    expect(llm.calls).toHaveLength(3);
    expect(delivered).toHaveLength(0);
    // and it no longer scans it
    drive(sched, { from: 10000, to: 11000, planeFwd: FWD_X, activeSystem: sys });
    await flush();
    expect(llm.calls).toHaveLength(3);
  });

  it('a failed concept resolves ensure() to null without throwing', async () => {
    const { llm, sched, delivered } = setup();
    llm.concept = () => Promise.reject(new Error('boom'));
    const sys = makeSystem(100, ORIGIN, 1);
    sched.track(sys);
    await expect(sched.ensure(sys.planets[0])).resolves.toBeNull();
    expect(delivered).toHaveLength(0);
  });
});
