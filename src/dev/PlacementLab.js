// Placement lab (Phase 13a). Boot with `?placementLab=1`.
//
// One planet at the origin, real construction path (Planet constructor →
// applyVisuals with forced catalog asset records), no flying required.
// This is the screenshot bench for slope gates, embed factors, up-vector
// blending, and ground-snap — fly-there-and-look takes minutes, this takes
// a reload.
//
// Query params:
//   seed=42                       terrain seed
//   biome=forest                  matSet biome
//   hero=<catalog id>             hero slot GLB
//   landmarks=<id,id,id>          landmark slot GLBs
//   surface=<id,id>               surface scatter GLBs
//   density=sparse|medium|dense
//   debug=1                       attach bbox/axes/normal helpers
//   shape=<landform> pattern=<p>  force terrain shape / ground pattern
//                                 (shared/planet-dice TERRAIN_SHAPES / GROUND_PATTERNS)
//   flat=1                        ignore authored colours (flat family colour
//                                 per asset, the pre-Phase-1a look) for A/B
//   look=sunlit|now               the look (default: the game's, sunlit)
//   shot=1                        screenshot mode (seed gallery, tests/e2e):
//                                 no auto-orbit, camera held on the hero
//                                 slot, frames drawn only on demand (the full
//                                 pipeline takes software rendering seconds),
//                                 `window.__LAB_READY = true` once the
//                                 assets are mounted and a frame has rendered
//
// Lit and finished like the game: the shared rig and post pipeline
// (src/render/Rig.js, Post.js), the sun's shadow box on the whole planet.
//
// Console: `__LAB.planet`, `__LAB.camera`, `__LAB.THREE` for poking.
// Drag to orbit, scroll to zoom.

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { GRADE } from '../world/ColorSystem.js';
import { buildLabPlanet, LAB_RADIUS } from './labPlanet.js';
import { getLook } from '../render/Looks.js';
import { createRig } from '../render/Rig.js';
import { createPost } from '../render/Post.js';
import { nightLighting } from '../world/NightLights.js';

// The sun direction the bench has always used (the game's old fixed key light).
// `sun=x,y,z` overrides it (night-side checks: put the sun behind the planet).
const SUN_DIR = new THREE.Vector3(220, 180, 120).normalize();

const DEFAULTS = {
  hero: 'kenney:space:hangar_largeA',           // the prod float case
  landmarks: 'kenney:castle:tower-hexagon-roof,kenney:graveyard:crypt-large,kenney:nature:cliff_large_rock',
  surface: 'quaternius:nature:BirchTree_1,kenney:nature:rock_smallA',
};

