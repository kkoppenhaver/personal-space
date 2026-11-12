import { describe, it, expect } from 'vitest';
import { hashSeeds } from '../../shared/prng.js';
import {
  conceptContextFor, planetSeedFor, rollTier,
  RADIUS_MIN, RADIUS_MAX, TERRAIN_SHAPES, GROUND_PATTERNS,
} from '../../shared/planet-dice.js';

describe('conceptContextFor', () => {
  it('is pinned for a known identity (changing it changes every cached concept)', () => {
    expect(conceptContextFor({ systemSeed: 123456789, planetIndex: 2, radius: 97 })).toEqual({
      radius: 97,
      tier: 'quiet',
      sparks: ['copper', 'delight', 'forgotten on purpose', 'one of everything'],
      register: 'playful',
      name_initial: 'Q',
      terrain_shape: 'ridge',
      ground_pattern: 'patchwork',
    });
  });

  it('is deterministic', () => {
    for (let s = 0; s < 50; s++) {
      const id = { systemSeed: s * 7919 + 13, planetIndex: s % 6, radius: 80 + s };
      expect(conceptContextFor(id)).toEqual(conceptContextFor({ ...id }));
    }
  });

  it('deals distinct registers, initials and landforms across a 6-planet system', () => {
    for (let s = 0; s < 200; s++) {
      const sys = hashSeeds(s, 0xbeef);
      const ctxs = Array.from({ length: 6 }, (_, i) => conceptContextFor({ systemSeed: sys, planetIndex: i, radius: 100 }));
      for (const k of ['register', 'name_initial', 'terrain_shape']) {
        expect(new Set(ctxs.map((c) => c[k])).size, `${k} for system ${sys}`).toBe(6);
      }
      for (const c of ctxs) {
        expect(TERRAIN_SHAPES).toContain(c.terrain_shape);
        expect(GROUND_PATTERNS).toContain(c.ground_pattern);
      }
    }
  });

  it('clamps and rounds the radius', () => {
    const r = (radius) => conceptContextFor({ systemSeed: 1, planetIndex: 0, radius }).radius;
    expect(r(97.4)).toBe(97);
    expect(r(97.6)).toBe(98);
    expect(r(1)).toBe(RADIUS_MIN);
    expect(r(-500)).toBe(RADIUS_MIN);
    expect(r(1e9)).toBe(RADIUS_MAX);
    expect(r('120')).toBe(120);
    expect(r(NaN)).toBe(100);
    expect(r(undefined)).toBe(100);
  });
});

describe('planetSeedFor', () => {
  it('mirrors hashSeeds(system, index + 1)', () => {
    for (let s = 0; s < 100; s++) {
      const sys = hashSeeds(s, 42);
      for (let i = 0; i < 6; i++) expect(planetSeedFor(sys, i)).toBe(hashSeeds(sys, i + 1));
    }
  });
});

describe('rollTier', () => {
  it('lands within 3 points of 60/33/7 over 20,000 planet seeds', () => {
    const counts = { quiet: 0, notable: 0, singular: 0 };
    const N = 20_000;
    for (let i = 0; i < N; i++) counts[rollTier(planetSeedFor(hashSeeds(Math.floor(i / 5), 7), i % 5))]++;
    expect(Math.abs((counts.quiet / N) * 100 - 60)).toBeLessThan(3);
    expect(Math.abs((counts.notable / N) * 100 - 33)).toBeLessThan(3);
    expect(Math.abs((counts.singular / N) * 100 - 7)).toBeLessThan(3);
  });
});
