// Surface shading for a look (roadmap Phase 1b).
//
// Every lit surface in the game is a flat-shaded Lambert material. Under a
// look, each one is swapped for a MeshToonMaterial whose gradient map is the
// look's ramp (Looks.rampTexture), patched with three small extras:
//
//   rim    a warm edge light on the sunward side
//   grain  fibre noise fixed to the surface (card, not film grain)
//   facet  a tiny brightness step per flat face, so each face reads as its
//          own piece of card
//
// The extras are driven by shared uniforms, so switching look is a uniform
// write plus a texture swap: no recompile, and one program for everything.
//
// The game's material stays on `mesh.userData.lookBase`; `applyLook` with a
// look that has no ramp puts it back.

import * as THREE from 'three';
import { rampTexture } from './Looks.js';

const UNIFORMS = {
  uLookRimColor: { value: new THREE.Color(0xffffff) },
  uLookRim: { value: new THREE.Vector2(0, 3) },     // strength, power
  uLookGrain: { value: 0 },
  uLookFacet: { value: 0 },
};

const VERT_PARS = /* glsl */`
varying vec3 vLookPos;
`;

// World position of the vertex (instanced scatter included).
const VERT_MAIN = /* glsl */`
{
  vec4 lookPos = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    lookPos = instanceMatrix * lookPos;
  #endif
  vLookPos = ( modelMatrix * lookPos ).xyz;
}
`;

const FRAG_PARS = /* glsl */`
varying vec3 vLookPos;
uniform vec3 uLookRimColor;
uniform vec2 uLookRim;
uniform float uLookGrain;
uniform float uLookFacet;

float lookHash( vec3 p ) {
  p = fract( p * 0.3183099 + 0.1 );
  p *= 17.0;
  return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}
float lookNoise( vec3 p ) {
  vec3 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( mix( lookHash( i ), lookHash( i + vec3( 1, 0, 0 ) ), f.x ),
         mix( lookHash( i + vec3( 0, 1, 0 ) ), lookHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
    mix( mix( lookHash( i + vec3( 0, 0, 1 ) ), lookHash( i + vec3( 1, 0, 1 ) ), f.x ),
         mix( lookHash( i + vec3( 0, 1, 1 ) ), lookHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ),
    f.z );
}
`;

// Runs just before the colour is written. `normal` is the view-space face
// normal, `outgoingLight` the lit colour, `diffuseColor` the albedo.
const FRAG_MAIN = /* glsl */`
{
  // Card grain: a fine speckle plus longer fibres, fixed in world space.
  if ( uLookGrain > 0.0 ) {
    float fine = lookNoise( vLookPos * 5.5 );
    float fibre = lookNoise( vec3( vLookPos.x * 11.0, vLookPos.y * 0.9, vLookPos.z * 11.0 ) );
    outgoingLight *= 1.0 + ( fine * 0.6 + fibre * 0.4 - 0.5 ) * 2.0 * uLookGrain;
  }
  // One brightness step per flat face.
  if ( uLookFacet > 0.0 ) {
    vec3 faceN = normalize( cross( dFdx( vLookPos ), dFdy( vLookPos ) ) );
    float step_ = lookHash( floor( faceN * 9.0 + 0.5 ) + 3.7 );
    outgoingLight *= 1.0 + ( step_ - 0.5 ) * 2.0 * uLookFacet;
  }
  // Rim: light catching the edges that face the sun.
  #if NUM_DIR_LIGHTS > 0
  if ( uLookRim.x > 0.0 ) {
    float edge = pow( 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) ), uLookRim.y );
    float sunward = smoothstep( -0.25, 0.55, dot( normal, directionalLights[ 0 ].direction ) );
    outgoingLight += diffuseColor.rgb * uLookRimColor * ( edge * sunward * uLookRim.x );
  }
  #endif
}
`;

function patch(material) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, UNIFORMS);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <opaque_fragment>', `${FRAG_MAIN}\n#include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => 'look-surface-1';
}

function lookMaterialFor(base) {
  let m = base.userData.lookMaterial;
  if (m) return m;
  m = new THREE.MeshToonMaterial({
    color: base.color,
    vertexColors: base.vertexColors,
    side: base.side,
    transparent: base.transparent,
    opacity: base.opacity,
  });
  m.flatShading = true;   // read by the renderer; not a declared toon property
  m.name = base.name;
  m.userData.lookBase = base;
  patch(m);
  base.userData.lookMaterial = m;
  return m;
}

const isBase = (m) => m?.isMeshLambertMaterial === true;

/**
 * Put every lit mesh under `root` into `look`.
 * Safe to call again with another look, or after new meshes mount.
 *
 * @param {THREE.Object3D} root
 * @param {object} look  a Looks.js preset
 */
export function applyLook(root, look) {
  const shaded = !!look.ramp;
  const ramp = shaded ? rampTexture(look) : null;
  const shadows = !!look.shadow;

  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const swap = (m) => {
      const base = m.userData?.lookBase || m;
      if (!isBase(base)) return m;          // water, sky, dynamic assets: untouched
      if (!shaded) return base;
      const lm = lookMaterialFor(base);
      if (lm.gradientMap !== ramp) {
        // A texture where there was none changes the program; a different
        // texture does not.
        if (!lm.gradientMap) lm.needsUpdate = true;
        lm.gradientMap = ramp;
      }
      return lm;
    };
    const before = o.material;
    o.material = Array.isArray(before) ? before.map(swap) : swap(before);
    const lit = (Array.isArray(o.material) ? o.material : [o.material])
      .some((m) => m.isMeshToonMaterial || m.isMeshLambertMaterial);
    if (lit) {
      o.castShadow = shadows;
      o.receiveShadow = shadows;
    }
  });

  const s = look.surface;
  UNIFORMS.uLookRimColor.value.set(s?.rim?.color ?? 0xffffff);
  UNIFORMS.uLookRim.value.set(s?.rim?.strength ?? 0, s?.rim?.power ?? 3);
  UNIFORMS.uLookGrain.value = s?.grain ?? 0;
  UNIFORMS.uLookFacet.value = s?.facet ?? 0;
}
