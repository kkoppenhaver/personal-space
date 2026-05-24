// Debug overlay for verifying GLB asset placement on planets.
//
// Toggle from DevTools before flying near a planet:
//
//   __GAME.debugPlacement = true
//
// At mount time, applyVisuals checks the flag and (if true) attaches a
// per-instance helper showing:
//   - the local bbox (yellow Box3Helper)
//   - the slot's surface normal (cyan ArrowHelper)
//   - an axes gizmo (R/G/B for X/Y/Z so the asset's local frame is visible)
//
// Run `__GAME.refreshDebugPlacement()` to rebind helpers across all
// currently-mounted planets without flying past them again.

import * as THREE from 'three';

/**
 * @returns {boolean} true if the global debug flag is on
 */
export function isDebugOn() {
  return !!(globalThis.__GAME && globalThis.__GAME.debugPlacement);
}

/**
 * Add debug helpers as children of `instance`. The helpers inherit
 * the instance's transform (scale, rotation, position) automatically.
 * Bounding-box helper is sized in the asset's local space so visually
 * it shows where the GLB's "real" extent sits relative to its origin.
 *
 * @param {THREE.Object3D} instance     - the mounted landmark / hero clone
 * @param {THREE.Vector3} [surfaceNormal] - planet up at the slot; drawn if present
 */
export function attachInstanceHelpers(instance, surfaceNormal = null) {
  if (!instance || instance.userData.__debugAttached) return;
  instance.userData.__debugAttached = true;

  const group = new THREE.Group();
  group.name = '__debugPlacement';

  // 1. Bounding box from userData (local frame). Box3Helper draws in world
  //    units, so adding it as a child of `instance` correctly applies the
  //    instance's scale + rotation + position.
  const bbox = instance.userData?.bbox;
  if (bbox) {
    const box3 = bbox.clone();
    const helper = new THREE.Box3Helper(box3, 0xffff00);
    helper.material.depthTest = false;
    helper.renderOrder = 999;
    group.add(helper);
  }

  // 2. Local axes gizmo (R = X, G = Y, B = Z). Sized to ~half the bbox's
  //    diagonal so it scales with the asset.
  const axisLen = bbox
    ? Math.max(1, bbox.getSize(new THREE.Vector3()).length() * 0.5)
    : 2;
  const axes = new THREE.AxesHelper(axisLen);
  if (axes.material) {
    axes.material.depthTest = false;
    axes.renderOrder = 999;
  }
  group.add(axes);

  instance.add(group);

  // 3. Surface-normal arrow drawn from the instance origin *outward* along
  //    the planet's up at this slot. Attaching to instance means the arrow
  //    inherits the instance's scale; counter-scale to keep the arrow
  //    readable regardless of asset size.
  if (surfaceNormal) {
    const dir = surfaceNormal.clone().normalize();
    // Convert the world-space normal into the instance's local frame so
    // the helper renders along the correct world direction even though
    // it's parented to the rotated instance.
    instance.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(instance.matrixWorld).invert();
    const localDir = dir.clone().transformDirection(inv);
    const arrow = new THREE.ArrowHelper(localDir, new THREE.Vector3(0, 0, 0), 6, 0x00ffff, 1.5, 0.8);
    if (arrow.line?.material)  { arrow.line.material.depthTest = false; arrow.line.renderOrder = 999; }
    if (arrow.cone?.material)  { arrow.cone.material.depthTest = false; arrow.cone.renderOrder = 999; }
    group.add(arrow);
  }
}

/**
 * Remove any previously-attached debug helpers from `instance`. Useful
 * when toggling the flag off mid-session.
 */
export function detachInstanceHelpers(instance) {
  if (!instance?.userData?.__debugAttached) return;
  const toRemove = [];
  instance.traverse((c) => {
    if (c.name === '__debugPlacement') toRemove.push(c);
  });
  for (const node of toRemove) {
    node.parent?.remove(node);
    node.traverse((c) => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    });
  }
  instance.userData.__debugAttached = false;
}
