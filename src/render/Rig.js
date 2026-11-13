// The light rig (roadmap Phase 1b): one sun with a shadow map, an optional
// fill, a sky/ground hemisphere and a flat ambient. A look (Looks.js) sets
// the colours and strengths; `aim` points the rig at a planet.
//
// One rig for every renderer in the project, so a bench shows what the game
// shows.

import * as THREE from 'three';

const SHADOW_MAP_SIZE = 2048;

export function createRig(scene, renderer) {
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  const fill = new THREE.DirectionalLight(0xffffff, 0);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0);
  const ambient = new THREE.AmbientLight(0xffffff, 0);
  scene.add(sun, sun.target, fill, fill.target, hemi, ambient);

  sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const _dir = new THREE.Vector3();

  return {
    sun, fill, hemi, ambient,

    setLook(look) {
      const L = look.lights;
      sun.color.set(L.sun.color);
      sun.intensity = L.sun.intensity;
      fill.visible = !!L.fill;
      if (L.fill) { fill.color.set(L.fill.color); fill.intensity = L.fill.intensity; }
      hemi.color.set(L.hemi.sky);
      hemi.groundColor.set(L.hemi.ground);
      hemi.intensity = L.hemi.intensity;
      ambient.color.set(L.ambient.color);
      ambient.intensity = L.ambient.intensity;

      const s = look.shadow;
      const on = !!s;
      if (sun.castShadow !== on) {
        sun.castShadow = on;
        // Turning shadows on or off changes every lit program.
        scene.traverse((o) => {
          if (!o.isMesh) return;
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m) m.needsUpdate = true;
        });
      }
      renderer.shadowMap.enabled = on;
      if (s) {
        sun.shadow.radius = s.radius;
        sun.shadow.intensity = s.intensity;
        sun.shadow.bias = s.bias;
        sun.shadow.normalBias = s.normalBias;
      }
    },

    /**
     * Point the rig at a planet.
     * @param {THREE.Vector3} center  planet centre (world)
     * @param {number} radius         planet radius
     * @param {THREE.Vector3} sunDir  unit vector from the planet toward the sun
     * @param {THREE.Vector3} up      unit "sky" direction for the hemisphere
     *   light: the local up of whatever the camera is looking at
     */
    aim({ center, radius, sunDir, up }) {
      _dir.copy(sunDir).normalize();
      sun.position.copy(center).addScaledVector(_dir, radius * 3);
      sun.target.position.copy(center);
      fill.position.copy(center).addScaledVector(_dir, -radius * 3);
      fill.target.position.copy(center);
      hemi.position.copy(up);

      // One orthographic shadow box around the whole planet, tall models
      // included. 2048 texels over ~2.8 radii.
      const half = radius * 1.4;
      const cam = sun.shadow.camera;
      cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
      cam.near = radius * 1.4;
      cam.far = radius * 4.6;
      cam.updateProjectionMatrix();
    },
  };
}
