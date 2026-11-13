import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { DEFAULT_SKY, skyPalette, skyWeights, horizonAt } from '../../src/render/SkyPalette.js';
import { GAME_LOOK } from '../../src/render/Looks.js';
import { bakeCloudField, cloudCover, cloudForm, REGISTER_FORM, BIOME_CLOUDS } from '../../src/world/CloudStyle.js';
import { REGISTERS } from '../../shared/planet-dice.js';

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

describe('clouds', () => {
  it('every register has a form and the same seed always gives the same clouds', () => {
    for (const r of REGISTERS) expect(REGISTER_FORM[r], r).toBeTruthy();
    const a = cloudForm({ register: 'eerie', seed: 1234 });
    const b = cloudForm({ register: 'eerie', seed: 1234 });
    expect(a).toEqual(b);
    const fa = bakeCloudField(a, 64, 32);
    expect(Array.from(fa)).toEqual(Array.from(bakeCloudField(b, 64, 32)));
    expect(Array.from(fa)).not.toEqual(Array.from(bakeCloudField(cloudForm({ register: 'eerie', seed: 99 }), 64, 32)));
  });

  it('the field is area-uniform, so coverage means a fraction of the sphere', () => {
    const f = bakeCloudField(cloudForm({ register: 'serene', seed: 7 }), 128, 64);
    let area = 0, covered = 0;
    for (let j = 0; j < 64; j++) {
      const w = Math.sin((1 - (j + 0.5) / 64) * Math.PI);
      for (let i = 0; i < 128; i++) {
        area += w;
        if (f[j * 128 + i] / 255 > 0.7) covered += w;
      }
    }
    expect(covered / area).toBeGreaterThan(0.27);
    expect(covered / area).toBeLessThan(0.33);
  });

  it('biome sets amount and tint; a desert is sparser than an ocean', () => {
    const form = cloudForm({ register: 'cozy', seed: 5 });
    for (const b of Object.keys(BIOME_CLOUDS)) {
      const c = cloudCover(form, b);
      expect(c.cover).toBeGreaterThan(0.05);
      expect(c.cover).toBeLessThanOrEqual(0.6);
    }
    expect(cloudCover(form, 'desert').cover).toBeLessThan(cloudCover(form, 'ocean').cover);
    expect(cloudCover(form, null).cover).toBeGreaterThan(0);
  });
});
