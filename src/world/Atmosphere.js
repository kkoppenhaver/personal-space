import * as THREE from 'three';
import { TUNING } from '../game/Tuning.js';
import { DEFAULT_SKY, skyPalette } from '../render/SkyPalette.js';

// How bright the daylit sky is drawn, shared by every atmosphere shell.
// The look sets it (Looks.js `skyGain`, applied in main.js): filmic tone
// mapping lifts mid tones, so a sky drawn at full palette strength comes out
// pale and grey.
export const SKY_GAIN = { value: 1 };
// The look's sky settings (Looks.js `sky`, applied in main.js).
export const SKY_SETTINGS = { value: DEFAULT_SKY };

// The planet's atmosphere: one translucent shell, one draw (roadmap 1c).
//
// The GAMEPLAY atmosphere is a uniform ATM_TOP band (density(), contains()).
// The shell's shader paints two things and blends them by the camera's
// altitude:
//
//   From space, a thin lit limb. The layer is exponential with a short scale
//   height (`limbHeight` × radius) and its optical depth is computed in
//   closed form (no raymarch): for a ray that misses the planet, the column
//   through its closest point; for a ray that hits it, the column from the
//   ground back to the camera. So the rim hugs the planet, is brightest
//   where it is lit, warm at the terminator and fades on the night side, and
//   the surface face-on stays clear.
//
//   Inside, a sky gradient set by the sun's elevation at the camera: deep
//   overhead and pale at the horizon by day; at dusk a warm band toward the
//   sun and cool tones opposite; a dark, see-through night where the stars
//   show. By day (and through dusk) the sky is fully opaque, so nothing
//   behind it (stars, other planets and their shells, other stars' glow)
//   shows through. The colours come from SkyPalette.js.
//
// Drawn as a front-face shell from outside and a back-face shell from inside
// (chosen per camera in onBeforeRender, so thumbnails work too): a single
// pass either way, and from outside it draws over the planet's edge.
export class Atmosphere {
  constructor({ planet, radius }) {
    this.planet = planet;
    this.radius = radius;
    this._palKey = '';

    const geom = new THREE.SphereGeometry(radius, 48, 32);
    const s = SKY_SETTINGS.value;
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uPlanetCenter: { value: planet.center.clone() },
        uPlanetRadius: { value: planet.radius },
        uAtmRadius: { value: radius },
        uLimbH: { value: planet.radius * (s.limbHeight ?? 0.07) },
        uLimbK: { value: s.limbStrength ?? 0.25 },
        uFaceHaze: { value: s.faceHaze ?? 0.25 },
        uSkyLow: { value: (s.skyFullBelow ?? 0.25) * TUNING.ATM_TOP },
        uNightAlpha: { value: s.nightAlpha ?? 0.25 },
        uGlare: { value: s.glare ?? 1 },
        uLowSunDim: { value: s.lowSunDim ?? 0.75 },
        uZenith: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uDuskWarm: { value: new THREE.Color() },
        uDuskCool: { value: new THREE.Color() },
        uDuskZenith: { value: new THREE.Color() },
        uNight: { value: new THREE.Color() },
        uLimbColor: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3(1, 0.6, 0.4).normalize() },
        uSunColor: { value: new THREE.Color(0xfff2d6) },
      },
      vertexShader: /* glsl */`
        varying vec3 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */`
        varying vec3 vWorld;
        uniform vec3 uPlanetCenter;
        uniform float uPlanetRadius;
        uniform float uAtmRadius;
        uniform float uLimbH;
        uniform float uLimbK;
        uniform float uFaceHaze;
        uniform float uSkyLow;
        uniform float uNightAlpha;
        uniform float uGlare;
        uniform float uLowSunDim;
        uniform vec3 uZenith;
        uniform vec3 uHorizon;
        uniform vec3 uDuskWarm;
        uniform vec3 uDuskCool;
        uniform vec3 uDuskZenith;
        uniform vec3 uNight;
        uniform vec3 uLimbColor;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;

        void main() {
          vec3 rd = normalize(vWorld - cameraPosition);
          vec3 oc = cameraPosition - uPlanetCenter;
          float rc = length(oc);
          vec3 upC = oc / rc;
          float b = dot(oc, rd);
          // Ray against a sphere a hair under the mean surface.
          float rg = uPlanetRadius * 0.995;
          float hg = b * b - (rc * rc - rg * rg);
          float tg = -b - sqrt(max(hg, 0.0));
          bool hit = hg > 0.0 && tg > 0.0;
          float mu = max(dot(rd, uSunDir), 0.0);

          // 1 = the camera is low enough for a full sky; 0 = space view.
          float k = 1.0 - smoothstep(uSkyLow, uAtmRadius - uPlanetRadius, rc - uPlanetRadius);

          // ---- From space: the thin limb ----
          vec3 cSpace = vec3(0.0);
          float aSpace = 0.0;
          if (k < 1.0) {
            float H = uLimbH;
            float tau;     // optical depth, in scale heights
            vec3 nL;       // where the light is judged
            if (hit) {
              nL = normalize(oc + rd * tg);
              float cg = max(dot(nL, -rd), 0.0);
              float c = sqrt(uPlanetRadius / H);
              tau = c / (c * cg + 1.0);     // Chapman, ground back to space
              // The limb is the accent: thin the haze over the face.
              tau *= mix(uFaceHaze, 1.0, (1.0 - cg) * (1.0 - cg));
            } else {
              float tp = -b;
              vec3 pp = oc + rd * max(tp, 0.0);
              float rp = length(pp);
              nL = pp / rp;
              float hp = max(rp - uPlanetRadius, 0.0);
              if (tp > 0.0) {
                tau = exp(-hp / H) * sqrt(6.2832 * rp / H);  // through the closest point
              } else {
                float c = sqrt(rc / H);
                tau = exp(-hp / H) * c / (c * max(dot(upC, rd), 0.0) + 1.0);
              }
            }
            float sunL = dot(nL, uSunDir);
            float dayL = smoothstep(-0.12, 0.35, sunL);
            float duskL = smoothstep(-0.32, 0.0, sunL) * (1.0 - smoothstep(0.0, 0.3, sunL));
            aSpace = (1.0 - exp(-uLimbK * tau)) * max(max(dayL, duskL), 0.1);
            cSpace = uLimbColor * dayL + uDuskWarm * duskL
              + uSunColor * pow(mu, 8.0) * 0.5 * (dayL + duskL);
          }

          // ---- Inside: the sky ----
          vec3 cSky = vec3(0.0);
          float aSky = 0.0;
          if (k > 0.0) {
            float cosV = dot(rd, upC);
            float toHz = 1.0 - max(cosV, 0.0);
            float e = dot(upC, uSunDir);              // sun elevation (sine)
            vec3 rdH = rd - upC * cosV;
            vec3 sH = uSunDir - upC * e;
            float az = dot(rdH, sH) * inversesqrt(max(dot(rdH, rdH) * dot(sH, sH), 1e-8));
            float toward = 0.5 + 0.5 * az;
            toward *= toward;
            float band = toHz * toHz * toHz;

            // The day sky dims as the sun gets low (SkyPalette.dayDim).
            vec3 dayC = mix(uZenith, uHorizon, pow(toHz, 2.5)) * mix(uLowSunDim, 1.0, smoothstep(0.0, 0.5, e));
            vec3 duskC = mix(uDuskZenith, mix(uDuskCool, uDuskWarm, toward), band);
            vec3 nightC = uNight * (0.55 + 0.45 * band);
            float dayW = smoothstep(-0.03, 0.28, e);
            float nightW = 1.0 - smoothstep(-0.32, -0.06, e);
            cSky = mix(mix(duskC, dayC, dayW), nightC, nightW);
            // A low sun warms the horizon beneath it before it sets.
            cSky += uDuskWarm * (toward * toward * band * band * smoothstep(0.4, 0.05, e) * dayW * 0.6);
            // Glare around the sun while it is up.
            cSky += uSunColor * ((pow(mu, 24.0) * 0.45 + pow(mu, 4.0) * 0.05) * smoothstep(-0.1, 0.03, e) * uGlare);
            // Opaque by day and dusk; at night see-through overhead.
            aSky = mix(mix(uNightAlpha, 0.9, band), 1.0, smoothstep(-0.24, -0.02, e));
          }

          vec3 pre = mix(cSpace * aSpace, cSky * aSky, k);
          float a = mix(aSpace, aSky, k);
          if (a < 0.002) discard;
          gl_FragColor = vec4(pre / a, min(a, 1.0));
          // Tone mapping applies only when drawn straight to the screen (the "low"
          // quality tier); through the composer OutputPass does it (Post.js).
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geom, mat);
    this.mesh.position.copy(planet.center);
    this.mesh.userData.noAO = true;
    // One pass, chosen per camera: back faces from inside (the sky), front
    // faces from outside (the limb, drawn over the planet's edge).
    this.mesh.onBeforeRender = (_r, _s, cam) => {
      mat.side = cam.position.distanceToSquared(this.planet.center) < radius * radius
        ? THREE.BackSide : THREE.FrontSide;
    };
    this.mat = mat;
    this._syncPalette();
  }

  // 1.0 at surface, 0.0 at boundary, smooth.
  density(pos) {
    const r = pos.distanceTo(this.planet.center);
    const alt = r - this.planet.radius;
    const t = 1.0 - Math.min(1, Math.max(0, alt / TUNING.ATM_TOP));
    return Math.pow(t, 1.5);
  }

  contains(pos) {
    return pos.distanceTo(this.planet.center) < this.radius;
  }

  // Direction of gravity (pointing toward planet center) at pos.
  gravityDir(pos) {
    return this.planet.center.clone().sub(pos).normalize();
  }

  // Call after the owning planet has been translated. Re-syncs the
  // atmosphere mesh's render position and the shader's world-space center
  // uniform from the planet's current center.
  translate(_delta) {
    this.mesh.position.copy(this.planet.center);
    if (this.mat.uniforms.uPlanetCenter) {
      this.mat.uniforms.uPlanetCenter.value.copy(this.planet.center);
    }
  }

  /** World-space position of the system's sun — lights the shell. */
  setSun(sunPos, sunColor) {
    this.mat.uniforms.uSunDir.value.copy(sunPos).sub(this.planet.center).normalize();
    if (sunColor) this.mat.uniforms.uSunColor.value.copy(sunColor);
    this._syncPalette();
  }

  /** The sky colours this shell is drawing (SkyPalette.js), for fog etc. */
  get palette() { return this._pal; }

  // Re-derive the sky colours when the planet's palette, the star or the
  // look changes (cheap key compare; called every frame via setSun).
  _syncPalette() {
    const u = this.mat.uniforms;
    const sky = this.planet.palette?.sky ?? null;
    const key = `${sky}|${u.uSunColor.value.getHexString()}|${SKY_GAIN.value}`;
    if (key === this._palKey && this._palSettings === SKY_SETTINGS.value) return;
    this._palKey = key;
    this._palSettings = SKY_SETTINGS.value;
    const s = { ...DEFAULT_SKY, ...SKY_SETTINGS.value };
    const p = skyPalette(sky, { sunColor: u.uSunColor.value, gain: SKY_GAIN.value, s });
    this._pal = p;
    u.uZenith.value.copy(p.zenith);
    u.uHorizon.value.copy(p.horizon);
    u.uDuskWarm.value.copy(p.duskWarm);
    u.uDuskCool.value.copy(p.duskCool);
    u.uDuskZenith.value.copy(p.duskZenith);
    u.uNight.value.copy(p.night);
    u.uLimbColor.value.copy(p.limb);
    u.uLimbH.value = this.planet.radius * s.limbHeight;
    u.uLimbK.value = s.limbStrength;
    u.uFaceHaze.value = s.faceHaze;
    u.uSkyLow.value = s.skyFullBelow * TUNING.ATM_TOP;
    u.uNightAlpha.value = s.nightAlpha;
    u.uGlare.value = s.glare;
    u.uLowSunDim.value = s.lowSunDim;
  }

  tick(_planePos, _camera) {
    this._syncPalette();
  }
}
