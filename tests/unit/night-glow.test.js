import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { nightRoleFor, isPane, isBulb, computeNightMasks, prepareNightGlow } from '../../src/world/NightGlow.js';
import { nightAt, nightLighting } from '../../src/world/NightLights.js';
import { GAME_LOOK } from '../../src/render/Looks.js';

const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const hex = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255].map((v) => s2l(v / 255));

describe('night roles', () => {
  it('finds buildings, lamps and crystals by id', () => {
    expect(nightRoleFor({ assetId: 'quaternius:space:House_Long', family: 'structure' })).toBe('building');
    expect(nightRoleFor({ assetId: 'kenney:castle:tower-square-mid-windows', family: 'structure' })).toBe('building');
    expect(nightRoleFor({ assetId: 'kenney:space:hangar_largeA', family: 'metal' })).toBe('building');
    expect(nightRoleFor({ assetId: 'kenney:space:structure_detailed', family: 'structure' })).toBe('building');
    expect(nightRoleFor({ assetId: 'kenney:graveyard:crypt-large', family: 'bone' })).toBe('building');
    expect(nightRoleFor({ assetId: 'kenney:graveyard:lightpost-double', family: 'metal' })).toBe('lamp');
    expect(nightRoleFor({ assetId: 'kaykit:space_base:lights', family: 'metal' })).toBe('lamp');
    expect(nightRoleFor({ assetId: 'quaternius:space:Tree_Light_1', family: 'flora' })).toBe('lamp');
    expect(nightRoleFor({ assetId: 'kenney:space:rock_crystalsLargeA', family: 'crystal' })).toBe('crystal');
  });

  it('leaves building-kit pieces, ships and nature alone', () => {
    for (const id of [
      'kenney:space:terrain_roadStraight', 'kenney:fantasy_town:fountain-round', 'quaternius:ruins:Column_Round',
      'quaternius:ruins:Statue_Fox', 'kenney:pirate:structure-platform', 'kenney:pirate:ship-large',
      'quaternius:nature:PineTree_1', 'kenney:space:chimney', 'kenney:graveyard:crypt-door', 'kaykit:space_base:lander_A',
    ]) expect(nightRoleFor({ assetId: id }), id).toBe(null);
  });
});

describe('colour tests', () => {
  it('reads dark, grey window panes against the model mean', () => {
    const mean = 0.45;   // a pale castle wall
    expect(isPane(...hex(0x404048), mean)).toBe(true);
    expect(isPane(...hex(0xe4aa84), mean)).toBe(false);
    expect(isPane(...hex(0x2050c0), mean)).toBe(false);  // saturated dark blue roof
  });

  it('reads warm, bright, saturated parts as bulbs', () => {
    expect(isBulb(...hex(0xffc044))).toBe(true);    // lamp-post glass
    expect(isBulb(...hex(0xf0c45d))).toBe(true);    // light mast bulbs
    expect(isBulb(...hex(0x4bb580))).toBe(false);   // green post
    expect(isBulb(...hex(0xbdc6ee))).toBe(false);   // pale cap
    expect(isBulb(...hex(0x7a5a20))).toBe(false);   // dark brown
  });
});

describe('masks', () => {
  const part = (cols) => ({ colors: new Float32Array(cols.flatMap(hex)), count: cols.length });

  it('uses real panes when a building has a few dark parts', () => {
    const walls = Array(40).fill(0xe4aa84);
    const panes = Array(4).fill(0x404048);
    const { masks, mode, paneShare } = computeNightMasks([part([...walls, ...panes])], 'building');
    expect(mode).toBe('panes');
    expect(paneShare).toBeCloseTo(4 / 44, 5);
    expect(masks[0][40 * 2]).toBe(1);
    expect(masks[0][0]).toBe(0);
  });

  it('falls back to drawn windows for one-colour walls and dark models', () => {
    expect(computeNightMasks([part(Array(40).fill(0xacacac))], 'building').mode).toBe('grid');
    const dark = [...Array(20).fill(0x272727), ...Array(20).fill(0x464c50)];
    expect(computeNightMasks([part(dark)], 'building').mode).toBe('grid');
    expect(computeNightMasks([{ colors: null, count: 10 }], 'building').mode).toBe('grid');
  });

  it('marks bulbs on lamps and every vertex on crystals', () => {
    const lamp = computeNightMasks([part([0x4bb580, 0xffc044, 0x4bb580])], 'lamp');
    expect([...lamp.masks[0]]).toEqual([0, 0, 0, 1, 0, 0]);
    const crystal = computeNightMasks([part([0x9988ff, 0x8877ee])], 'crystal');
    expect([...crystal.masks[0]]).toEqual([0, 1, 0, 1]);
  });

  it('tags a model clone: attribute, material info, bulb centroid', () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 2, 1], 3));
    g.userData.authoredColors = new Float32Array([0x4bb580, 0x4bb580, 0xffc044, 0xffc044].flatMap(hex));
    const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial());
    const root = new THREE.Group().add(mesh);
    const info = prepareNightGlow(root, { assetId: 'kenney:graveyard:lightpost-single' });
    expect(info.role).toBe('lamp');
    expect(g.getAttribute('nightMask').count).toBe(4);
    expect(mesh.material.userData.night).toBe(info);
    expect(info.bulb.y).toBeCloseTo(2);
    expect(prepareNightGlow(new THREE.Group(), { assetId: 'quaternius:nature:PineTree_1' })).toBe(null);
  });
});

describe('night amount', () => {
  const C = new THREE.Vector3(10, 0, 0);
  const sun = new THREE.Vector3(10, 1e5, 0);
  it('is 0 under the sun, 1 opposite it', () => {
    expect(nightAt(new THREE.Vector3(10, 100, 0), C, sun)).toBe(0);
    expect(nightAt(new THREE.Vector3(10, -100, 0), C, sun)).toBe(1);
    const dusk = nightAt(new THREE.Vector3(110, 0, 0), C, sun);
    expect(dusk).toBeGreaterThan(0);
    expect(dusk).toBeLessThan(1);
  });

  it('takes the sun away only after it has set, and only inside an atmosphere', () => {
    expect(nightLighting(new THREE.Vector3(10, 100, 0), C, sun, 1).sun).toBe(0);
    expect(nightLighting(new THREE.Vector3(110, 0, 0), C, sun, 1).sun).toBeLessThan(0.5);
    expect(nightLighting(new THREE.Vector3(10, -100, 0), C, sun, 1).sun).toBe(1);
    expect(nightLighting(new THREE.Vector3(10, -100, 0), C, sun, 0).sun).toBe(0);
  });

  it('has its settings on the game look', () => {
    const n = GAME_LOOK.night;
    expect(n.dusk[0]).toBeGreaterThan(n.dusk[1]);
    expect(n.skyFill).toBeGreaterThan(0);
    expect(n.skyFill).toBeLessThan(1);
    // Lamps glow (over the bloom threshold); pools never do.
    expect(n.lamps.intensity).toBeGreaterThan(GAME_LOOK.post.bloom.threshold);
    expect(n.pools.lamp).toBeLessThan(1);
  });
});
