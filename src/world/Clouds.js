import * as THREE from 'three';
import { SKY_SETTINGS } from './Atmosphere.js';
import { TUNING } from '../game/Tuning.js';
import { bakeCloudField, cloudCover, cloudForm } from './CloudStyle.js';

// One cloud shell per planet (roadmap 1c): a sphere a little above the
// ground, one draw, transparent. Its pattern is a noise field baked once per
// planet into a small texture (CloudStyle.js: form from the register, amount
// and tint from the biome, placement from the seed), so the fragment shader
// is one texture tap plus a little lighting: cheap when the deck fills the
// screen from below.
//
// Lit by the sun: bright tops, a two-tone shaded underside, warm at the
// terminator, dark silhouettes on the night side. They are an accent: low
// coverage, never fully opaque, thinner from space, faded toward the horizon
// from below. Only the planet the player is at (the active planet) shows its
// clouds; they fade in and out as that changes.

const FIELD_W = 256;
const FIELD_H = 128;
// After the active star and its glow (main.js), so a cloud can pass over the
// sun; after every atmosphere shell, so the sky never hides them.
export const CLOUD_RENDER_ORDER = 6;

export class Clouds {
  constructor({ planet, seed, register }) {
    this.planet = planet;
    this.form = cloudForm({ register, seed });
    this.fade = 0;
    this._biome = undefined;
    this._texture = null;

    const c = SKY_SETTINGS.value.clouds || {};
    // The geometry is built at the from-space radius and scaled per camera
    // (see layerRadius).
    this.baseRadius = planet.radius * (1 + (c.altitude ?? 0.1) * this.form.altitude);
    this.radius = this.baseRadius;
    const geom = new THREE.SphereGeometry(this.baseRadius, 64, 32);
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uField: { value: null },
        uCenter: { value: planet.center.clone() },
        uRadius: { value: this.radius },
        uCover: { value: 0.3 },
        uSoft: { value: this.form.soft * (c.soft ?? 0.05) / 0.05 },
        uOpacity: { value: c.opacity ?? 0.8 },
        uSpaceOpacity: { value: c.spaceOpacity ?? 0.55 },
        uFade: { value: 0 },
        uInside: { value: 0 },
        uLevel: { value: c.level ?? 0.85 },
        uShadeK: { value: this.form.shade },
        uTint: { value: new THREE.Color(0xffffff) },
        uShade: { value: new THREE.Color(c.shade ?? 0x8c9cc0) },
        uWarm: { value: new THREE.Color(c.warm ?? 0xff9a62) },
        uNight: { value: new THREE.Color(c.night ?? 0x0b0f1a) },
        uSunDir: { value: new THREE.Vector3(1, 0, 0) },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        varying vec3 vWorld;
        void main() {
          vUv = uv;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */`
        varying vec2 vUv;
        varying vec3 vWorld;
        uniform sampler2D uField;
        uniform vec3 uCenter;
        uniform float uRadius;
        uniform float uCover;
        uniform float uSoft;
        uniform float uOpacity;
        uniform float uSpaceOpacity;
        uniform float uFade;
        uniform float uInside;
        uniform float uLevel;
        uniform float uShadeK;
        uniform vec3 uTint;
        uniform vec3 uShade;
        uniform vec3 uWarm;
        uniform vec3 uNight;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;

        void main() {
          float d = texture2D(uField, vUv).r;
          float th = 1.0 - uCover;
          float a = smoothstep(th, th + uSoft, d);
          if (a < 0.004) discard;
          float thick = smoothstep(th + uSoft, th + uSoft + 0.22, d);

          vec3 n = normalize(vWorld - uCenter);
          vec3 oc = cameraPosition - uCenter;
          float below = step(length(oc), uRadius);
          float sunN = dot(n, uSunDir);
          float day = smoothstep(-0.12, 0.3, sunN);
          float dusk = smoothstep(-0.3, 0.0, sunN) * (1.0 - smoothstep(0.0, 0.3, sunN));

          vec3 lit = uTint * uSunColor * uLevel;
          // Tops: lit, the thin edges a touch darker. Undersides: two tones
          // of cool shade, darker where the cloud is thick.
          vec3 top = lit * mix(0.86, 1.0, thick);
          vec3 under = mix(lit, uShade * uLevel, 1.0 - uShadeK) * mix(1.0, uShadeK, thick);
          vec3 col = mix(top, under, below);
          col = mix(col, uWarm * uLevel * mix(1.0, 0.75, below), dusk * 0.45);
          col = mix(uNight, col, max(day, dusk));
          // From below on the night side, high clouds still catching the
          // sun stay dim: an accent, not a glow.
          float camDay = smoothstep(-0.3, 0.1, dot(oc / length(oc), uSunDir));
          col *= mix(1.0, mix(0.3, 1.0, camDay), below);

          float alpha = a * uOpacity * uFade * mix(uSpaceOpacity, 1.0, below) * mix(0.55, 1.0, max(day, dusk));
          // Passing through the deck: it thins out rather than filling the
          // screen with one flat shape.
          alpha *= smoothstep(6.0, 30.0, abs(length(oc) - uRadius));
          // Inside the atmosphere, clouds seen edge-on (near the horizon,
          // above or below the deck) melt into the haze.
          float cosV = dot(normalize(vWorld - cameraPosition), oc / length(oc));
          alpha *= mix(1.0, smoothstep(0.03, 0.3, abs(cosV)), uInside);
          if (alpha < 0.004) discard;
          gl_FragColor = vec4(col, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    this.mesh = new THREE.Mesh(geom, this.mat);
    this.mesh.position.copy(planet.center);
    this.mesh.renderOrder = CLOUD_RENDER_ORDER;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.userData.noAO = true;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // Per camera (so thumbnails agree): the deck's height, and one pass:
    // undersides from below, tops from above.
    this.mesh.onBeforeRender = (_r, _s, cam) => {
      const camR = cam.position.distanceTo(this.planet.center);
      this.radius = this.layerRadius(camR - this.planet.radius);
      this.mesh.scale.setScalar(this.radius / this.baseRadius);
      this.mesh.updateMatrixWorld();
      this.mat.uniforms.uRadius.value = this.radius;
      this.mat.uniforms.uInside.value = smooth(TUNING.ATM_TOP, TUNING.ATM_TOP * 0.75, camR - this.planet.radius);
      this.mat.side = camR < this.radius ? THREE.BackSide : THREE.FrontSide;
    };
  }

  /**
   * The deck's radius for a camera at altitude `camAlt`. From space it sits
   * low (`altitude` × planet radius), so it hugs the planet; as the camera
   * comes down through the upper atmosphere it rises to `skyAltitude` ×
   * ATM_TOP, so from the ground clouds are high overhead, not a sheet just
   * above the plane. Descending, you pass through it around that height.
   */
  layerRadius(camAlt) {
    const c = SKY_SETTINGS.value.clouds || {};
    const top = TUNING.ATM_TOP;
    const t = smooth(top, top * 0.75, camAlt);
    const space = (c.altitude ?? 0.1) * this.planet.radius;
    const sky = (c.skyAltitude ?? 0.75) * top;
    return this.planet.radius + (space + (sky - space) * t) * this.form.altitude;
  }

  _bake() {
    const data = bakeCloudField(this.form, FIELD_W, FIELD_H);
    const tex = new THREE.DataTexture(data, FIELD_W, FIELD_H, THREE.RedFormat, THREE.UnsignedByteType);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    this._texture = tex;
    this.mat.uniforms.uField.value = tex;
  }

  /**
   * Per frame. `active`: this is the planet the player is at. `sunPos`: the
   * system's star (world space), `sunColor` its colour.
   */
  update(dt, active, sunPos, sunColor) {
    const target = active ? 1 : 0;
    if (this.fade === 0 && target === 0) { this.mesh.visible = false; return; }
    if (!this._texture) this._bake();
    const step = Math.min(1, dt * 0.8);
    this.fade += (target - this.fade) * step;
    if (Math.abs(target - this.fade) < 0.002) this.fade = target;
    this.mesh.visible = this.fade > 0;

    const u = this.mat.uniforms;
    u.uFade.value = this.fade;
    if (sunPos) u.uSunDir.value.copy(sunPos).sub(this.planet.center).normalize();
    if (sunColor) u.uSunColor.value.copy(sunColor).lerp(_white, 0.75);
    const biome = this.planet.meta?.biome ?? null;
    if (biome !== this._biome) {
      this._biome = biome;
      const cov = cloudCover(this.form, biome);
      u.uCover.value = cov.cover * (SKY_SETTINGS.value.clouds?.amount ?? 1);
      u.uTint.value.set(cov.tint);
    }
    // A slow drift; the pattern itself never changes.
    this.mesh.rotation.y += dt * 0.004 * this.form.spin;
  }

  translate() {
    this.mesh.position.copy(this.planet.center);
    this.mat.uniforms.uCenter.value.copy(this.planet.center);
  }

  dispose() {
    this._texture?.dispose();
    this._texture = null;
  }
}

const _white = new THREE.Color(1, 1, 1);
const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
