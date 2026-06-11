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
//
// Console: `__LAB.planet`, `__LAB.camera`, `__LAB.THREE` for poking.
// Drag to orbit, scroll to zoom.

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Planet } from '../world/Planet.js';
import { getAssetById } from '../world/assets/Catalog.js';

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
  const seed = (parseInt(params.get('seed') || '42', 10) || 42) >>> 0;
  const biome = params.get('biome') || 'forest';
  const density = params.get('density') || 'medium';

  // isDebugOn() reads this global; set it before applyVisuals mounts.
  globalThis.__GAME = globalThis.__GAME || {};
  globalThis.__GAME.debugPlacement = params.has('debug');

  const canvas = document.getElementById('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x0a0c12);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 5000);

  // Match the game's lighting posture (main.js) so colors read the same.
  const sun = new THREE.DirectionalLight(0xfff2d6, 0.75);
  sun.position.set(220, 180, 120);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xcbd9ff, 0.45);
  fill.position.set(-160, -120, -80);
  scene.add(fill);
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));

  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });

  const radius = 60;
  const planet = new Planet({ rapier: RAPIER, world, seed, radius, center: new THREE.Vector3() });
  scene.add(planet.group);

  // Forced concept (Phase 14b): sea/amp/slots/motif/subjects/embed/tier
  // params build a synthetic concept so the reference planets are
  // reproducible without a worker. e.g.
  //   ?placementLab=1&sea=0&amp=0.8&slots=3&motif=shared-heading&subjects=landmarks&embed=0.4&tier=singular
  if (['sea', 'amp', 'slots', 'motif', 'embed'].some((k) => params.has(k))) {
    if (params.has('tier')) planet.tier = params.get('tier');
    planet.applyConcept({
      teaser: 'forced lab concept',
      premise: 'forced lab concept',
      question: 'is the placement right?',
      biome,
      terrain: {
        sea_level: parseFloat(params.get('sea') ?? '0.42'),
        amplitude: parseFloat(params.get('amp') ?? '1.0'),
      },
      landmark_slots: parseInt(params.get('slots') ?? '4', 10),
      hero_on_water: params.has('heroWater'),
      creature_budget: parseFloat(params.get('creatures_budget') ?? '0.35'),
      density,
      motif: { kind: params.get('motif') ?? 'none', subjects: params.get('subjects') ?? 'surface' },
      ...(params.has('embed') ? { embed_bias: parseFloat(params.get('embed')) } : {}),
      asset_keywords: [],
    });
  }

  const ids = (key) => (params.get(key) ?? DEFAULTS[key] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const heroAsset = getAssetById(params.get('hero') || DEFAULTS.hero);
  const landmarkAssets = ids('landmarks').map(getAssetById);
  const surfaceAssets = ids('surface').map(getAssetById);
  const creatureAssets = ids('creatures').map(getAssetById).filter(Boolean);
  for (const [k, v] of [['hero', heroAsset], ['landmarks', landmarkAssets], ['surface', surfaceAssets]]) {
    const missing = (Array.isArray(v) ? v : [v]).filter((x) => !x).length;
    if (missing) console.warn(`[placementLab] ${missing} unknown ${k} id(s) — check the catalog`);
  }

  await planet.applyVisuals({
    palette: planet.palette,
    biome,
    heroAsset,
    landmarkAssets: landmarkAssets.filter(Boolean),
    surfaceAssets: surfaceAssets.filter(Boolean),
    creatureAssets,
    density,
    renderer,
  });
  // No atmosphere in the lab — snap the reveal solid.
  planet.forceRevealComplete();
  console.log('[placementLab] mounted', {
    seed, biome, density,
    hero: heroAsset?.id,
    landmarks: landmarkAssets.filter(Boolean).map((a) => a.id),
    surface: surfaceAssets.filter(Boolean).map((a) => a.id),
    slots: planet.landmarks.map((s) => `${s.slotId}:${s.kind}`),
  });

  // ── Minimal orbit controls (drag + scroll) ──────────────────────────
  let theta = 0.6, phi = 1.05, dist = radius * 2.6;
  let dragging = false, px = 0, py = 0, auto = true;
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
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize);
  resize();

  renderer.setAnimationLoop((t) => {
    if (auto) theta = t * 0.0001;
    camera.position.set(
      dist * Math.sin(phi) * Math.cos(theta),
      dist * Math.cos(phi),
      dist * Math.sin(phi) * Math.sin(theta)
    );
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
  });

  globalThis.__LAB = { planet, camera, scene, renderer, THREE,
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
