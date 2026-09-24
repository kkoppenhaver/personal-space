import * as THREE from 'three';

// Ambient motes (Phase 15c — life). A few hundred drifting points in a box
// around the camera while inside an atmosphere: pollen, snow, embers,
// spray, fireflies. The surfaces are otherwise frozen; motes are the
// cheapest thing that makes a world feel inhabited by weather, and they
// double as a speed cue near the ground.
//
// Positions live in a camera-relative box and wrap (modulo), so the cloud
// is infinite without respawning anything; the box is re-centered on the
// camera each frame (floating-origin safe — nothing is stored in world
// space).

const COUNT = 700;
const BOX = 70; // meters, cube edge

// kind → look + motion. `rise` is along planet-radial up (m/s), `drift`
// sideways wander amplitude, `size` in px at ~10m.
const KINDS = {
  // Daytime kinds use normal blending — additive motes vanish against a
  // bright sky. Only things that emit light (embers, fireflies) add.
  pollen:    { color: 0xffe07a, size: 6.5, rise: 0.15, drift: 0.6, twinkle: 0.2, opacity: 0.85, blend: THREE.NormalBlending },
  snow:      { color: 0xffffff, size: 7.5, rise: -1.4, drift: 0.8, twinkle: 0.0, opacity: 0.95, blend: THREE.NormalBlending },
  embers:    { color: 0xff7a2a, size: 6.0, rise: 1.2, drift: 0.5, twinkle: 0.8, opacity: 1.0, blend: THREE.AdditiveBlending },
  ash:       { color: 0x6f6a66, size: 6.5, rise: -0.5, drift: 0.7, twinkle: 0.0, opacity: 0.8, blend: THREE.NormalBlending },
  spray:     { color: 0xf2fbff, size: 5.5, rise: 0.3, drift: 1.2, twinkle: 0.3, opacity: 0.75, blend: THREE.NormalBlending },
  spores:    { color: 0x7dffb0, size: 6.0, rise: 0.4, drift: 0.5, twinkle: 0.6, opacity: 0.85, blend: THREE.NormalBlending },
  fireflies: { color: 0xfff27a, size: 7.0, rise: 0.1, drift: 1.0, twinkle: 1.0, opacity: 1.0, blend: THREE.AdditiveBlending },
};

/** Pick a mote kind for a planet (biome + concept words), night → fireflies/embers glow. */
export function moteKindFor(planet) {
  const biome = planet?.meta?.biome || planet?.concept?.biome || '';
  const text = `${planet?.concept?.premise || ''} ${planet?.concept?.teaser || ''}`.toLowerCase();
  if (/\b(snow|frost|ice|frozen|winter)\b/.test(text) || biome === 'ice') return 'snow';
  if (/\b(ember|lava|volcan|smok|fire|burn)\w*/.test(text) || biome === 'volcanic') return 'embers';
  if (/\b(ash|dust|cinder)\b/.test(text) || biome === 'gas-stripped') return 'ash';
  if (/\b(spore|fung|mushroom|glow)\w*/.test(text) || biome === 'alien' || biome === 'crystalline') return 'spores';
  if (biome === 'ocean' || (planet?.terrainParams?.seaLevelQuantile ?? 0) > 0.65) return 'spray';
  return 'pollen';
}

export class Motes {
  constructor(scene) {
    const pos = new Float32Array(COUNT * 3);
    const seed = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      pos[i * 3] = Math.random() * BOX;
      pos[i * 3 + 1] = Math.random() * BOX;
      pos[i * 3 + 2] = Math.random() * BOX;
      seed[i] = Math.random();
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.uniforms = {
      uTime: { value: 0 },
      uCenter: { value: new THREE.Vector3() },   // camera position
      uOffset: { value: new THREE.Vector3() },   // accumulated drift (wraps)
      uUp: { value: new THREE.Vector3(0, 1, 0) },
      uColor: { value: new THREE.Color(0xffffff) },
      uSize: { value: 3 },
      uOpacity: { value: 0 },
      uTwinkle: { value: 0 },
      uDrift: { value: 0.5 },
      uPixelRatio: { value: Math.min(devicePixelRatio, 2) },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */`
        attribute float aSeed;
        uniform float uTime, uSize, uDrift, uPixelRatio, uTwinkle;
        uniform vec3 uCenter, uOffset;
        varying float vFade;
        varying float vTw;
        const float BOX = ${BOX.toFixed(1)};
        void main() {
          // Wrap into a box centered on the camera.
          vec3 p = mod(position + uOffset - uCenter + BOX * 0.5, BOX) - BOX * 0.5;
          float t = uTime * (0.3 + aSeed * 0.5) + aSeed * 40.0;
          p += uDrift * vec3(sin(t), sin(t * 1.3 + 2.0), cos(t * 0.9));
          vec4 mv = modelViewMatrix * vec4(uCenter + p, 1.0);
          gl_Position = projectionMatrix * mv;
          float dist = -mv.z;
          // Fade at the box edge (no popping on wrap) and right at the lens.
          vFade = smoothstep(BOX * 0.5, BOX * 0.3, length(p)) * smoothstep(0.8, 3.0, dist);
          vTw = 1.0 - uTwinkle * (0.5 + 0.5 * sin(uTime * (2.0 + aSeed * 3.0) + aSeed * 90.0));
          gl_PointSize = uSize * uPixelRatio * (10.0 / max(dist, 0.5)) * (0.6 + aSeed * 0.8);
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vFade;
        varying float vTw;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.1, d) * uOpacity * vFade * vTw;
          gl_FragColor = vec4(uColor, a);
          #include <colorspace_fragment>
        }
      `,
    });
    this.points = new THREE.Points(geom, this.material);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.kind = null;
    this._opacityTarget = 0;
  }

  setKind(kind) {
    if (kind === this.kind) return;
    this.kind = kind;
    const k = KINDS[kind] || KINDS.pollen;
    this.spec = k;
    this.uniforms.uColor.value.set(k.color);
    this.uniforms.uSize.value = k.size;
    this.uniforms.uTwinkle.value = k.twinkle;
    this.uniforms.uDrift.value = k.drift;
    this.material.blending = k.blend;
    this.material.needsUpdate = true;
  }

  /**
   * @param {number} dt
   * @param {THREE.Camera} camera
   * @param {THREE.Vector3} radialUp  planet up at the camera
   * @param {number} density  0..1 atmosphere density at the plane
   * @param {boolean} night   swap to fireflies after dark on living worlds
   */
  update(dt, camera, radialUp, density, night) {
    if (night && (this.kind === 'pollen' || this.kind === 'fireflies')) this.setKind('fireflies');
    else if (!night && this.kind === 'fireflies') this.setKind('pollen');
    const u = this.uniforms;
    u.uTime.value += dt;
    u.uCenter.value.copy(camera.position);
    if (this.spec) u.uOffset.value.addScaledVector(radialUp, this.spec.rise * dt);
    // Keep the offset bounded (float precision); BOX-periodic so no jump.
    const o = u.uOffset.value;
    o.set(o.x % BOX, o.y % BOX, o.z % BOX);
    const target = (this.spec?.opacity ?? 0) * Math.min(1, density * 1.8);
    u.uOpacity.value += (target - u.uOpacity.value) * Math.min(1, dt * 2);
    this.points.visible = u.uOpacity.value > 0.01;
  }
}
