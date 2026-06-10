// Contact-sheet audit tool (Phase 13a). Boot with `?contactSheet=1`.
//
// Renders the asset catalog as a paged grid — every asset standing on a 1m
// ground grid, mounted EXACTLY as the game would mount it (per-pack axis-up
// correction + bbox ground-snap), with its local bbox and origin axes drawn.
// This is the tool that populates `PACK_AXIS_UP` (AxisUp.js) and per-asset
// `axis_override` entries in catalog.source.json, and the regression sheet
// to re-eyeball after any orientation/scale change.
//
// Toolbar:
//   - pack filter + page nav
//   - RAW toggle: bypass axis-up + ground-snap to see the GLB as authored
//   - suspects-first: sort flagged assets (likely Z-up / off-center pivot)
//     to the front of the page ordering
//   - click a cell to cycle a mark (Z-up → pivot → clear); COPY MARKS emits
//     a paste-ready JSON snippet grouped by pack.
//
// One renderer, one canvas, scissored per visible cell (the standard
// three.js multiple-elements pattern) — 24 live WebGL views per page.

import * as THREE from 'three';
import { load as loadGLB } from '../world/AssetCache.js';
import { allAssets } from '../world/assets/Catalog.js';
import { axisUpQuaternionFor, groundOffsetFor, lateralCenterFor } from '../world/AxisUp.js';

const PAGE_SIZE = 24;
// Tags that imply "taller than deep" — if the bbox says otherwise, the
// asset is probably Z-up-authored and lying on its face.
const TALL_TAGS = new Set(['tower', 'tree', 'spire', 'ship', 'windmill', 'rocket', 'pine', 'birch', 'palm', 'lighthouse', 'crane', 'antenna', 'obelisk', 'statue', 'gravestone', 'crypt', 'arch']);

