import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { LOOKS, LOOK_ORDER, GAME_LOOK, getLook } from '../../src/render/Looks.js';

describe('look presets', () => {
  it('lists every look once, with the game\'s look first', () => {
    expect(LOOK_ORDER[0]).toBe('sunlit');
    expect(GAME_LOOK).toBe(LOOKS.sunlit);
    expect([...LOOK_ORDER].sort()).toEqual(Object.keys(LOOKS).sort());
    for (const id of LOOK_ORDER) expect(LOOKS[id].id).toBe(id);
  });

  it('gives every look the fields the rig and post read', () => {
    for (const look of Object.values(LOOKS)) {
      expect(look.name, look.id).toBeTruthy();
      expect(look.blurb, look.id).toBeTruthy();
      expect(typeof look.background, look.id).toBe('number');
      expect(look.lights.sun.intensity, look.id).toBeGreaterThan(0);
      expect(look.lights.hemi.intensity, look.id).toBeGreaterThanOrEqual(0);
      expect(look.lights.ambient, look.id).toBeTruthy();
      if (look.shadow) {
        for (const key of ['radius', 'intensity', 'bias', 'normalBias']) {
          expect(typeof look.shadow[key], `${look.id}.shadow.${key}`).toBe('number');
        }
      }
      if (look.post) {
        for (const key of ['toneMapping', 'exposure', 'saturation', 'contrast', 'vignette']) {
          expect(look.post[key], `${look.id}.post.${key}`).not.toBeUndefined();
        }
      }
    }
  });

  it('the game\'s look has shadows, filmic tone mapping and a finishing pass', () => {
    expect(GAME_LOOK.shadow).toBeTruthy();
    expect(GAME_LOOK.post.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(GAME_LOOK.post.ao).toBeTruthy();
    expect(GAME_LOOK.post.bloom).toBeTruthy();
  });

  it('falls back to the game\'s look for an unknown id', () => {
    expect(getLook('nope')).toBe(GAME_LOOK);
    expect(getLook(null)).toBe(GAME_LOOK);
    expect(getLook('now')).toBe(LOOKS.now);
  });
});
