// Look lab (roadmap Phase 1b). Boot with `?lookLab=1`.
//
// The art-direction bench: the five reference planets, each drawable in
// every look from src/render/Looks.js, switched live. Pick a look by eye.
//
// Query params (the page keeps them in the address bar as you click):
//   look=now|paper|sunlit|ink     which look (default paper)
//   planet=0..4                   which reference planet (default 0)
//   view=wide|photo               whole planet, or a low shot of the hero
//                                 with the look's tilt-shift on
//   shot=1                        screenshot mode: no panel, and a frame is
//                                 drawn only when something changes (software
//                                 rendering takes seconds a frame);
//                                 `window.__LAB_READY = true` once drawn
//
// Keys: 1–4 look · ←/→ planet · V view · H hide the panel.
// Drag to orbit, scroll to zoom.
// Console: `__LOOKLAB.set({ look, planet, view })` (resolves once drawn).

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { REFERENCE_PLANETS } from './galleryPlanets.js';
import { buildLabPlanet, LAB_RADIUS } from './labPlanet.js';
import { LOOKS, LOOK_ORDER, getLook } from '../render/Looks.js';
import { applyLook } from '../render/LookMaterial.js';
import { createRig } from '../render/Rig.js';
import { createPost } from '../render/Post.js';

// Sun height over the hero: low enough for long shadows and clear form.
const SUN_ZENITH_DEG = 50;

