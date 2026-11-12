import * as THREE from 'three';
import { TUNING } from '../game/Tuning.js';

// Translucent shell around planet. Density is a smooth function of altitude.
export class Atmosphere {
  constructor({ planet, radius }) {
    this.planet = planet;
    this.radius = radius;

    const geom = new THREE.SphereGeometry(radius, 48, 32);
    // Raymarched single-scatter-ish shell. The GAMEPLAY atmosphere is a
    // uniform 150m band (ATM_TOP), but the VISUAL density falls off
    // exponentially with a short scale height — so from space you get a
    // thin bright limb hugging the planet instead of a flat translucent
    // disc 2.5× its size, and from inside you get a real sky: thin (deep)
    // overhead, thick (pale) at the horizon. Lit by the actual sun
    // direction: day side in the planet's sky color, a warm band at the
    // terminator, near-black night side.
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uPlanetCenter: { value: planet.center.clone() },
        uPlanetRadius: { value: planet.radius },
        uAtmRadius: { value: radius },
        uScaleH: { value: TUNING.ATM_TOP * 0.28 },
        uColor: { value: new THREE.Color(0x8fbcec) },
        uSunDir: { value: new THREE.Vector3(1, 0.6, 0.4).normalize() },
        uSunColor: { value: new THREE.Color(0xfff2d6) },
      },
      vertexShader: `
        varying vec3 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        varying vec3 vWorld;
        uniform vec3 uPlanetCenter;
        uniform float uPlanetRadius;
        uniform float uAtmRadius;
        uniform float uScaleH;
        uniform vec3 uColor;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;

        vec2 raySphere(vec3 ro, vec3 rd, float r) {
          vec3 oc = ro - uPlanetCenter;
          float b = dot(oc, rd);
          float c = dot(oc, oc) - r * r;
          float h = b * b - c;
          if (h < 0.0) return vec2(1e9, -1e9);
          h = sqrt(h);
          return vec2(-b - h, -b + h);
        }

        void main() {
          vec3 ro = cameraPosition;
          vec3 rd = normalize(vWorld - ro);
          vec2 a = raySphere(ro, rd, uAtmRadius);
          float t0 = max(a.x, 0.0);
          float t1 = a.y;
          vec2 g = raySphere(ro, rd, uPlanetRadius * 0.995);
          if (g.x > 0.0) t1 = min(t1, g.x);
          if (t1 <= t0) discard;

          const int STEPS = 12;
          float seg = (t1 - t0) / float(STEPS);
          float depth = 0.0;
          vec3 light = vec3(0.0);
          for (int i = 0; i < STEPS; i++) {
            vec3 pos = ro + rd * (t0 + seg * (float(i) + 0.5));
            vec3 n = pos - uPlanetCenter;
            float r = length(n);
            n /= r;
            float d = exp(-max(r - uPlanetRadius, 0.0) / uScaleH) * seg;
            depth += d;
            float sun = dot(n, uSunDir);
            float day = smoothstep(-0.2, 0.35, sun);
            float dusk = smoothstep(-0.35, 0.0, sun) * (1.0 - smoothstep(0.0, 0.35, sun));
            light += (uColor * (0.05 + day) + vec3(1.0, 0.48, 0.22) * dusk * 0.9) * d;
          }
          vec3 col = light / max(depth, 1e-4);
          // Forward scattering: the sky brightens toward the sun.
          float mu = max(dot(rd, uSunDir), 0.0);
          col += uSunColor * (pow(mu, 12.0) * 0.6 + pow(mu, 3.0) * 0.12);
          float alpha = 1.0 - exp(-depth * (1.9 / uScaleH));
          gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.97));
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geom, mat);
    this.mesh.position.copy(planet.center);
    this.mat = mat;
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
  }

  tick(planePos, camera) {
    // Tint atmosphere color based on (future) palette
    if (this.planet.palette && this.planet.palette.sky) {
      this.mat.uniforms.uColor.value.set(this.planet.palette.sky);
    }
  }
}