export async function runContactSheet() {
  document.title = 'contact sheet — personal space';
  // Hide the game's static DOM (boot text, HUD scaffolding); we own the page.
  for (const el of [...document.body.children]) {
    if (el.id !== 'canvas') el.style.display = 'none';
  }

  const canvas = document.getElementById('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setScissorTest(true);
  renderer.setClearColor(0x101218);

  const ui = buildDOM();
  const assets = allAssets();
  const packs = [...new Set(assets.map((a) => a.pack))].sort();
  for (const p of ['all', ...packs]) {
    const opt = document.createElement('option');
    opt.value = p; opt.textContent = p;
    ui.packSel.appendChild(opt);
  }

  // ── State ──────────────────────────────────────────────────────────
  const params = new URLSearchParams(location.search);
  let pack = params.get('pack') && packs.includes(params.get('pack')) ? params.get('pack') : 'all';
  let page = Math.max(0, parseInt(params.get('page') || '0', 10) || 0);
  let raw = false;
  let suspectsFirst = false;
  const marks = new Map();          // asset id → 'Z' | 'pivot'
  const suspicion = new Map();      // asset id → string[] flags (filled post-load)
  let cells = [];                   // live per-cell render state

  ui.packSel.value = pack;
  ui.packSel.onchange = () => { pack = ui.packSel.value; page = 0; rebuild(); };
  ui.prev.onclick = () => { if (page > 0) { page--; rebuild(); } };
  ui.next.onclick = () => { page++; rebuild(); };
  ui.rawBtn.onclick = () => { raw = !raw; ui.rawBtn.classList.toggle('on', raw); rebuild(); };
  ui.suspBtn.onclick = () => { suspectsFirst = !suspectsFirst; ui.suspBtn.classList.toggle('on', suspectsFirst); rebuild(); };
  ui.copyBtn.onclick = () => {
    const byPack = {};
    for (const [id, mark] of marks) {
      const p = id.split(':')[0] + ':' + id.split(':')[1];
      (byPack[p] ||= {})[id] = mark;
    }
    const text = JSON.stringify(byPack, null, 2);
    navigator.clipboard?.writeText(text);
    console.log('[contactSheet] marks:\n' + text);
    ui.copyBtn.textContent = `COPIED ${marks.size}`;
    setTimeout(() => { ui.copyBtn.textContent = 'COPY MARKS'; }, 1200);
  };

  function filtered() {
    let list = pack === 'all' ? assets : assets.filter((a) => a.pack === pack);
    if (suspectsFirst) {
      list = [...list].sort((a, b) => (suspicion.get(b.id)?.length || 0) - (suspicion.get(a.id)?.length || 0));
    }
    return list;
  }

  // ── Page (re)build ─────────────────────────────────────────────────
  async function rebuild() {
    const list = filtered();
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    page = Math.min(page, pages - 1);
    ui.pageLabel.textContent = `${page + 1}/${pages} · ${list.length} assets`;

    for (const c of cells) disposeCell(c);
    cells = [];
    ui.grid.innerHTML = '';

    const slice = list.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    await Promise.all(slice.map(async (asset) => {
      const cell = makeCell(asset);
      ui.grid.appendChild(cell.el);
      cells.push(cell);
      try {
        const gltf = await loadGLB(asset.url, renderer);
        if (!cell.el.isConnected) return;   // page flipped while loading
        mountAsset(cell, asset, gltf);
      } catch (err) {
        cell.label.textContent += ' — LOAD FAILED';
        cell.el.classList.add('failed');
        console.warn('[contactSheet]', asset.id, err.message);
      }
    }));
  }

  function makeCell(asset) {
    const el = document.createElement('div');
    el.className = 'cs-cell';
    const label = document.createElement('div');
    label.className = 'cs-label';
    label.textContent = asset.id;
    const badge = document.createElement('div');
    badge.className = 'cs-badge';
    el.appendChild(label);
    el.appendChild(badge);

    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xeef2ff, 0x3a3326, 1.1));
    const dir = new THREE.DirectionalLight(0xfff2d6, 1.6);
    dir.position.set(3, 5, 2);
    scene.add(dir);
    scene.add(new THREE.GridHelper(2, 8, 0x5a657a, 0x39404f));

    const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 100);

    const cell = { el, label, badge, scene, camera, asset, root: null };
    el.onclick = () => {
      const cur = marks.get(asset.id);
      const nextMark = cur === 'Z' ? 'pivot' : cur === 'pivot' ? null : 'Z';
      if (nextMark) marks.set(asset.id, nextMark); else marks.delete(asset.id);
      el.dataset.mark = nextMark || '';
      ui.markCount.textContent = marks.size ? `${marks.size} marked` : '';
    };
    el.dataset.mark = marks.get(asset.id) || '';
    return cell;
  }

  function mountAsset(cell, asset, gltf) {
    // Same bbox-caching contract as AssetCache.loadInstance.
    if (!gltf.scene.userData.bbox) {
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.userData.bbox = new THREE.Box3().setFromObject(gltf.scene);
    }
    const bbox = gltf.scene.userData.bbox;
    const root = gltf.scene.clone(true);

    // Suspicion heuristics on the authored (pre-correction) bbox.
    const size = bbox.getSize(new THREE.Vector3());
    const center = bbox.getCenter(new THREE.Vector3());
    const flags = [];
    const tagged = (asset.tags || []).some((t) => TALL_TAGS.has(t));
    if (size.z > size.y * 1.5 && tagged) flags.push('Z-up?');
    const lateral = Math.hypot(center.x, center.z);
    if (lateral > Math.max(size.x, size.z) * 0.25) flags.push('pivot?');
    suspicion.set(asset.id, flags);
    cell.badge.textContent = flags.join(' ');
    cell.el.classList.toggle('suspect', flags.length > 0);

    // Mount exactly as the game does (Landmarks.buildLandmarkInstance):
    // axis-up correction, then ground-snap along +Y by the bbox offset.
    // Display scale normalizes the LARGEST dimension to ~1.4m so every
    // asset fits the cell — orientation/pivot read the same at any scale.
    const s = 1.4 / Math.max(size.x, size.y, size.z, 0.001);
    root.scale.setScalar(s);
    if (!raw) {
      // Mirror the game mount exactly: axis-up, signed ground-snap, and
      // corner-pivot lateral recenter (Landmarks.buildLandmarkInstance).
      root.quaternion.copy(axisUpQuaternionFor(asset.pack, asset));
      root.position.y = groundOffsetFor(bbox, asset.pack, asset) * s;
      root.position.add(
        lateralCenterFor(bbox, asset.pack, asset).multiplyScalar(s).applyQuaternion(root.quaternion)
      );
    }
    cell.scene.add(root);
    cell.root = root;

    // Helpers: local bbox + origin axes, drawn through geometry.
    const boxHelper = new THREE.Box3Helper(bbox.clone(), 0xffe24a);
    boxHelper.material.depthTest = false;
    root.add(boxHelper);
    const axes = new THREE.AxesHelper(Math.max(0.6, size.length() * 0.4));
    if (axes.material) axes.material.depthTest = false;
    root.add(axes);

    // Frame the camera on the corrected world-space extent of the MODEL
    // meshes only — the axes/bbox helpers hang around the (recentered,
    // possibly distant) root origin and would drag the framing off-model.
    root.updateMatrixWorld(true);
    const worldBox = new THREE.Box3();
    let hasMesh = false;
    root.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
      hasMesh ? worldBox.union(b) : worldBox.copy(b);
      hasMesh = true;
    });
    if (!hasMesh) worldBox.setFromObject(root);
    const wSize = worldBox.getSize(new THREE.Vector3());
    const wCenter = worldBox.getCenter(new THREE.Vector3());
    const dist = Math.max(wSize.x, wSize.y, wSize.z) * 1.9 + 0.6;
    cell.camDist = dist;
    cell.camTarget = wCenter;
  }

  function disposeCell(cell) {
    cell.scene.traverse((o) => {
      // Geometry/materials of GLB clones are shared with the loader cache —
      // dispose only helper-owned resources (helpers own their own geometry).
      if (o.isLineSegments || o.isLine) {
        o.geometry?.dispose();
        o.material?.dispose();
      }
    });
  }

  // ── Render loop: scissor per visible cell, shared slow orbit ────────
  function resize() {
    renderer.setSize(innerWidth, innerHeight, false);
  }
  addEventListener('resize', resize);
  resize();

  renderer.setAnimationLoop((t) => {
    renderer.setScissor(0, 0, innerWidth, innerHeight);
    renderer.setViewport(0, 0, innerWidth, innerHeight);
    renderer.clear();
    const angle = (t / 1000) * 0.4;
    for (const cell of cells) {
      const r = cell.el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || r.width === 0) continue;
      const target = cell.camTarget || new THREE.Vector3(0, 0.5, 0);
      const dist = cell.camDist || 3;
      cell.camera.position.set(
        target.x + Math.cos(angle) * dist,
        target.y + dist * 0.55,
        target.z + Math.sin(angle) * dist
      );
      cell.camera.lookAt(target);
      cell.camera.aspect = r.width / r.height;
      cell.camera.updateProjectionMatrix();
      // DOM rect → GL coords (origin bottom-left).
      const y = innerHeight - r.bottom;
      renderer.setScissor(r.left, y, r.width, r.height);
      renderer.setViewport(r.left, y, r.width, r.height);
      renderer.render(cell.scene, cell.camera);
    }
  });

  await rebuild();

  // Console access for poking at cells (and automated verification).
  globalThis.__SHEET = { get cells() { return cells; }, THREE };
}

