// Which meshes cast and receive the sun's shadow (roadmap Phase 1b).
//
// The one place shadow flags are set. Call `setShadowFlags(root)` wherever
// meshes are created or mounted (Planet does it for terrain, landmarks and
// scatter; Plane for itself). Safe to call again after a remount.
//
// Only solid lit surfaces take part: see-through things (atmosphere shells,
// glow, contrail), unlit things (sun, water shader, stars) and line helpers
// are left alone.
//
// Assets that materialise with the reveal dither (RevealMaterial.js) get a
// depth material with the same dither, keyed to the same uniform, so an
// asset that is not revealed yet casts no shadow and one fading in casts a
// fading shadow.

import * as THREE from 'three';

const isLitSolid = (m) => !!m && !m.transparent && (
  m.isMeshLambertMaterial || m.isMeshStandardMaterial || m.isMeshPhongMaterial || m.isMeshToonMaterial
);

const _revealDepth = new WeakMap();   // reveal uniform → depth material

function revealDepthMaterial(uReveal) {
  let m = _revealDepth.get(uReveal);
  if (m) return m;
  m = new THREE.MeshDepthMaterial();
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uReveal = uReveal;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uReveal;
        float revealHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (uReveal < 1.0 && revealHash(gl_FragCoord.xy) >= uReveal) discard;`);
  };
  // One program for every reveal depth material.
  m.customProgramCacheKey = () => 'planetRevealDepth';
  m.userData.revealDepth = true;
  _revealDepth.set(uReveal, m);
  return m;
}

/**
 * @param {THREE.Object3D} root
 * @param {{ cast?: boolean, receive?: boolean }} [opts]
 */
export function setShadowFlags(root, { cast = true, receive = true } = {}) {
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (!mats.every(isLitSolid)) return;
    o.castShadow = cast;
    o.receiveShadow = receive;
    const reveal = mats.find((m) => m.userData?.revealUniform)?.userData.revealUniform;
    if (reveal) o.customDepthMaterial = revealDepthMaterial(reveal);
    else if (o.customDepthMaterial?.userData?.revealDepth) o.customDepthMaterial = undefined;
  });
}
