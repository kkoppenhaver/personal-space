import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { DEFAULT_SKY, skyPalette, skyWeights, horizonAt } from '../../src/render/SkyPalette.js';
import { GAME_LOOK } from '../../src/render/Looks.js';

const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const sat = (c) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
const SKIES = ['#9bc9c8', '#8fcadf', '#d8c89c', '#d97554', '#c3a8e0', '#bcd6e4', '#90d1c5'];

describe('sky palette', () => {
  const s = { ...DEFAULT_SKY, ...GAME_LOOK.sky };
  const gain = GAME_LOOK.skyGain;

  it('the game look carries every sky setting', () => {
    for (const key of Object.keys(DEFAULT_SKY)) {
      expect(GAME_LOOK.sky[key], `sky.${key}`).not.toBeUndefined();
    }
  });

  it('is deeper overhead and paler at the horizon, never brighter than the pre-1c sky', () => {
    for (const hex of SKIES) {
      const p = skyPalette(hex, { gain, s });
      const S = new THREE.Color(hex);
      // The pre-1c shell drew about skyGain × palette (plus 5%) everywhere.
      const before = lum(S) * gain * 1.05;
      expect(lum(p.zenith), hex).toBeLessThan(lum(p.horizon));
      expect(lum(p.horizon), hex).toBeLessThanOrEqual(before);
      expect(sat(p.zenith) / lum(p.zenith), hex).toBeGreaterThan(sat(p.horizon) / lum(p.horizon));
    }
  });

  it('dusk is warm toward the sun and cool away; night is dark', () => {
    for (const hex of SKIES) {
      const p = skyPalette(hex, { gain, s, sunColor: new THREE.Color(0xfff2d6) });
      expect(p.duskWarm.r, hex).toBeGreaterThan(p.duskWarm.b);
      expect(p.duskCool.b, hex).toBeGreaterThan(p.duskCool.r);
      expect(lum(p.night), hex).toBeLessThan(0.04);
    }
  });

  it('weights move day → dusk → night with the sun, summing to one', () => {
    const noon = skyWeights(0.9), set = skyWeights(-0.03), deep = skyWeights(-0.6);
    expect(noon.day).toBe(1);
    expect(set.dusk).toBeGreaterThan(0.9);
    expect(deep.night).toBe(1);
    for (const e of [-1, -0.3, -0.1, 0, 0.1, 0.3, 1]) {
      const w = skyWeights(e);
      expect(w.day + w.dusk + w.night).toBeCloseTo(1, 6);
    }
  });

  it('the fog colour follows the horizon', () => {
    const p = skyPalette('#9bc9c8', { gain, s });
    const near = (a, b) => ['r', 'g', 'b'].forEach((k) => expect(a[k]).toBeCloseTo(b[k], 6));
    near(horizonAt(p, 0.9), p.horizon);
    near(horizonAt(p, -0.9), p.night);
  });
});
