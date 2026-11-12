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

import * as THREE from 'three';
import { buildPlanetGeometry } from '../world/TerrainGen.js';
import { TERRAIN_SHAPES, GROUND_PATTERNS } from '../world/TerrainShapes.js';

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
  renderer.setClearColor(0x0b0d14);
  renderer.setScissorTest(true);

  const cols = 5;
  const rows = Math.ceil(TERRAIN_SHAPES.length / cols);
  const cells = TERRAIN_SHAPES.map((shape, i) => {
    const pattern = forcedPattern || GROUND_PATTERNS[i % GROUND_PATTERNS.length];
    const built = buildPlanetGeometry({ seed: seed + i * 7919, radius: 100, palette, shape, pattern, seaLevelQuantile: 0.3 });
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(built.geometry, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    // Put the focal point (if any) on the upper-left limb.
    if (built.focus) mesh.quaternion.setFromUnitVectors(built.focus, new THREE.Vector3(-0.5, 0.6, 0.62).normalize());
    scene.add(mesh);
    const sun = new THREE.DirectionalLight(0xfff2d6, 3.4);
    sun.position.set(-3, 2, 1.5);
    scene.add(sun);
    scene.add(new THREE.HemisphereLight(0xc4dcff, 0x4a3d2c, 0.7));
    const camera = new THREE.PerspectiveCamera(35, 1, 1, 2000);
    camera.position.set(0, 0, 420);
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
      renderer.render(c.scene, c.camera);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
