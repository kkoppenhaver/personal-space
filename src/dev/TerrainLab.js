// Terrain lab (Phase 15a). Boot with `?terrainLab=1`.
//
// Every terrain shape side by side, each painted with a ground pattern,
// lit from the side so relief reads. The regression sheet for any change
// to TerrainShapes.js / TerrainGen.js — the question to ask of each cell:
// "could you tell this planet apart from its neighbours from orbit?"
//
// URL params:
//   seed=<int>        base seed (default 1)
//   pattern=<name>    force one pattern on every cell (default: cycle)
//   palette=<a,b,..>  water,low,mid,high,snow as hex without '#'
//   spin=0            freeze rotation
//   look=sunlit|now   the look (default: the game's, sunlit)
//   coarse=1          the coarse terrain (default: fine, as at the planet you're at)
//   dist=<m>          camera distance from each planet's centre (default 420)
//
// Lit and finished like the game (src/render/Rig.js, Post.js): each cell
// has its own scene and rig, and one post pipeline draws them in turn.

import * as THREE from 'three';
import { buildPlanetGeometry, buildFineTerrainNow } from '../world/TerrainGen.js';
import { createGroundMaterial } from '../world/GroundMaterial.js';
import { fineFactorFor } from '../world/TerrainDetail.js';
import { TERRAIN_SHAPES, GROUND_PATTERNS } from '../world/TerrainShapes.js';
import { getLook } from '../render/Looks.js';
import { createRig } from '../render/Rig.js';
import { createPost } from '../render/Post.js';
import { setShadowFlags } from '../render/Shadows.js';

// Lit from the side so relief reads.
const SUN_DIR = new THREE.Vector3(-3, 2, 1.5).normalize();
const VIEW_UP = new THREE.Vector3(0, 0, 1);   // toward the camera
const ORIGIN = new THREE.Vector3();

export async function runTerrainLab() {
  document.title = 'terrain lab — personal space';
  for (const el of [...document.body.children]) {
    if (el.id !== 'canvas') el.style.display = 'none';
  }
  const q = new URLSearchParams(location.search);
  const seed = Number(q.get('seed') || 1);
  const forcedPattern = q.get('pattern');
  const spin = q.get('spin') !== '0';
  const pal = (q.get('palette') || '2f6f9e,6f9a4a,b39a5c,7e6247,f3eee2').split(',').map((h) => `#${h}`);
  const palette = { water: pal[0], low: pal[1], mid: pal[2], high: pal[3], snow: pal[4], sky: '#9ac4e8' };

  const canvas = document.getElementById('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.setScissorTest(true);
  const look = getLook(q.get('look'));
  const coarse = q.get('coarse') === '1';
  const dist = Number(q.get('dist') || 420);
  let post = null;

  const cols = 5;
  const rows = Math.ceil(TERRAIN_SHAPES.length / cols);
  const cells = TERRAIN_SHAPES.map((shape, i) => {
    const pattern = forcedPattern || GROUND_PATTERNS[i % GROUND_PATTERNS.length];
    const cellSeed = seed + i * 7919;
    const built = buildPlanetGeometry({ seed: cellSeed, radius: 100, palette, shape, pattern, seaLevelQuantile: 0.3 });
    const geometry = coarse ? built.geometry : buildFineTerrainNow(built.field, fineFactorFor(100)).geometry;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(look.background);
    const material = createGroundMaterial({ seed: cellSeed, pattern, focus: built.focus, palette, radius: 100, ground: look.ground });
    material.userData.ground.setSea(true);
    const mesh = new THREE.Mesh(geometry, material);
    // Put the focal point (if any) on the upper-left limb.
    if (built.focus) mesh.quaternion.setFromUnitVectors(built.focus, new THREE.Vector3(-0.5, 0.6, 0.62).normalize());
    scene.add(mesh);
    setShadowFlags(mesh);
    const rig = createRig(scene, renderer);
    rig.setLook(look);
    // Fifteen small cells: a 1024 map per cell is plenty (and 15 × 2048 is not).
    rig.setQuality({ shadows: true, shadowMapSize: 1024 });
    rig.aim({ center: ORIGIN, radius: 100, sunDir: SUN_DIR, up: VIEW_UP });
    const camera = new THREE.PerspectiveCamera(35, 1, 1, 2000);
    camera.position.set(0, 0, dist);
    if (!post) { post = createPost(renderer, scene, camera); post.setLook(look); }
    const label = document.createElement('div');
    label.textContent = `${shape} · ${pattern}`;
    Object.assign(label.style, {
      position: 'absolute', color: '#f4ede0', font: '12px ui-monospace, monospace',
      letterSpacing: '0.08em', pointerEvents: 'none',
    });
    document.body.appendChild(label);
    return { scene, camera, mesh, label, i };
  });

  const layout = () => {
    renderer.setSize(innerWidth, innerHeight, false);
    const w = innerWidth / cols, h = innerHeight / rows;
    const dpr = renderer.getPixelRatio();
    post.setSize(Math.max(1, Math.round(w * dpr)), Math.max(1, Math.round(h * dpr)));
    for (const c of cells) {
      const x = (c.i % cols) * w, y = Math.floor(c.i / cols) * h;
      c.rect = { x, y: innerHeight - y - h, w, h };
      c.camera.aspect = w / h;
      c.camera.updateProjectionMatrix();
      Object.assign(c.label.style, { left: `${x + 10}px`, top: `${y + 8}px` });
    }
  };
  addEventListener('resize', layout);
  layout();

  const tick = (t) => {
    for (const c of cells) {
      if (spin) c.mesh.rotation.y = t * 0.00012;
      const { x, y, w, h } = c.rect;
      renderer.setViewport(x, y, w, h);
      renderer.setScissor(x, y, w, h);
      post.setView(c.scene, c.camera);
      post.render();
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