function buildDOM() {
  const style = document.createElement('style');
  style.textContent = `
    body { margin: 0; background: #101218; font-family: ui-monospace, Menlo, monospace; }
    #canvas { position: fixed; inset: 0; width: 100vw; height: 100vh; display: block; }
    .cs-toolbar { position: fixed; top: 0; left: 0; right: 0; z-index: 10; display: flex; gap: 8px;
      align-items: center; padding: 8px 12px; background: #181b24; color: #cfd6e4; font-size: 12px;
      border-bottom: 1px solid #2a2f3d; }
    .cs-toolbar select, .cs-toolbar button { background: #232836; color: #cfd6e4; border: 1px solid #39404f;
      font: inherit; padding: 3px 8px; cursor: pointer; }
    .cs-toolbar button.on { background: #3d72d9; color: #fff; }
    .cs-grid { position: absolute; top: 42px; left: 0; right: 0; z-index: 5; display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 6px; padding: 6px; }
    .cs-cell { position: relative; aspect-ratio: 1; border: 1px solid #2a2f3d; cursor: pointer; }
    .cs-cell.suspect { border-color: #b8862a; }
    .cs-cell.failed { border-color: #b83a2a; }
    .cs-cell[data-mark="Z"] { border: 2px solid #d94f3d; }
    .cs-cell[data-mark="pivot"] { border: 2px solid #b13dd9; }
    .cs-cell::after { content: attr(data-mark); position: absolute; top: 4px; right: 6px;
      color: #ff8a75; font-size: 11px; }
    .cs-label { position: absolute; bottom: 0; left: 0; right: 0; padding: 3px 6px; font-size: 10px;
      color: #aab3c5; background: rgba(16, 18, 24, 0.75); overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; pointer-events: none; }
    .cs-badge { position: absolute; top: 4px; left: 6px; font-size: 11px; color: #ffd24a; pointer-events: none; }
  `;
  document.head.appendChild(style);

  const bar = document.createElement('div');
  bar.className = 'cs-toolbar';
  bar.innerHTML = `
    <strong>CONTACT SHEET</strong>
    <select data-id="pack"></select>
    <button data-id="prev">◀</button>
    <span data-id="pageLabel"></span>
    <button data-id="next">▶</button>
    <button data-id="raw" title="show GLB as authored (no axis-up, no ground-snap)">RAW</button>
    <button data-id="susp" title="sort flagged assets first">SUSPECTS FIRST</button>
    <button data-id="copy">COPY MARKS</button>
    <span data-id="markCount"></span>
    <span style="margin-left:auto; color:#6b7487">click cell: mark Z-up → pivot → clear</span>
  `;
  document.body.appendChild(bar);

  const grid = document.createElement('div');
  grid.className = 'cs-grid';
  document.body.appendChild(grid);

  const q = (id) => bar.querySelector(`[data-id="${id}"]`);
  return {
    grid,
    packSel: q('pack'), prev: q('prev'), next: q('next'), pageLabel: q('pageLabel'),
    rawBtn: q('raw'), suspBtn: q('susp'), copyBtn: q('copy'), markCount: q('markCount'),
  };
}