export async function runLookLab() {
  document.title = 'look lab — personal space';
  for (const el of [...document.body.children]) {
    if (el.id !== 'canvas') el.style.display = 'none';
  }
  globalThis.__GAME = globalThis.__GAME || {};
  globalThis.__GAME.debugPlacement = false;

  const params = new URLSearchParams(location.search);
  const shot = params.has('shot');
  const state = {
    look: LOOKS[params.get('look')] ? params.get('look') : 'paper',
    planet: Math.min(REFERENCE_PLANETS.length - 1, Math.max(0, parseInt(params.get('planet') || '0', 10) || 0)),
    view: params.get('view') === 'photo' ? 'photo' : 'wide',
  };

  const canvas = document.getElementById('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(50, 1, 1, 3000);
  const rig = createRig(scene, renderer);
  const post = createPost(renderer, scene, camera);

  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  const radius = LAB_RADIUS;

  // ── Planets: built on first view, then kept ─────────────────────────
  const stages = new Map();   // index → { planet, heroDir, heroPos, t1, t2, sunDir }
  async function stageFor(index) {
    if (stages.has(index)) return stages.get(index);
    const { planet } = await buildLabPlanet(REFERENCE_PLANETS[index].q, {
      rapier: RAPIER, world, renderer, serial: shot, tag: 'lookLab',
    });
    planet.group.visible = false;
    scene.add(planet.group);

    const slot = planet.heroSlot || planet.landmarks[0];
    const heroDir = slot ? slot.direction.clone().normalize() : new THREE.Vector3(0, 1, 0);
    const heroPos = slot?.position ? slot.position.clone() : heroDir.clone().multiplyScalar(radius);
    // Two fixed directions along the ground at the hero.
    const axis = Math.abs(heroDir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const t1 = axis.addScaledVector(heroDir, -axis.dot(heroDir)).normalize();
    const t2 = new THREE.Vector3().crossVectors(heroDir, t1).normalize();
    const z = THREE.MathUtils.degToRad(SUN_ZENITH_DEG);
    const sunDir = heroDir.clone().multiplyScalar(Math.cos(z)).addScaledVector(t1, Math.sin(z)).normalize();

    // How big the hero is, so the photo view can fit it in frame.
    const box = new THREE.Box3();
    planet.group.updateMatrixWorld(true);
    if (slot) {
      planet.group.traverse((o) => { if (o.userData?.slotId === slot.slotId && o !== planet.group) box.expandByObject(o); });
    }
    const heroCenter = box.isEmpty() ? heroPos.clone().addScaledVector(heroDir, radius * 0.07) : box.getCenter(new THREE.Vector3());
    const heroSize = box.isEmpty() ? radius * 0.2 : box.getSize(new THREE.Vector3()).length() * 0.5;

    const stage = { planet, heroDir, heroPos, heroCenter, heroSize, t1, t2, sunDir };
    stages.set(index, stage);
    return stage;
  }

  // ── Camera ──────────────────────────────────────────────────────────
  // wide:  orbit the planet centre (theta/phi/dist)
  // photo: orbit the hero, low and close (az/el/reach), hero's up is up
  const cam = { theta: 0, phi: 1, dist: radius * 3.1, az: 0.3, el: 0.36, reach: radius * 0.8 };
  function framePhoto(s) {
    cam.az = 0.3;
    cam.el = 0.36;
    cam.reach = THREE.MathUtils.clamp(s.heroSize * 2.3, radius * 0.4, radius * 2.4);
  }
  let stage = null;
  const _v = new THREE.Vector3();
  const _focus = new THREE.Vector3();

  function frameWide(s) {
    // Hero toward the limb, in profile; sunlit side and the edge of the
    // shade both in view.
    const v = s.heroDir.clone().multiplyScalar(0.75).addScaledVector(s.t2, 1.0).addScaledVector(s.t1, 0.25).normalize();
    cam.phi = Math.acos(THREE.MathUtils.clamp(v.y, -1, 1));
    cam.theta = Math.atan2(v.z, v.x);
    cam.dist = radius * 3.1;
  }
  function placeCamera() {
    if (!stage) return;
    if (state.view === 'photo') {
      const s = stage;
      _focus.copy(s.heroCenter);
      _v.copy(s.t2).multiplyScalar(Math.cos(cam.az)).addScaledVector(s.t1, Math.sin(cam.az));
      camera.position.copy(_focus)
        .addScaledVector(_v, cam.reach * Math.cos(cam.el))
        .addScaledVector(s.heroDir, cam.reach * Math.sin(cam.el));
      camera.up.copy(s.heroDir);
      camera.lookAt(_focus);
      rig.hemi.position.copy(s.heroDir);
    } else {
      camera.position.set(
        cam.dist * Math.sin(cam.phi) * Math.cos(cam.theta),
        cam.dist * Math.cos(cam.phi),
        cam.dist * Math.sin(cam.phi) * Math.sin(cam.theta),
      );
      camera.up.set(0, 1, 0);
      camera.lookAt(0, 0, 0);
      rig.hemi.position.copy(camera.position).normalize();
    }
  }

  let dragging = false, px = 0, py = 0;
  canvas.addEventListener('pointerdown', (e) => { dragging = true; px = e.clientX; py = e.clientY; });
  addEventListener('pointerup', () => { dragging = false; });
  addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = (e.clientX - px) * 0.005, dy = (e.clientY - py) * 0.005;
    if (state.view === 'photo') {
      cam.az -= dx;
      cam.el = THREE.MathUtils.clamp(cam.el + dy, 0.08, 1.45);
    } else {
      cam.theta += dx;
      cam.phi = THREE.MathUtils.clamp(cam.phi - dy, 0.05, Math.PI - 0.05);
    }
    px = e.clientX; py = e.clientY;
  });
  canvas.addEventListener('wheel', (e) => {
    const k = 1 + e.deltaY * 0.001;
    if (state.view === 'photo') cam.reach = THREE.MathUtils.clamp(cam.reach * k, radius * 0.2, radius * 3);
    else cam.dist = THREE.MathUtils.clamp(cam.dist * k, radius * 1.3, radius * 6);
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

  // ── Applying state ──────────────────────────────────────────────────
  let frames = 0;
  let busy = Promise.resolve();
  const afterFrames = (n) => new Promise((resolve) => {
    const target = frames + n;
    const tick = () => (frames >= target ? resolve() : requestAnimationFrame(tick));
    tick();
    // A hidden tab draws no frames; do not leave a caller waiting on one.
    // (Screenshot mode must wait: software rendering takes seconds a frame.)
    if (!shot) setTimeout(resolve, 1500);
  });

  function applyLookNow() {
    const look = getLook(state.look);
    rig.setLook(look);
    applyLook(scene, look);
    post.setLook(look);
    post.setPhoto(state.view === 'photo');
    if (!look.post) {
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.toneMappingExposure = 1;
    }
    // scene.background, not the renderer's clear colour: three converts it
    // for whichever target is being drawn (screen or the HDR buffer).
    scene.background.set(look.background);
  }

  async function apply(next = {}) {
    const planetChanged = next.planet !== undefined && next.planet !== state.planet;
    Object.assign(state, next);
    setBusy(!stages.has(state.planet));
    const s = await stageFor(state.planet);
    for (const [i, other] of stages) other.planet.group.visible = i === state.planet;
    if (stage !== s || planetChanged) { stage = s; frameWide(s); framePhoto(s); }
    rig.aim({ center: s.planet.group.position, radius, sunDir: s.sunDir, up: s.heroDir });
    applyLookNow();
    setBusy(false);
    syncPanel();
    if (!shot) {
      const q = new URLSearchParams({ lookLab: '1', look: state.look, planet: String(state.planet), view: state.view });
      history.replaceState(null, '', `?${q}`);
    }
  }
  function draw() {
    placeCamera();
    if (stage) post.render();
    frames++;
  }
  // Screenshot mode draws on demand: twice (the first frame compiles
  // shaders and fills the shadow map), then waits for the browser to show it.
  const drawnAndShown = () => {
    draw(); draw();
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  };
  // One change at a time, in order.
  const set = (next) => (busy = busy.then(() => apply(next)).then(() => (shot ? drawnAndShown() : afterFrames(3))));

  // ── Panel ───────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'looklab-panel';
  panel.style.cssText = [
    'position:fixed', 'left:16px', 'top:16px', 'z-index:10', 'max-width:340px',
    'font:13px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif', 'color:#f2efe8',
    'background:rgba(14,14,24,0.72)', 'backdrop-filter:blur(6px)', 'border:1px solid rgba(255,255,255,0.14)',
    'border-radius:10px', 'padding:12px 14px', 'user-select:none',
  ].join(';');
  if (shot) panel.style.display = 'none';
  document.body.appendChild(panel);

  const buttonCss = (on) => [
    'font:inherit', 'color:inherit', 'cursor:pointer', 'padding:5px 9px', 'margin:0 6px 6px 0',
    'border-radius:7px', `border:1px solid ${on ? '#ffd7a6' : 'rgba(255,255,255,0.22)'}`,
    `background:${on ? 'rgba(255,215,166,0.22)' : 'transparent'}`,
  ].join(';');
  function row(label, items, current, onPick) {
    const wrap = document.createElement('div');
    wrap.style.marginBottom = '6px';
    const cap = document.createElement('div');
    cap.textContent = label;
    cap.style.cssText = 'opacity:0.6;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:5px';
    wrap.appendChild(cap);
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = it.label;
      b.style.cssText = buttonCss(it.value === current);
      b.addEventListener('click', () => onPick(it.value));
      wrap.appendChild(b);
    }
    return wrap;
  }
  let busyNote = false;
  function setBusy(on) { busyNote = on; syncPanel(); }
  function syncPanel() {
    if (shot) return;
    const look = getLook(state.look);
    const ref = REFERENCE_PLANETS[state.planet];
    panel.replaceChildren(
      row('Look', LOOK_ORDER.map((id, i) => ({ value: id, label: `${i + 1} ${LOOKS[id].name}` })), state.look, (v) => set({ look: v })),
      row('Planet', REFERENCE_PLANETS.map((p, i) => ({ value: i, label: p.short })), state.planet, (v) => set({ planet: v })),
      row('View', [{ value: 'wide', label: 'Whole planet' }, { value: 'photo', label: 'Photo of the hero' }], state.view, (v) => set({ view: v })),
    );
    const blurb = document.createElement('div');
    blurb.style.cssText = 'margin-top:4px;opacity:0.9';
    blurb.textContent = busyNote ? 'Building the planet…' : look.blurb;
    const teaser = document.createElement('div');
    teaser.style.cssText = 'margin-top:6px;opacity:0.6;font-style:italic';
    teaser.textContent = `“${ref.teaser}”`;
    const keys = document.createElement('div');
    keys.style.cssText = 'margin-top:8px;opacity:0.45;font-size:11px';
    keys.textContent = '1–4 look · ←/→ planet · V view · H hide · drag to orbit · scroll to zoom';
    panel.append(blurb, teaser, keys);
  }

  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const n = REFERENCE_PLANETS.length;
    if (e.key >= '1' && e.key <= String(LOOK_ORDER.length)) set({ look: LOOK_ORDER[Number(e.key) - 1] });
    else if (e.key === 'ArrowRight') set({ planet: (state.planet + 1) % n });
    else if (e.key === 'ArrowLeft') set({ planet: (state.planet + n - 1) % n });
    else if (e.key === 'v' || e.key === 'V') set({ view: state.view === 'photo' ? 'wide' : 'photo' });
    else if (e.key === 'h' || e.key === 'H') panel.style.display = panel.style.display === 'none' ? '' : 'none';
  });

  // ── Go ──────────────────────────────────────────────────────────────
  if (!shot) renderer.setAnimationLoop(draw);

  globalThis.__LOOKLAB = { set, state, stages, rig, post, scene, camera, renderer, THREE };
  await set({});
  globalThis.__LAB_READY = true;
}
