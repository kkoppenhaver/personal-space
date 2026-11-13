import { describe, it, expect } from 'vitest';
import {
  TIERS, TIER_SETTINGS, AUTO, parseQuality, lowerTier, initialAuto, stepAuto, resolveTier,
} from '../../src/render/Quality.js';

// Feed `n` frames of `ms` each, starting at `t0`. Returns [state, t].
function run(state, n, ms, t0 = 0, ctx) {
  let t = t0;
  for (let i = 0; i < n; i++) {
    t += ms;
    state = stepAuto(state, ms, t, ctx);
  }
  return [state, t];
}

describe('quality settings', () => {
  it('every tier has every setting, and cost only goes down the list', () => {
    const keys = Object.keys(TIER_SETTINGS.high).sort();
    for (const t of TIERS) expect(Object.keys(TIER_SETTINGS[t]).sort(), t).toEqual(keys);
    const { high, medium, low } = TIER_SETTINGS;
    expect(high.ao && !medium.ao && !low.ao).toBe(true);
    expect(medium.shadowMapSize).toBeLessThan(high.shadowMapSize);
    expect(medium.msaa).toBeLessThan(high.msaa);
    expect(low.composer).toBe(false);
    expect(low.shadows).toBe(false);
    expect(high.pixelRatioCap).toBeGreaterThan(low.pixelRatioCap);
  });

  it('parses choices', () => {
    expect(parseQuality('HIGH')).toBe('high');
    expect(parseQuality(' auto ')).toBe('auto');
    expect(parseQuality('ultra')).toBeNull();
    expect(parseQuality(null)).toBeNull();
    expect(lowerTier('high')).toBe('medium');
    expect(lowerTier('high', 2)).toBe('low');
    expect(lowerTier('low')).toBe('low');
  });

  it('a picked tier wins over auto', () => {
    expect(resolveTier('low', 'high')).toBe('low');
    expect(resolveTier('auto', 'medium')).toBe('medium');
    expect(resolveTier(null, 'medium')).toBe('medium');
    expect(resolveTier('bogus', 'high')).toBe('high');
  });
});

describe('auto tier', () => {
  it('keeps high on a fast machine and stops deciding', () => {
    let [s] = run(initialAuto(0), 400, 16.7);
    expect(s.tier).toBe('high');
    expect(s.done).toBe(true);
  });

  it('waits for the scene to settle before measuring', () => {
    // Slow-ish frames, but only during the settle window: no decision yet.
    let [s] = run(initialAuto(0), 5, 100);
    expect(s.tier).toBe('high');
    expect(s.samples.length).toBe(0);
  });

  it('steps down one tier when steadily too slow, then holds', () => {
    let s = initialAuto(0);
    let t = 0;
    while (s.tier === 'high' && t < 60_000) [s, t] = run(s, 1, 40, t);   // 25 fps
    expect(s.tier).toBe('medium');
    [s, t] = run(s, 300, 20, t);                           // fine at medium
    expect(s.tier).toBe('medium');
    expect(s.done).toBe(true);
    // Never re-evaluates, never steps back up.
    [s] = run(s, 300, 8, t);
    expect(s.tier).toBe('medium');
  });

  it('goes all the way to low and stops there', () => {
    let [s] = run(initialAuto(0), 1000, 45);
    expect(s.tier).toBe('low');
    expect(s.done).toBe(true);
  });

  it('decides at once on hopeless frames (software rendering), skipping a tier when very slow', () => {
    let [s] = run(initialAuto(0), 5, 3000);
    expect(s.tier).toBe('low');
    [s] = run(initialAuto(0), 5, 400);
    expect(s.tier).toBe('medium');
  });

  it('ignores one-off stalls (shader compiles) in an otherwise fast run', () => {
    let s = initialAuto(0);
    let t = 0;
    for (let i = 0; i < 400; i++) {
      const ms = i % 50 === 10 ? 600 : 16;
      t += ms;
      s = stepAuto(s, ms, t);
    }
    expect(s.tier).toBe('high');
  });

  it('does not measure while hidden or paused, or across a long gap', () => {
    let [s, t] = run(initialAuto(0), 200, 50, 0, { visible: false });
    expect(s.tier).toBe('high');
    expect(s.done).toBe(false);
    [s, t] = run(s, 200, 50, t, { paused: true });
    expect(s.tier).toBe('high');
    s = stepAuto(s, AUTO.gapMs + 1, t + AUTO.gapMs + 1);
    expect(s.frames).toBe(0);
  });

  it('does not oscillate: tiers only ever go down, at most twice', () => {
    let s = initialAuto(0);
    let t = 0;
    const seen = [s.tier];
    // Alternate slow and fast stretches.
    for (let k = 0; k < 20; k++) {
      [s, t] = run(s, 150, k % 2 ? 12 : 60, t);
      if (seen[seen.length - 1] !== s.tier) seen.push(s.tier);
    }
    for (let i = 1; i < seen.length; i++) {
      expect(TIERS.indexOf(seen[i])).toBeGreaterThan(TIERS.indexOf(seen[i - 1]));
    }
    expect(seen.length).toBeLessThanOrEqual(3);
  });

  it('does not modify the state it is given', () => {
    const s = initialAuto(0);
    const copy = JSON.stringify(s);
    stepAuto(s, 16, 16);
    expect(JSON.stringify(s)).toBe(copy);
  });
});