export async function runPlacementLab() {
  document.title = 'placement lab — personal space';
  for (const el of [...document.body.children]) {
    if (el.id !== 'canvas') el.style.display = 'none';
  }

  const params = new URLSearchParams(location.search);
  if (params.get('flat') === '1') GRADE.enabled = false;
  const sunParam = (params.get('sun') || '').split(',').map(Number);
  if (sunParam.length === 3 && sunParam.every(Number.isFinite)) SUN_DIR.fromArray(sunParam).normalize();

  // isDebugOn() reads this global; set it before applyVisuals mounts.
  globalThis.__GAME = globalThis.__GAME || {};
  globalThis.__GAME.debugPlacement = params.has('debug');

  const canvas = document.getElementById('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  const look = getLook(params.get('look'));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(look.background);
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 5000);

  const rig = createRig(scene, renderer);
  rig.setLook(look);
  const post = createPost(renderer, scene, camera);
  post.setLook(look);

  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });

  const radius = LAB_RADIUS;
  const shot = params.has('shot');
  const { planet, info } = await buildLabPlanet(params, {
    rapier: RAPIER, world, renderer, defaults: DEFAULTS, serial: shot, tag: 'placementLab',
  });
  scene.add(planet.group);
  planet.setShadowCaster(true);
  console.log('[placementLab] mounted', info);

  // ── Minimal orbit controls (drag + scroll) ──────────────────────────
  let theta = 0.6, phi = 1.05, dist = radius * 2.6;
  let dragging = false, px = 0, py = 0, auto = !shot;
  if (shot) {
    // Fixed framing for the seed gallery: whole planet in frame, viewed
    // from over the hero slot (falling back to the first slot), nudged
    // toward the sun so the hero side is lit. No time dependence anywhere.
    const d = (planet.heroSlot || planet.landmarks[0])?.direction;
    if (d) {
      const v = d.clone().normalize().add(SUN_DIR.clone().multiplyScalar(0.45)).normalize();
      phi = Math.max(0.05, Math.min(Math.PI - 0.05, Math.acos(Math.max(-1, Math.min(1, v.y)))));
      theta = Math.atan2(v.z, v.x);
    }
    dist = radius * 3.1;
  }
  canvas.addEventListener('pointerdown', (e) => { dragging = true; auto = false; px = e.clientX; py = e.clientY; });
  addEventListener('pointerup', () => { dragging = false; });
  addEventListener('pointermove', (e) => {
    if (!dragging) return;
    theta -= (e.clientX - px) * 0.005;
    phi = Math.max(0.05, Math.min(Math.PI - 0.05, phi - (e.clientY - py) * 0.005));
    px = e.clientX; py = e.clientY;
  });
  canvas.addEventListener('wheel', (e) => {
    dist = Math.max(radius * 1.05, Math.min(radius * 6, dist * (1 + e.deltaY * 0.001)));
  }, { passive: true });

  function resize() {
    const dpr = Math.min(devicePixelRatio, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(innerWidth, innerHeight, false);
    post.setSize(Math.round(innerWidth * dpr), Math.round(innerHeight * dpr));
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize);
  resize();

  const _up = new THREE.Vector3();
  const _sunPos = new THREE.Vector3();
  let fixedView = null;   // __LAB.view(): a free camera instead of the orbit
  function draw(t = 0) {
    if (auto) theta = t * 0.0001;
    if (fixedView) {
      camera.position.copy(fixedView.pos);
      camera.up.copy(fixedView.pos).normalize();
      camera.lookAt(fixedView.target);
    } else {
      camera.position.set(
        dist * Math.sin(phi) * Math.cos(theta),
        dist * Math.cos(phi),
        dist * Math.sin(phi) * Math.sin(theta)
      );
      camera.up.set(0, 1, 0);
      camera.lookAt(0, 0, 0);
    }
    // Night lights follow the bench sun (a far point along SUN_DIR).
    _sunPos.copy(SUN_DIR).multiplyScalar(1e5);
    planet.night?.update(_sunPos);
    // No atmosphere on the bench: count close to the ground as inside one.
    const alt = camera.position.length() - radius;
    rig.setNight(nightLighting(camera.position, planet.group.position, _sunPos, 1 - THREE.MathUtils.smoothstep(alt, 30, 90)));
    // Sky "up" toward the camera: the face of the planet in view is lit
    // by the sky, as the game's hemisphere follows the plane's up.
    rig.aim({ center: planet.group.position, radius, sunDir: SUN_DIR, up: _up.copy(camera.position).normalize() });
    post.render();
  }

  if (shot) {
    // Ready = shaders compiled, assets mounted (applyVisuals resolved
    // above, reveal forced solid), two frames drawn (the first compiles
    // and fills the shadow map) and shown.
    await post.compileAsync();
    draw(); draw();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    globalThis.__LAB_READY = true;
  } else {
    renderer.setAnimationLoop(draw);
  }

  globalThis.__LAB = { planet, camera, scene, renderer, rig, post, THREE, draw,
    /** Free camera at `pos` looking at `target` (planet-local = world here); null = orbit. */
    view(pos, target) {
      auto = false;
      fixedView = pos ? { pos: new THREE.Vector3().copy(pos), target: new THREE.Vector3().copy(target) } : null;
      draw();
    },
    setSun(v) { SUN_DIR.copy(v).normalize(); draw(); },
    lookAtSlot(slotId, zoom = 2.2) {
      const slot = planet.landmarks.find((s) => s.slotId === slotId) || planet.landmarks[0];
      if (!slot) return null;
      auto = false;
      const d = slot.direction;
      phi = Math.acos(Math.max(-1, Math.min(1, d.y)));
      theta = Math.atan2(d.z, d.x);
      dist = radius * zoom * 0.5 + radius;
      return `${slot.slotId}:${slot.kind}`;
    },
  };
}
