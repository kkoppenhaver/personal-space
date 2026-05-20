import * as THREE from 'three';
import { TUNING } from '../game/Tuning.js';

// Translucent shell around planet. Density is a smooth function of altitude.
export class Atmosphere {
  constructor({ planet, radius }) {
    this.planet = planet;
    this.radius = radius;

    const geom = new THREE.SphereGeometry(radius, 48, 32);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uPlanetCenter: { value: planet.center.clone() },
        uPlanetRadius: { value: planet.radius },
        uAtmRadius: { value: radius },
        uColor: { value: new THREE.Color(0xa8c8e8) },
      },
      vertexShader: `
        varying vec3 vWorld;
        varying vec3 vNormal;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        varying vec3 vWorld;
        varying vec3 vNormal;
        uniform vec3 uPlanetCenter;
        uniform vec3 uColor;
        uniform float uPlanetRadius;
        uniform float uAtmRadius;
        void main() {
          vec3 viewDir = normalize(cameraPosition - vWorld);
          float rim = 1.0 - max(dot(vNormal, viewDir), 0.0);
          float t = pow(rim, 2.2);
          float alpha = clamp(t * 0.55, 0.0, 0.65);
          gl_FragColor = vec4(uColor, alpha);
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

  tick(planePos, camera) {
    // Tint atmosphere color based on (future) palette
    if (this.planet.palette && this.planet.palette.sky) {
      this.mat.uniforms.uColor.value.set(this.planet.palette.sky);
    }
  }
}
