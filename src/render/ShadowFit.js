// Where the sun's one shadow map goes (roadmap Phase 1b). Pure math, no
// renderer: unit-tested in tests/unit/shadow-fit.test.js.
//
// Planets are 80–240 m across and one 2048 map boxed on a whole planet is
// too coarse up close, so the game fits the box to what the camera sees:
//
//   viewFit      where to centre the box and how big to make it, from the
//                camera's height over the planet: a small box over the
//                ground ahead when low, growing with altitude, the whole
//                planet from far out.
//   shadowBox    the light's orthographic camera for that box, with its
//                centre snapped to whole shadow texels in light space so
//                shadows do not shimmer as the camera moves.
//
// Everything is measured from the planet centre. A floating-origin rebase
// moves the planet, the camera and the box together, so the snapped grid
// stays on the same ground and shadows do not jump.

import * as THREE from 'three';

/** Box half-sizes come in steps of this ratio (so the texel size changes rarely). */
export const HALF_STEP = 1.25;
/** Smallest box half-size, metres. */
export const HALF_MIN = 40;
/** Room above the surface for casters: tall models, and the plane up to the atmosphere top. */
export const CASTER_HEADROOM = 170;

const _off = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The whole-planet half-size: the disc plus tall models on its limb (the look lab's box). */
export function planetHalf(radius) {
  return radius * 1.4;
}

/**
 * Quantise a wanted half-size to the step ladder, with hysteresis: keep the
 * previous step unless the wanted size has left it by a clear margin, so
 * hovering at one altitude never flips between two box sizes.
 *
 * @param {number} want      wanted half-size (m)
 * @param {number} cap       largest half-size (the whole planet)
 * @param {number|null} prev previously chosen half-size, or null
 */
export function quantiseHalf(want, cap, prev = null) {
  const level = (h) => Math.max(0, Math.ceil(Math.log(h / HALF_MIN) / Math.log(HALF_STEP) - 1e-9));
  const sizeOf = (k) => Math.min(cap, HALF_MIN * Math.pow(HALF_STEP, k));
  const w = Math.min(cap, Math.max(HALF_MIN, want));
  if (prev != null && prev > 0) {
    // Still fits in the previous box, and not so small that a box two
    // steps down would do: keep it.
    if (w <= prev && w > prev / (HALF_STEP * HALF_STEP)) return prev;
  }
  return sizeOf(level(w));
}

/**
 * Where to centre the shadow box and how big to make it.
 *
 * @param {object} p
 * @param {THREE.Vector3} p.planetCenter
 * @param {number} p.radius             planet radius (m)
 * @param {THREE.Vector3} p.cameraPos
 * @param {THREE.Vector3} p.cameraDir   unit view direction
 * @param {number|null} [p.prevHalf]    last frame's half-size (hysteresis)
 * @returns {{ focus: THREE.Vector3, half: number }}
 */
export function viewFit({ planetCenter, radius, cameraPos, cameraDir, prevHalf = null }) {
  _off.copy(cameraPos).sub(planetCenter);
  const dist = Math.max(1e-6, _off.length());
  const up = _off.divideScalar(dist);                 // unit radial up at the camera
  const alt = Math.max(0, dist - radius);
  const cap = planetHalf(radius);

  // Low: a box that covers the ground in view, growing with height.
  const half = quantiseHalf(48 + alt * 1.1, cap, prevHalf);

  // Centre: the ground a little ahead of the camera (it looks forward, and
  // sees more ground in front than behind) …
  _fwd.copy(cameraDir).addScaledVector(up, -cameraDir.dot(up));
  const fl = _fwd.length();
  if (fl > 1e-4) _fwd.multiplyScalar(1 / fl); else _fwd.set(0, 0, 0);
  const ground = new THREE.Vector3().copy(up).multiplyScalar(radius).addScaledVector(_fwd, half * 0.4);
  ground.setLength(radius);
  // … sliding to the planet centre from far out, where the box is the
  // whole planet.
  const far = smoothstep(radius * 0.5, radius * 2, alt);
  const focus = ground.multiplyScalar(1 - far).add(planetCenter);
  return { focus, half };
}

/**
 * The stable "up" for the light camera: anything not parallel to the sun.
 * Changes only if the sun swings past the pole, which it never does for
 * one planet.
 */
export function lightUp(sunDir, out = new THREE.Vector3()) {
  return Math.abs(sunDir.y) < 0.99 ? out.set(0, 1, 0) : out.set(1, 0, 0);
}

/**
 * The light's orthographic shadow camera around a box.
 *
 * @param {object} p
 * @param {THREE.Vector3} p.planetCenter
 * @param {number} p.radius
 * @param {THREE.Vector3} p.sunDir    unit, from the planet toward the sun
 * @param {THREE.Vector3} p.focus     box centre (world)
 * @param {number} p.half             box half-size (m)
 * @param {number} p.mapSize          shadow map size (texels)
 * @returns {{ position: THREE.Vector3, target: THREE.Vector3, up: THREE.Vector3,
 *             half: number, near: number, far: number, texel: number }}
 */
export function shadowBox({ planetCenter, radius, sunDir, focus, half, mapSize }) {
  // Light-camera basis, built exactly as Object3D.lookAt builds it for a
  // camera at `target + sunDir·k` looking at `target`.
  const up = lightUp(sunDir);
  const z = sunDir;
  _x.crossVectors(up, z).normalize();
  _y.crossVectors(z, _x);

  // Snap the centre to whole texels, measured from the planet centre.
  const texel = (2 * half) / mapSize;
  _off.copy(focus).sub(planetCenter);
  const a = Math.round(_off.dot(_x) / texel) * texel;
  const b = Math.round(_off.dot(_y) / texel) * texel;
  const c = _off.dot(z);
  const target = new THREE.Vector3().copy(planetCenter)
    .addScaledVector(_x, a).addScaledVector(_y, b).addScaledVector(z, c);

  // Depth: every caster within the planet's bounds (surface, tall models,
  // the plane up to the atmosphere top), on the sun side and behind.
  const bound = radius + CASTER_HEADROOM;
  const lead = bound - c + 1;           // from the target to just past the sunward edge
  const position = new THREE.Vector3().copy(target).addScaledVector(z, lead);
  return { position, target, up: up.clone(), half, near: 0, far: 2 * bound + 2, texel };
}
