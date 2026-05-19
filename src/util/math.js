import * as THREE from 'three';

export const TMP_V1 = new THREE.Vector3();
export const TMP_V2 = new THREE.Vector3();
export const TMP_V3 = new THREE.Vector3();
export const TMP_Q1 = new THREE.Quaternion();

export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, t) => {
  const x = clamp((t - a) / (b - a), 0, 1);
  return x * x * (3 - 2 * x);
};

// Critically-damped spring-style position step. dt seconds, halflife seconds.
export function damp(current, target, halflife, dt) {
  const k = 1 - Math.pow(0.5, dt / Math.max(halflife, 1e-5));
  return current + (target - current) * k;
}

export function dampVec3(out, current, target, halflife, dt) {
  const k = 1 - Math.pow(0.5, dt / Math.max(halflife, 1e-5));
  out.x = current.x + (target.x - current.x) * k;
  out.y = current.y + (target.y - current.y) * k;
  out.z = current.z + (target.z - current.z) * k;
  return out;
}

// Convert Rapier vectors to THREE
export function rv(r) { return new THREE.Vector3(r.x, r.y, r.z); }
export function setRV(out, r) { out.set(r.x, r.y, r.z); return out; }
