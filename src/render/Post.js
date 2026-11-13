// The finishing pipeline (roadmap Phase 1b): what happens to a frame after
// the scene is drawn. A look (Looks.js `post`) switches the stages on and
// sets their strengths.
//
//   scene (HDR, 4× MSAA)
//   → contact shading (GTAO)                    look.post.ao
//   → bloom on the brightest parts              look.post.bloom
//   → scene effects, in linear light:
//       drawn outlines from depth + normals     look.post.outline
//       tilt-shift blur above and below a band  look.post.tiltShift
//   → tone mapping + sRGB (three's OutputPass)  look.post.toneMapping
//   → page effects, on the finished picture:
//       saturation, contrast, lifted blacks, hatching in the darks,
//       paper grain, vignette

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';

const FULLSCREEN_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

// Patterns are sized in "720p pixels" so they look the same on any screen.
const REF_HEIGHT = 720;

const SceneFx = {
  uniforms: {
    tDiffuse: { value: null },
    tNormal: { value: null },
    tDepth: { value: null },
    uTexel: { value: new THREE.Vector2(1, 1) },
    uAspect: { value: 1 },
    uNearFar: { value: new THREE.Vector2(0.1, 5000) },
    uOutline: { value: new THREE.Vector4(0, 0.01, 0.42, 0.6) },   // thickness px (0 = off), depth step, normal step, wobble
    uInk: { value: new THREE.Color(0x000000) },
    uOutlineFullAt: { value: 60 },                                 // metres: lines are full strength up to here, lighter beyond
    uTilt: { value: new THREE.Vector3(0, 0.5, 0.16) },            // blur radius px (0 = off), focus height, sharp half-band
  },
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: /* glsl */`
    #include <packing>
    uniform sampler2D tDiffuse, tNormal, tDepth;
    uniform vec2 uTexel, uNearFar;
    uniform float uAspect;
    uniform vec4 uOutline;
    uniform vec3 uInk, uTilt;
    uniform float uOutlineFullAt;
    varying vec2 vUv;

    float hash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
    float vnoise( vec2 p ) {
      vec2 i = floor( p ), f = fract( p );
      f = f * f * ( 3.0 - 2.0 * f );
      return mix( mix( hash( i ), hash( i + vec2( 1, 0 ) ), f.x ), mix( hash( i + vec2( 0, 1 ) ), hash( i + vec2( 1, 1 ) ), f.x ), f.y );
    }
    float depthAt( vec2 uv ) { return -perspectiveDepthToViewZ( texture2D( tDepth, uv ).x, uNearFar.x, uNearFar.y ); }
    vec3 normalAt( vec2 uv ) { return texture2D( tNormal, uv ).xyz * 2.0 - 1.0; }

    void main() {
      vec3 col = texture2D( tDiffuse, vUv ).rgb;

      // Tilt-shift: sharp in a band, blurred more the further above or below.
      float blur = smoothstep( uTilt.z, uTilt.z + 0.34, abs( vUv.y - uTilt.y ) ) * uTilt.x;
      if ( blur > 0.3 ) {
        vec3 acc = col;
        for ( int i = 0; i < 24; i ++ ) {
          float a = float( i ) * 2.39996323;
          float r = sqrt( ( float( i ) + 0.5 ) / 24.0 ) * blur;
          acc += texture2D( tDiffuse, vUv + vec2( cos( a ), sin( a ) ) * r * uTexel ).rgb;
        }
        col = acc / 25.0;
      }

      // Outline: a line wherever depth or surface direction jumps.
      if ( uOutline.x > 0.0 ) {
        vec2 grid = vUv * vec2( uAspect, 1.0 ) * ${REF_HEIGHT.toFixed(1)};
        vec2 wob = ( vec2( vnoise( grid / 13.0 ), vnoise( grid / 13.0 + 31.7 ) ) - 0.5 ) * 2.0 * uOutline.w * uTexel;
        vec2 uv = vUv + wob;
        float z = depthAt( uv );
        // Far away, a line is as wide as the thing it outlines: thin and
        // lighten lines with distance so detail does not clot into black.
        float near = clamp( uOutlineFullAt / z, 0.0, 1.0 );
        vec2 o = uTexel * uOutline.x * mix( 0.6, 1.0, near );
        float za = depthAt( uv + o ), zb = depthAt( uv - o );
        float zc = depthAt( uv + vec2( -o.x, o.y ) ), zd = depthAt( uv + vec2( o.x, -o.y ) );
        vec3 n = normalAt( uv );
        // A surface seen edge-on changes depth quickly without being an
        // edge: scale the step by how much it faces the camera.
        float facing = clamp( n.z, 0.2, 1.0 );
        float dz = ( abs( za - zb ) + abs( zc - zd ) ) / max( min( z, min( min( za, zb ), min( zc, zd ) ) ), 0.001 ) * facing;
        float depthEdge = smoothstep( uOutline.y, uOutline.y * 2.5, dz );
        float dn = length( normalAt( uv + o ) - normalAt( uv - o ) )
                 + length( normalAt( uv + vec2( -o.x, o.y ) ) - normalAt( uv + vec2( o.x, -o.y ) ) );
        float normalEdge = smoothstep( uOutline.z, uOutline.z * 1.7, dn );
        col = mix( col, uInk, max( depthEdge * mix( 0.5, 1.0, near ), normalEdge * near * near ) * 0.92 );
      }

      // Alpha marks "something was drawn here" for the page effects. Only
      // known when the outline pass has supplied depth.
      float drawn = uOutline.x > 0.0 ? step( depthAt( vUv ), uNearFar.y * 0.95 ) : 1.0;
      gl_FragColor = vec4( col, drawn );
    }
  `,
};

