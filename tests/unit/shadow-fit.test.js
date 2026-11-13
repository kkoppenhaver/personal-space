import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { viewFit, shadowBox, quantiseHalf, planetHalf, lightUp, HALF_MIN, HALF_STEP } from '../../src/render/ShadowFit.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const SUN = V(0.6, 0.5, 0.62).normalize();
const MAP = 2048;

// Light-space x/y of a world point, in the basis the light camera uses.
function lightXY(p, center) {
  const z = SUN;
  const x = new THREE.Vector3().crossVectors(lightUp(SUN), z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  const o = p.clone().sub(center);
  return [o.dot(x), o.dot(y)];
}

describe('quantiseHalf', () => {
  it('rounds up to the step ladder, capped at the whole planet', () => {
    expect(quantiseHalf(10, 200)).toBe(HALF_MIN);
    expect(quantiseHalf(HALF_MIN, 200)).toBe(HALF_MIN);
    expect(quantiseHalf(HALF_MIN + 1, 200)).toBeCloseTo(HALF_MIN * HALF_STEP, 9);
    expect(quantiseHalf(1e6, 140)).toBe(140);
  });

  it('holds its size while the wanted size wobbles (hysteresis)', () => {
    let h = quantiseHalf(61, 500);
    const start = h;
    for (const w of [59, 62, 55, 62.4, 50, 61]) {
      h = quantiseHalf(w, 500, h);
      expect(h).toBe(start);
    }
    // Clearly bigger: grows. Clearly smaller: shrinks.
    expect(quantiseHalf(start * 1.1, 500, start)).toBeGreaterThan(start);
    expect(quantiseHalf(start / 2, 500, start)).toBeLessThan(start);
  });
});

describe('viewFit', () => {
  const center = V(100, -50, 30);
  const R = 100;

  it('a small box over the ground near the camera when low, the whole planet from far out', () => {
    const low = viewFit({ planetCenter: center, radius: R, cameraPos: center.clone().add(V(0, R + 10, 0)), cameraDir: V(0, 0, -1) });
    expect(low.half).toBeLessThan(80);
    expect(low.focus.distanceTo(center)).toBeCloseTo(R, 3);         // on the surface
    expect(low.focus.z - center.z).toBeLessThan(0);                // pushed ahead of the camera

    const far = viewFit({ planetCenter: center, radius: R, cameraPos: center.clone().add(V(0, R * 4, 0)), cameraDir: V(0, -1, 0) });
    expect(far.half).toBeCloseTo(planetHalf(R), 6);
    expect(far.focus.distanceTo(center)).toBeLessThan(1e-6);
  });

  it('grows with altitude', () => {
    let prev = 0;
    for (const alt of [0, 20, 60, 120, 200]) {
      const { half } = viewFit({ planetCenter: center, radius: R, cameraPos: center.clone().add(V(R + alt, 0, 0)), cameraDir: V(0, 1, 0) });
      expect(half).toBeGreaterThanOrEqual(prev);
      prev = half;
    }
  });
});

describe('shadowBox', () => {
  const center = V(-1234.5, 87.25, 4021.75);
  const R = 120;

  it('snaps the box centre to whole texels, measured from the planet centre', () => {
    const half = 60;
    const texel = (2 * half) / MAP;
    for (let i = 0; i < 20; i++) {
      const focus = center.clone().add(V(R * 0.3 + i * 0.0137, R * 0.9, i * 0.021).setLength(R));
      const box = shadowBox({ planetCenter: center, radius: R, sunDir: SUN, focus, half, mapSize: MAP });
      const [a, b] = lightXY(box.target, center);
      expect(Math.abs(a / texel - Math.round(a / texel))).toBeLessThan(1e-3);
      expect(Math.abs(b / texel - Math.round(b / texel))).toBeLessThan(1e-3);
      expect(box.texel).toBeCloseTo(texel, 12);
    }
  });

  it('a small camera move moves the box by whole texels or not at all', () => {
    const half = 60;
    const texel = (2 * half) / MAP;
    const f0 = center.clone().add(V(0, R, 0));
    const b0 = shadowBox({ planetCenter: center, radius: R, sunDir: SUN, focus: f0, half, mapSize: MAP });
    const b1 = shadowBox({ planetCenter: center, radius: R, sunDir: SUN, focus: f0.clone().add(V(0.004, 0, 0.003)), half, mapSize: MAP });
    const [a0, c0] = lightXY(b0.target, center);
    const [a1, c1] = lightXY(b1.target, center);
    for (const d of [a1 - a0, c1 - c0]) expect(Math.abs(d / texel - Math.round(d / texel))).toBeLessThan(1e-3);
  });

  it('a floating-origin rebase moves the box with the world (no jump)', () => {
    const half = 75;
    const focus = center.clone().add(V(10, R, -5).setLength(R));
    const before = shadowBox({ planetCenter: center, radius: R, sunDir: SUN, focus, half, mapSize: MAP });
    const shift = V(-4321.123, 17.5, -987.654);
    const after = shadowBox({ planetCenter: center.clone().add(shift), radius: R, sunDir: SUN, focus: focus.clone().add(shift), half, mapSize: MAP });
    expect(after.target.clone().sub(shift).distanceTo(before.target)).toBeLessThan(1e-6 * 5000);
    expect(after.position.clone().sub(shift).distanceTo(before.position)).toBeLessThan(1e-6 * 5000);
  });

  it('puts the light on the sun side and the whole planet (plus headroom) inside the depth range', () => {
    const focus = center.clone().add(SUN.clone().multiplyScalar(R));
    const box = shadowBox({ planetCenter: center, radius: R, sunDir: SUN, focus, half: 60, mapSize: MAP });
    const toLight = box.position.clone().sub(box.target).normalize();
    expect(toLight.dot(SUN)).toBeCloseTo(1, 9);
    // Depth of the planet's sunward and far edges, from the light.
    const d = (p) => box.position.clone().sub(p).dot(SUN);
    const nearEdge = d(center.clone().addScaledVector(SUN, R + 150));
    const farEdge = d(center.clone().addScaledVector(SUN, -(R + 150)));
    expect(nearEdge).toBeGreaterThan(box.near);
    expect(farEdge).toBeLessThan(box.far);
  });
});
