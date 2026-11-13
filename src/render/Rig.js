// The light rig (roadmap Phase 1b): one sun with a shadow map, an optional
// fill, a sky/ground hemisphere and a flat ambient. A look (Looks.js) sets
// the colours and strengths; `aim` points the rig at a planet and places
// the sun's shadow box (ShadowFit.js).
//
// One rig for every renderer in the project, so a bench shows what the game
// shows. Benches box the whole planet; the game fits the box to the view.

import * as THREE from 'three';
import { shadowBox, planetHalf } from './ShadowFit.js';

const DEFAULT_MAP_SIZE = 2048;

// The look's shadow numbers were tuned on the look lab: a 2048 map over a
// whole 60 m planet, a 192 m deep box. `radius` (PCF blur, in texels) and
// `bias` (in depth-buffer units) both depend on the box, so they are
// rescaled to keep the same penumbra width and the same offset in metres.
const TUNED_MAP_SIZE = 2048;
const TUNED_DEPTH = 60 * 3.2;

export function createRig(scene, renderer) {
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  const fill = new THREE.DirectionalLight(0xffffff, 0);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0);
  const ambient = new THREE.AmbientLight(0xffffff, 0);
  scene.add(sun, sun.target, fill, fill.target, hemi, ambient);

  sun.shadow.mapSize.set(DEFAULT_MAP_SIZE, DEFAULT_MAP_SIZE);
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const lookSun = new THREE.Color(0xffffff);
  let look = null;
  let shadowsAllowed = true;
  let depth = TUNED_DEPTH;

  function markLitMaterials() {
    // Shadows on/off changes every lit program.
    scene.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m) m.needsUpdate = true;
    });
  }

  function syncShadow() {
    const s = look?.shadow;
    const on = !!s && shadowsAllowed;
    if (sun.castShadow !== on) {
      sun.castShadow = on;
      markLitMaterials();
    }
    renderer.shadowMap.enabled = on;
    if (!s) return;
    sun.shadow.radius = s.radius * (sun.shadow.mapSize.x / TUNED_MAP_SIZE);
    sun.shadow.intensity = s.intensity;
    sun.shadow.bias = s.bias * (TUNED_DEPTH / depth);
    sun.shadow.normalBias = s.normalBias;
  }

  return {
    sun, fill, hemi, ambient,

    setLook(next) {
      look = next;
      const L = look.lights;
      lookSun.set(L.sun.color);
      sun.color.copy(lookSun);
      sun.intensity = L.sun.intensity;
      fill.visible = !!L.fill;
      if (L.fill) { fill.color.set(L.fill.color); fill.intensity = L.fill.intensity; }
      hemi.color.set(L.hemi.sky);
      hemi.groundColor.set(L.hemi.ground);
      hemi.intensity = L.hemi.intensity;
      ambient.color.set(L.ambient.color);
      ambient.intensity = L.ambient.intensity;
      syncShadow();
    },

    /**
     * Tint the sun toward a star's colour. `amount` 0 = the look's sun.
     * (The game's systems have coloured suns; benches have none.)
     */
    tintSun(color, amount) {
      sun.color.copy(lookSun).lerp(color, amount);
    },

    /**
     * Shadow quality from the tier: on/off and map size.
     * @param {{ shadows: boolean, shadowMapSize: number }} t
     */
    setQuality({ shadows, shadowMapSize }) {
      shadowsAllowed = !!shadows;
      const size = shadowMapSize || DEFAULT_MAP_SIZE;
      if (sun.shadow.mapSize.x !== size) {
        sun.shadow.mapSize.set(size, size);
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
      }
      syncShadow();
    },

    /**
     * Point the rig at a planet.
     * @param {object} p
     * @param {THREE.Vector3} p.center  planet centre (world)
     * @param {number} p.radius         planet radius
     * @param {THREE.Vector3} p.sunDir  unit vector from the planet toward the sun
     * @param {THREE.Vector3} p.up      unit "sky" direction for the hemisphere
     *   light: the local up of whatever the camera is looking at
     * @param {THREE.Vector3} [p.focus] shadow box centre (default: the
     *   planet centre, i.e. the whole planet)
     * @param {number} [p.half]         shadow box half-size (default: the
     *   whole planet)
     */
    aim({ center, radius, sunDir, up, focus = center, half = planetHalf(radius) }) {
      const box = shadowBox({ planetCenter: center, radius, sunDir, focus, half, mapSize: sun.shadow.mapSize.x });
      sun.position.copy(box.position);
      sun.target.position.copy(box.target);
      fill.position.copy(box.target).addScaledVector(sunDir, -box.far * 0.5);
      fill.target.position.copy(box.target);
      hemi.position.copy(up);

      const cam = sun.shadow.camera;
      cam.up.copy(box.up);
      cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
      cam.near = box.near;
      cam.far = box.far;
      cam.updateProjectionMatrix();
      if (box.far !== depth) { depth = box.far; syncShadow(); }
    },
  };
}
