import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

import { TUNING } from './game/Tuning.js';
import { GameLoop } from './game/GameLoop.js';
import { Input } from './game/Input.js';
import { Plane } from './game/Plane.js';
import { FlightController } from './game/FlightController.js';
import { CameraRig } from './game/CameraRig.js';

import { SolarSystem } from './world/SolarSystem.js';

import { HUD } from './ui/HUD.js';
import { Toast } from './ui/Toast.js';
import { Logbook } from './ui/Logbook.js';
import { PlanetNav } from './ui/PlanetNav.js';
import { DebugHUD } from './ui/DebugHUD.js';

import { LLMClient } from './llm/LLMClient.js';

async function main() {
  // 1. Init Rapier WASM
  await RAPIER.init();

  // 2. Three.js scene
  const canvas = document.getElementById('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.setClearColor(0x05060a);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x05060a, 0.00025);

  const camera = new THREE.PerspectiveCamera(TUNING.FOV_BASE, innerWidth / innerHeight, 0.1, 20000);

  // Lights. Tuned for "no truly dark side" — even when the planet is between
  // the player and the sun, surface remains readable.
  const sunLight = new THREE.DirectionalLight(0xfff2d6, 0.75);
  sunLight.position.set(220, 180, 120);
  scene.add(sunLight);
  const fill = new THREE.DirectionalLight(0xcbd9ff, 0.45);
  fill.position.set(-220, -120, -150);
  scene.add(fill);
  scene.add(new THREE.HemisphereLight(0xc4dcff, 0x6b573d, 0.95));
  scene.add(new THREE.AmbientLight(0xffffff, 0.25));

  // 3. Rapier world (no global gravity — we apply our own per-frame radial pull)
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  const eventQueue = new RAPIER.EventQueue(true);

  // 4. Build solar system (sun + 3–6 planets, each with atmosphere + landing pad)
  const system = new SolarSystem({
    rapier: RAPIER,
    world,
    seed: TUNING.PLANET_SEED,
  });
  scene.add(system.group);

  // 5. Plane — spawn outside the first planet's atmosphere, aimed for a
  // tangential approach so atmosphere entry carries lateral velocity.
  const plane = new Plane({ rapier: RAPIER, world });
  const { pos: spawnPos, fwd: spawnFwd } = system.defaultSpawn();
  plane.spawn(spawnPos, spawnFwd, TUNING.CRUISE_SPEED);
  scene.add(plane.group);

  camera.position.copy(spawnPos.clone().addScaledVector(spawnFwd, -14)).add(new THREE.Vector3(0, 1.8, 0));

  // 6. Flight + camera
  const input = new Input();
  const flight = new FlightController({ rapier: RAPIER });
  const cameraRig = new CameraRig({ camera });

  // 7. UI
  const toast = new Toast();
  const hud = new HUD();
  const logbook = new Logbook();
  const debugHUD = new DebugHUD();
  const planetNav = new PlanetNav(canvas);

  // Track every planet in the system. Color is shared for now; Task 14 will
  // color-vary and gate by Tier 1 ping completion.
  for (let i = 0; i < system.planets.length; i++) {
    const p = system.planets[i];
    planetNav.track(`planet:${i}`, {
      object: p.group,
      label: (p.meta?.name || `P${i + 1}`).toUpperCase(),
      color: i === 0 ? '#ff6f3c' : '#9ec8ff',
      getDistance: () => Math.max(0, plane.position().distanceTo(p.center) - p.radius),
    });
  }

  // Per-planet landing-pad nav indicators. Each pad is gated to "only show
  // when the plane is in *that* planet's atmosphere" — keeps the screen clean
  // since only the planet you're currently in is actionable for landing.
  for (let i = 0; i < system.planets.length; i++) {
    const p = system.planets[i];
    const atm = system.atmospheres[i];
    const proxy = new THREE.Object3D();
    proxy.position.copy(p.landingZone.worldPosition());
    scene.add(proxy);
    planetNav.track(`pad:${i}`, {
      object: proxy,
      label: 'LANDING',
      color: '#ffd66b',
      getDistance: () => p.landingZone.distanceFrom(plane.position()),
      visible: () => atm.contains(plane.position()),
    });
  }

  // 8. LLM client (with offline fallback)
  const workerURL = (new URLSearchParams(location.search)).get('worker')
    || localStorage.getItem('paper-airplane:worker')
    || import.meta.env.VITE_WORKER_URL
    || '';
  const llm = new LLMClient({ workerURL });

  // Resolve initial active planet/atmosphere from spawn position.
  let { planet: activePlanet, atmosphere: activeAtmosphere } = system.activePlanetFor(plane.position());

  // Crossings
  let prevInside = activeAtmosphere.contains(plane.position());
  let prevActivePlanet = activePlanet;
  let crashRespawnAt = 0;

  hud.setState(prevInside ? 'IN ATMOSPHERE' : 'IN SPACE');

  // --- LLM naming: per-planet pings + commitment-gated approach. ---
  //
  // pings[i] mirrors what's shown for planet i in the HUD #pings strip. Slot
  // is filled when Tier 1 resolves; the `name` field is overwritten when
  // Tier 2 names the planet. `approachSent[i]` deduplicates the per-step
  // approach test so we only fire once per planet per session.
  const sunCss = `#${system.sunColor.getHexString()}`;
  const pings = new Array(system.planets.length).fill(null);
  const approachSent = new Array(system.planets.length).fill(false);

  const refreshPings = () => hud.setPings(pings.filter(Boolean));

  for (let i = 0; i < system.planets.length; i++) {
    const p = system.planets[i];
    llm.ping(p.seed, { starColor: sunCss }).then(r => {
      if (!r?.teaser) return;
      pings[i] = { name: p.meta?.name?.toUpperCase() || `P${i + 1}`, teaser: r.teaser };
      refreshPings();
    }).catch(() => {});
  }

  const tryApproach = (i) => {
    if (approachSent[i]) return;
    approachSent[i] = true;
    const p = system.planets[i];
    llm.approach(p.seed, { radius: p.radius }).then(meta => {
      if (!meta) return;
      p.applyLLM(meta);
      const label = (meta.name || `P${i + 1}`).toUpperCase();
      planetNav.setLabel(`planet:${i}`, label);
      if (pings[i]) {
        pings[i].name = label;
        refreshPings();
      }
      if (p === activePlanet) hud.setPlanetName(meta.name);
    }).catch(() => { approachSent[i] = false; /* allow retry on real failure */ });
  };

  // 9. Resize
  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight, false);
  });

  // 10. Loop
  const loop = new GameLoop({
    stepHz: 60,
    onFixedStep: (dt) => {
      const ev = input.drain();

      if (ev.logbookEdge) logbook.toggle();
      if (ev.resetEdge) {
        plane.spawn(spawnPos, spawnFwd, TUNING.CRUISE_SPEED);
        flight.reset();
        const a = system.activePlanetFor(plane.position());
        activePlanet = a.planet;
        activeAtmosphere = a.atmosphere;
        prevInside = activeAtmosphere.contains(plane.position());
        prevActivePlanet = activePlanet;
        // Don't clear pad-claim flags on reset — claims are sticky per session.
        crashRespawnAt = 0;
      }

      // Auto-respawn after crash. Respawn high above the crash site on a
      // clean tangential approach above the *active* planet (whichever we
      // crashed into).
      if (crashRespawnAt && performance.now() / 1000 >= crashRespawnAt) {
        const crashPoint = plane.position().clone();
        const radialOut = crashPoint.clone().sub(activePlanet.center).normalize();
        if (radialOut.lengthSq() < 1e-3) radialOut.set(1, 0, 0);
        const safeAlt = TUNING.ATM_TOP + 30;
        const respawnPos = activePlanet.center.clone().add(
          radialOut.clone().multiplyScalar(activePlanet.radius + safeAlt)
        );
        let respawnFwd = plane.lastSafeFwd.clone();
        respawnFwd.sub(radialOut.clone().multiplyScalar(respawnFwd.dot(radialOut)));
        if (respawnFwd.lengthSq() < 0.05) {
          respawnFwd.crossVectors(radialOut, new THREE.Vector3(0, 1, 0));
          if (respawnFwd.lengthSq() < 1e-3) respawnFwd.set(0, 0, 1);
        }
        respawnFwd.normalize();
        plane.respawnAt(respawnPos, respawnFwd, TUNING.CRUISE_SPEED);
        flight.reset();
        crashRespawnAt = 0;
        toast.show('RESPAWN', 1000, '#ffd86b');
        const a = system.activePlanetFor(plane.position());
        activePlanet = a.planet;
        activeAtmosphere = a.atmosphere;
        prevInside = activeAtmosphere.contains(plane.position());
        prevActivePlanet = activePlanet;
      }

      // Safety: if the plane has clipped *inside* the active planet (tunneling,
      // edge cases), bounce it back out to a safe altitude.
      {
        const planePos = plane.position();
        const distFromCenter = planePos.distanceTo(activePlanet.center);
        if (distFromCenter < activePlanet.radius - 2 && plane.state !== 'crashed') {
          const radialOut = planePos.clone().sub(activePlanet.center).normalize();
          if (radialOut.lengthSq() < 1e-3) radialOut.set(1, 0, 0);
          const recoverPos = activePlanet.center.clone().add(
            radialOut.clone().multiplyScalar(activePlanet.radius + 100)
          );
          let fwdRecover = new THREE.Vector3();
          fwdRecover.crossVectors(radialOut, new THREE.Vector3(0, 1, 0));
          if (fwdRecover.lengthSq() < 1e-3) fwdRecover.set(0, 0, 1);
          fwdRecover.normalize();
          plane.respawnAt(recoverPos, fwdRecover, TUNING.CRUISE_SPEED);
          flight.reset();
          toast.show('RECOVERED', 1000, '#ffd86b');
        }
      }

      // Resolve the currently-active planet (whichever one's atmosphere we're
      // in, else the closest one). All subsequent per-frame logic uses this.
      {
        const a = system.activePlanetFor(plane.position());
        activePlanet = a.planet;
        activeAtmosphere = a.atmosphere;
      }

      // Commitment-gated Tier 2 (approach). Fire once per planet when the
      // player either enters its atmosphere or is clearly headed at it from
      // close enough. `applyLLM` is idempotent; the gate keeps us from
      // spamming the worker on every frame.
      {
        const planePos = plane.position();
        const planeFwd = plane.forward();
        for (let i = 0; i < system.planets.length; i++) {
          if (approachSent[i]) continue;
          const p = system.planets[i];
          if (system.atmospheres[i].contains(planePos)) { tryApproach(i); continue; }
          const toPlanet = p.center.clone().sub(planePos);
          const distance = toPlanet.length();
          if (distance > p.radius + TUNING.APPROACH_DISTANCE) continue;
          toPlanet.divideScalar(distance || 1);
          if (planeFwd.dot(toPlanet) >= TUNING.APPROACH_DOT) tryApproach(i);
        }
      }

      // Physics + flight
      const planeRho = activeAtmosphere.density(plane.position());
      flight.update(plane, ev, dt, activeAtmosphere, activePlanet);

      world.step(eventQueue);

      // Process collision events. Look up which planet's collider was hit so
      // we can compute the correct radial normal and crash respawn point.
      eventQueue.drainCollisionEvents((h1, h2, started) => {
        if (!started) return;
        if (h1 !== plane.collider.handle && h2 !== plane.collider.handle) return;
        if (plane.state === 'crashed' || plane.state === 'grounded') return;
        const otherHandle = h1 === plane.collider.handle ? h2 : h1;
        const hit = system.planetForColliderHandle(otherHandle);
        if (!hit) return;
        const v = plane.velocity();
        const radialUp = plane.position().clone().sub(hit.planet.center).normalize();
        const vNormal = Math.abs(v.dot(radialUp));
        const planeUp = plane.up();
        const align = planeUp.dot(radialUp);
        if (vNormal > TUNING.COLLISION_HARD) {
          toast.show('CRASHED', 1200, '#ff5b3c');
          plane.crash();
          crashRespawnAt = performance.now() / 1000 + TUNING.RESPAWN_DELAY;
        } else if (vNormal < TUNING.COLLISION_SOFT && align > 0.6) {
          plane.land();
        } else {
          plane.bumpImpact(vNormal);
        }
      });

      // Atmosphere crossings (visual + Tier 3 prefetch). Trigger when:
      //   - same planet, inside flag flipped, OR
      //   - active planet changed (exit prev's atmosphere, enter new one).
      const insideNow = activeAtmosphere.contains(plane.position());
      const planetChanged = activePlanet !== prevActivePlanet;
      if (planetChanged) {
        if (prevInside) {
          toast.flash();
          toast.show('↑ ENTERING SPACE ↑', 1500);
        }
        if (insideNow) {
          toast.flash();
          toast.show('↓ ENTERING ATMOSPHERE ↓', 1500);
          llm.land(activePlanet.seed, {
            name: activePlanet.meta?.name,
            biome: activePlanet.meta?.biome,
            landmarks: activePlanet.meta?.landmarks,
          }).catch(() => {});
        }
      } else if (insideNow !== prevInside) {
        toast.flash();
        if (insideNow) {
          toast.show('↓ ENTERING ATMOSPHERE ↓', 1500);
          llm.land(activePlanet.seed, {
            name: activePlanet.meta?.name,
            biome: activePlanet.meta?.biome,
            landmarks: activePlanet.meta?.landmarks,
          }).catch(() => {});
        } else {
          toast.show('↑ ENTERING SPACE ↑', 1500);
        }
      }
      if (planetChanged) hud.setPlanetName(activePlanet.meta?.name || null);
      prevInside = insideNow;
      prevActivePlanet = activePlanet;

      // Landing-pad claim — check every planet's zone, since the player can
      // visit any of them. Fires once per planet per session.
      for (const p of system.planets) {
        if (p.landingZone.claimed) continue;
        if (!p.landingZone.isLanded(plane)) continue;
        p.landingZone.markClaimed();
        const name = p.meta?.name || `Unnamed-${p.seed}`;
        toast.show(`${name.toUpperCase()} · CLAIMED`, 2200, '#ffd66b');
        logbook.add({
          seed: p.seed,
          name,
          biome: p.meta?.biome || 'unknown',
          palette: p.meta?.palette || null,
          landmarks: p.meta?.landmarks || [],
          visitedAt: Date.now(),
        });
        llm.land(p.seed, {
          name: p.meta?.name,
          biome: p.meta?.biome,
          landmarks: p.meta?.landmarks,
        }).then(lore => {
          if (lore?.surfaceLore) hud.setLandmark(lore.surfaceLore);
        }).catch(() => {});
      }

      // Update HUD
      hud.setSpeed(plane.velocity().length());
      hud.setAltitude(plane.altitudeAboveTerrain(activePlanet));
      hud.setAtmos(planeRho);
      hud.setState(plane.state);

      // Camera follows
      cameraRig.update(plane, activePlanet, activeAtmosphere, dt);

      // Navigation indicators
      planetNav.update(camera, plane);

      // Debug telemetry overlay — uses the live Input state (post-drain)
      debugHUD.update(plane, activePlanet, activeAtmosphere, input, flight);
    },

    onRender: (dt) => {
      // Atmosphere shader breathes with player altitude
      activeAtmosphere.tick(plane.position(), camera);
      // Sky color blend (sun tint near the surface)
      const r = activeAtmosphere.density(plane.position());
      const skyA = new THREE.Color(0x04060c);
      const skyB = new THREE.Color(0x8bb8dc).lerp(system.sunColor, 0.25);
      scene.background = null;
      renderer.setClearColor(new THREE.Color().lerpColors(skyA, skyB, r), 1.0);
      scene.fog.density = 0.00018 * r + 0.00004;
      renderer.render(scene, camera);
    },
  });

  // Pause menu. Handled independently of the input/fixed-step path so it
  // works while the simulation is frozen. Draining input on resume keeps a
  // stale Escape edge from firing the moment the game ticks again.
  const pauseMenu = document.getElementById('pause-menu');
  const resumeBtn = document.getElementById('resume-btn');
  let paused = false;
  const setPaused = (next) => {
    if (paused === next) return;
    paused = next;
    loop.setPaused(paused);
    pauseMenu.classList.toggle('show', paused);
    if (!paused) input.drain();
  };
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Escape') return;
    e.preventDefault();
    setPaused(!paused);
  });
  if (resumeBtn) resumeBtn.addEventListener('click', () => setPaused(false));

  // Done bootstrapping
  document.getElementById('boot').classList.add('hidden');

  // Debug hooks
  window.__GAME = {
    plane, system, flight, cameraRig,
    get planet() { return activePlanet; },
    get atmosphere() { return activeAtmosphere; },
    inspect() {
      const v = plane.velocity();
      const f = plane.forward();
      const p = plane.position();
      const rho = activeAtmosphere.density(p);
      const av = plane.body.angvel();
      return {
        pos: { x: p.x.toFixed(2), y: p.y.toFixed(2), z: p.z.toFixed(2) },
        vel: { x: v.x.toFixed(2), y: v.y.toFixed(2), z: v.z.toFixed(2), mag: v.length().toFixed(2) },
        fwd: { x: f.x.toFixed(3), y: f.y.toFixed(3), z: f.z.toFixed(3) },
        angvel: { x: av.x.toFixed(2), y: av.y.toFixed(2), z: av.z.toFixed(2) },
        rho: rho.toFixed(3),
        throttleBoost: flight.throttleBoost.toFixed(2),
        state: plane.state,
        mass: plane.mass.toFixed(4),
        I: plane.angularInertia.toFixed(5),
        activePlanetSeed: activePlanet.seed,
        activePlanetIdx: system.planets.indexOf(activePlanet),
      };
    },
    snapshot() {
      plane.spawn(spawnPos, spawnFwd, TUNING.CRUISE_SPEED);
      flight.reset();
      return 'spawned';
    },
  };

  loop.start();
}

main().catch(err => {
  console.error('Boot failure', err);
  const boot = document.getElementById('boot');
  if (boot) { boot.textContent = 'BOOT ERROR — see console'; }
});