const PageFx = {
  uniforms: {
    tDiffuse: { value: null },
    uAspect: { value: 1 },
    uSaturation: { value: 1 },
    uContrast: { value: 1 },
    uLift: { value: new THREE.Vector4(0, 0, 0, 0) },   // display-space colour, amount
    uHatch: { value: 0 },
    uGrain: { value: 0 },
    uVignette: { value: 0 },
  },
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uAspect, uSaturation, uContrast, uHatch, uGrain, uVignette;
    uniform vec4 uLift;
    varying vec2 vUv;

    float hash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
    float vnoise( vec2 p ) {
      vec2 i = floor( p ), f = fract( p );
      f = f * f * ( 3.0 - 2.0 * f );
      return mix( mix( hash( i ), hash( i + vec2( 1, 0 ) ), f.x ), mix( hash( i + vec2( 0, 1 ) ), hash( i + vec2( 1, 1 ) ), f.x ), f.y );
    }

    void main() {
      // Already tone-mapped and sRGB-encoded: these are picture values.
      vec4 texel = texture2D( tDiffuse, vUv );
      vec3 col = texel.rgb;
      vec2 grid = vUv * vec2( uAspect, 1.0 ) * ${REF_HEIGHT.toFixed(1)};

      float luma = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
      col = mix( vec3( luma ), col, uSaturation );
      col = ( col - 0.5 ) * uContrast + 0.5;

      // Hatching: thin diagonal strokes in the darkest tone.
      if ( uHatch > 0.0 ) {
        float stroke = abs( fract( ( grid.x + grid.y ) / 6.0 + vnoise( grid / 40.0 ) * 0.6 ) - 0.5 ) * 2.0;
        float inDark = smoothstep( 0.40, 0.24, luma );
        col *= 1.0 - smoothstep( 0.30, 0.12, stroke ) * inDark * uHatch * 0.45 * texel.a;   // not on empty space
      }

      // Lifted blacks: the darkest tone is a colour, never pure black.
      vec3 screened = 1.0 - ( 1.0 - col ) * ( 1.0 - uLift.rgb );
      col = mix( col, screened, uLift.a );

      // Paper: fine tooth, soft mottle, long horizontal fibres. Static.
      if ( uGrain > 0.0 ) {
        float tooth = vnoise( grid * 0.9 ) * 0.5 + vnoise( grid * 0.27 ) * 0.3
                    + vnoise( vec2( grid.x * 0.05, grid.y * 0.8 ) ) * 0.2;
        col *= 1.0 + ( tooth - 0.5 ) * 2.0 * uGrain;
      }

      vec2 q = ( vUv - 0.5 ) * vec2( uAspect, 1.0 );
      col *= 1.0 - uVignette * smoothstep( 0.35, 1.05, length( q ) * 1.15 );

      gl_FragColor = vec4( clamp( col, 0.0, 1.0 ), 1.0 );
    }
  `,
};

const hexToVec = (hex) => [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255];

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {THREE.PerspectiveCamera} camera
 */
export function createPost(renderer, scene, camera) {
  const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);

  const renderPass = new RenderPass(scene, camera);
  const ao = new GTAOPass(scene, camera, 4, 4);
  const bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), 0.2, 0.5, 1.0);
  const sceneFx = new ShaderPass(SceneFx);
  const output = new OutputPass();
  const pageFx = new ShaderPass(PageFx);
  for (const p of [renderPass, ao, bloom, sceneFx, output, pageFx]) composer.addPass(p);

  // Normals + depth for the outline, drawn only when a look asks for it.
  const edgeTarget = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
  edgeTarget.depthTexture = new THREE.DepthTexture(4, 4);
  const normalMaterial = new THREE.MeshNormalMaterial({ flatShading: true });
  const _clear = new THREE.Color();

  let look = null;
  let photo = false;
  let height = REF_HEIGHT;

  function syncTilt() {
    const amount = photo ? (look?.post?.tiltShift ?? 0) : 0;
    sceneFx.uniforms.uTilt.value.set(amount * 7 * (height / REF_HEIGHT), 0.5, 0.17);
  }

  return {
    composer,

    setLook(next) {
      look = next;
      const p = look.post;
      if (!p) return;
      renderer.toneMapping = p.toneMapping;
      renderer.toneMappingExposure = p.exposure;

      ao.enabled = !!p.ao;
      if (p.ao) {
        ao.updateGtaoMaterial({ radius: p.ao.radius, distanceExponent: 1, thickness: 1, scale: 1, samples: 16 });
        ao.blendIntensity = p.ao.intensity;
      }
      bloom.enabled = !!p.bloom;
      if (p.bloom) { bloom.strength = p.bloom.strength; bloom.radius = p.bloom.radius; bloom.threshold = p.bloom.threshold; }

      const o = p.outline;
      sceneFx.uniforms.uOutline.value.set(o ? o.thickness * (height / REF_HEIGHT) : 0, o?.depth ?? 0.01, o?.normal ?? 0.42, o?.wobble ?? 0);
      if (o) { sceneFx.uniforms.uInk.value.set(o.color); sceneFx.uniforms.uOutlineFullAt.value = o.fullAt ?? 60; }
      syncTilt();

      pageFx.uniforms.uSaturation.value = p.saturation ?? 1;
      pageFx.uniforms.uContrast.value = p.contrast ?? 1;
      pageFx.uniforms.uLift.value.set(...(p.lift ? hexToVec(p.lift.color) : [0, 0, 0]), p.lift?.amount ?? 0);
      pageFx.uniforms.uHatch.value = p.hatch ?? 0;
      pageFx.uniforms.uGrain.value = p.grain ?? 0;
      pageFx.uniforms.uVignette.value = p.vignette ?? 0;
    },

    /** Photo framing turns the look's tilt-shift on. */
    setPhoto(on) { photo = !!on; syncTilt(); },

    /** Size in device pixels. */
    setSize(w, h) {
      height = h;
      composer.setSize(w, h);
      edgeTarget.setSize(w, h);
      sceneFx.uniforms.uTexel.value.set(1 / w, 1 / h);
      sceneFx.uniforms.uAspect.value = w / h;
      pageFx.uniforms.uAspect.value = w / h;
      if (look) this.setLook(look);
    },

    render() {
      const p = look?.post;
      if (!p) { renderer.render(scene, camera); return; }
      if (p.outline) {
        const prevOverride = scene.overrideMaterial;
        const prevBackground = scene.background;
        const prevTarget = renderer.getRenderTarget();
        renderer.getClearColor(_clear);
        const prevAlpha = renderer.getClearAlpha();
        const prevShadows = renderer.shadowMap.autoUpdate;
        scene.overrideMaterial = normalMaterial;
        scene.background = null;
        renderer.shadowMap.autoUpdate = false;
        renderer.setClearColor(0x8080ff, 1);
        renderer.setRenderTarget(edgeTarget);
        renderer.clear();
        renderer.render(scene, camera);
        renderer.setRenderTarget(prevTarget);
        renderer.setClearColor(_clear, prevAlpha);
        renderer.shadowMap.autoUpdate = prevShadows;
        scene.overrideMaterial = prevOverride;
        scene.background = prevBackground;
        sceneFx.uniforms.tNormal.value = edgeTarget.texture;
        sceneFx.uniforms.tDepth.value = edgeTarget.depthTexture;
        sceneFx.uniforms.uNearFar.value.set(camera.near, camera.far);
      }
      composer.render();
    },

    dispose() {
      target.dispose();
      edgeTarget.dispose();
      normalMaterial.dispose();
    },
  };
}
