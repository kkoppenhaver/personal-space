import { describe, it, expect } from 'vitest';
import { LOOKS, LOOK_ORDER, getLook, rampValue } from '../../src/render/Looks.js';

describe('look presets', () => {
  it('lists every look once, with the shipped game first', () => {
    expect(LOOK_ORDER[0]).toBe('now');
    expect([...LOOK_ORDER].sort()).toEqual(Object.keys(LOOKS).sort());
    for (const id of LOOK_ORDER) expect(LOOKS[id].id).toBe(id);
  });

  it('gives every look the fields the rig, materials and post read', () => {
    for (const look of Object.values(LOOKS)) {
      expect(look.name, look.id).toBeTruthy();
      expect(look.blurb, look.id).toBeTruthy();
      expect(typeof look.background, look.id).toBe('number');
      expect(look.lights.sun.intensity, look.id).toBeGreaterThan(0);
      expect(look.lights.hemi.intensity, look.id).toBeGreaterThanOrEqual(0);
      expect(look.lights.ambient, look.id).toBeTruthy();
      // A look either leaves the game alone entirely or defines all three.
      const parts = [look.ramp, look.surface, look.post].map(Boolean);
      expect(new Set(parts).size, `${look.id}: ramp/surface/post all or none`).toBe(1);
      if (look.post) {
        for (const key of ['toneMapping', 'exposure', 'saturation', 'contrast', 'grain', 'vignette', 'hatch', 'tiltShift']) {
          expect(look.post[key], `${look.id}.post.${key}`).not.toBeUndefined();
        }
      }
    }
  });

  it('falls back to the shipped game for an unknown id', () => {
    expect(getLook('nope')).toBe(LOOKS.now);
    expect(getLook('paper')).toBe(LOOKS.paper);
  });
});

describe('rampValue', () => {
  const samples = Array.from({ length: 201 }, (_, i) => -1 + i / 100);

  it('stays in 0…1, is dark facing away from the sun and full facing it', () => {
    for (const id of LOOK_ORDER) {
      const look = LOOKS[id];
      for (const ndl of samples) {
        const v = rampValue(look, ndl);
        expect(v, `${id} @ ${ndl}`).toBeGreaterThanOrEqual(0);
        expect(v, `${id} @ ${ndl}`).toBeLessThanOrEqual(1);
      }
      expect(rampValue(look, -0.5), id).toBe(0);
      expect(rampValue(look, 1), id).toBeCloseTo(1, 5);
    }
  });

  it('never gets darker as a surface turns toward the sun', () => {
    for (const id of LOOK_ORDER) {
      let prev = -1;
      for (const ndl of samples) {
        const v = rampValue(LOOKS[id], ndl);
        expect(v, `${id} @ ${ndl}`).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = v;
      }
    }
  });

  it('is plain cosine falloff with no ramp', () => {
    expect(rampValue(LOOKS.now, 0.4)).toBeCloseTo(0.4, 9);
    expect(rampValue(null, -0.2)).toBe(0);
  });

  it('paper is two tones: nearly flat once lit', () => {
    const lit = [0.3, 0.6, 1].map((n) => rampValue(LOOKS.paper, n));
    expect(Math.max(...lit) - Math.min(...lit)).toBeLessThan(0.2);
    expect(rampValue(LOOKS.paper, 0)).toBe(0);
  });

  it('ink is three flat steps', () => {
    const steps = new Set([-0.5, -0.1, 0.1, 0.3, 0.5, 0.7, 0.9].map((n) => rampValue(LOOKS.ink, n).toFixed(2)));
    expect([...steps].sort()).toEqual(['0.00', '0.55', '1.00']);
  });
});
