// The finishing pipeline (roadmap Phase 1b): what happens to a frame after
// the scene is drawn. A look (Looks.js `post`) sets the strengths; the
// quality tier (Quality.js) switches the costly stages off.
//
//   scene (HDR half-float, MSAA)
//   → contact shading (GTAO)                    look.post.ao      tier.ao
//   → bloom on the brightest parts              look.post.bloom   tier.bloom
//   → tone mapping + sRGB (three's OutputPass, from renderer.toneMapping)
//   → page: saturation, contrast, vignette, on the finished picture
//
// Colour: everything up to OutputPass is linear light. Materials are not
// tone-mapped when drawn into a render target, so OutputPass does it once.
// Use `scene.background` (a THREE.Color) for the clear colour, never
// `renderer.setClearColor`: the renderer converts a clear colour for the
// target current when it is set, and the HDR buffer wants linear values.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';

const FULLSCREEN_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const PageFx = {
  uniforms: {
    tDiffuse: { value: null },
    uAspect: { value: 1 },
    uSaturation: { value: 1 },
    uContrast: { value: 1 },
    uVignette: { value: 0 },
  },
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uAspect, uSaturation, uContrast, uVignette;
    varying vec2 vUv;

    void main() {
      // Already tone-mapped and sRGB-encoded: these are picture values.
      vec3 col = texture2D( tDiffuse, vUv ).rgb;
      float luma = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
      col = mix( vec3( luma ), col, uSaturation );
      col = ( col - 0.5 ) * uContrast + 0.5;
      vec2 q = ( vUv - 0.5 ) * vec2( uAspect, 1.0 );
      col *= 1.0 - uVignette * smoothstep( 0.35, 1.05, length( q ) * 1.15 );
      gl_FragColor = vec4( clamp( col, 0.0, 1.0 ), 1.0 );
    }
  `,
};

/**
 * GTAO draws its own normal + depth prepass with an override material, so
 * anything see-through would write into it as if it were solid ground: the
 * atmosphere shells, the sun's glow, the contrail, motes. Hide those for the
 * prepass, plus assets still materialising (the override material has no
 * reveal dither), and draw it with no background.
 */
const isSeeThrough = (m) => !m || m.transparent || m.blending === THREE.AdditiveBlending
  || (m.userData?.revealUniform && m.userData.revealUniform.value < 1);

class SolidOnlyGTAOPass extends GTAOPass {
  _overrideVisibility() {
    super._overrideVisibility();
    const cache = this._visibilityCache;
    this.scene.traverse((o) => {
      if (!o.visible) return;
      if (o.isSprite || o.userData?.noAO
        || (o.isMesh && (Array.isArray(o.material) ? o.material.some(isSeeThrough) : isSeeThrough(o.material)))) {
        o.visible = false;
        cache.push(o);
      }
    });
    this._savedBackground = this.scene.background;
    this.scene.background = null;
  }

  _restoreVisibility() {
    super._restoreVisibility();
    this.scene.background = this._savedBackground;
    this._savedBackground = null;
  }
}

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {THREE.PerspectiveCamera} camera
 */
export function createPost(renderer, scene, camera) {
  const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  // Sizes are always given in device pixels.
  composer.setPixelRatio(1);

  const renderPass = new RenderPass(scene, camera);
  const ao = new SolidOnlyGTAOPass(scene, camera, 4, 4);
  const bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), 0.2, 0.5, 1.0);
  const output = new OutputPass();
  const pageFx = new ShaderPass(PageFx);
  for (const p of [renderPass, ao, bloom, output, pageFx]) composer.addPass(p);

  const copy = new FullScreenQuad(new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
    vertexShader: CopyShader.vertexShader,
    fragmentShader: CopyShader.fragmentShader,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  }));

  let look = null;
  let tier = { ao: true, bloom: true, msaa: 4 };
  let neutral = false;

  function sync() {
    const p = look?.post;
    if (!p) return;
    renderer.toneMapping = p.toneMapping;
    renderer.toneMappingExposure = p.exposure;
    ao.enabled = !!p.ao && tier.ao;
    if (p.ao) {
      ao.updateGtaoMaterial({ radius: p.ao.radius, distanceExponent: 1, thickness: 1, scale: 1, samples: 16 });
      ao.blendIntensity = p.ao.intensity;
    }
    bloom.enabled = !!p.bloom && tier.bloom;
    if (p.bloom) { bloom.strength = p.bloom.strength; bloom.radius = p.bloom.radius; bloom.threshold = p.bloom.threshold; }
    pageFx.uniforms.uSaturation.value = neutral ? 1 : (p.saturation ?? 1);
    pageFx.uniforms.uContrast.value = neutral ? 1 : (p.contrast ?? 1);
    pageFx.uniforms.uVignette.value = neutral ? 0 : (p.vignette ?? 0);
  }

  return {
    composer,

    /** True when the look has a finishing pass at all. */
    get active() { return !!look?.post; },

    setLook(next) {
      look = next;
      if (!look.post) {
        renderer.toneMapping = THREE.NoToneMapping;
        renderer.toneMappingExposure = 1;
      }
      sync();
    },

    /**
     * Which stages the quality tier can afford.
     * @param {{ ao: boolean, bloom: boolean, msaa: number, page?: boolean }} t
     *   `page: false` drops saturation/contrast/vignette (keeps a capture in
     *   line with the `low` tier's screen, which has no composer).
     */
    setQuality(t) {
      tier = { ...tier, ...t };
      neutral = t.page === false;
      const samples = tier.msaa | 0;
      for (const rt of [composer.renderTarget1, composer.renderTarget2]) {
        if (rt.samples !== samples) { rt.samples = samples; rt.dispose(); }
      }
      sync();
    },

    /** Draw another scene or camera (the terrain lab's cells, the thumbnail camera). */
    setView(nextScene, nextCamera) {
      renderPass.scene = nextScene; renderPass.camera = nextCamera;
      ao.scene = nextScene; ao.camera = nextCamera;
    },

    /** Size in device pixels. */
    setSize(w, h) {
      composer.setSize(w, h);
      pageFx.uniforms.uAspect.value = w / h;
    },

    render() {
      if (!look?.post) { renderer.render(renderPass.scene, renderPass.camera); return; }
      composer.render();
    },

    /**
     * Draw the finished picture into `rt` instead of the screen. `rt` holds
     * display values (tone-mapped, sRGB) as plain bytes: give it
     * NoColorSpace so nothing converts them again.
     */
    renderToTarget(rt) {
      composer.renderToScreen = false;
      try {
        composer.render();
      } finally {
        composer.renderToScreen = true;
      }
      const prev = renderer.getRenderTarget();
      copy.material.uniforms.tDiffuse.value = composer.readBuffer.texture;
      renderer.setRenderTarget(rt);
      copy.render(renderer);
      renderer.setRenderTarget(prev);
    },

    /**
     * Compile the scene's programs for the HDR buffer (the variant the
     * composer draws with), not for the screen.
     */
    compileAsync() {
      if (!renderer.compileAsync) return Promise.resolve();
      const prev = renderer.getRenderTarget();
      if (look?.post) renderer.setRenderTarget(composer.renderTarget1);
      try {
        return renderer.compileAsync(renderPass.scene, renderPass.camera);
      } finally {
        renderer.setRenderTarget(prev);
      }
    },

    dispose() {
      composer.dispose();
      ao.dispose();
      bloom.dispose();
      output.dispose();
      pageFx.dispose();
      copy.material.dispose();
      copy.dispose();
    },
  };
}
