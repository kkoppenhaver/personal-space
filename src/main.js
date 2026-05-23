import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

import { TUNING } from './game/Tuning.js';
import { GameLoop } from './game/GameLoop.js';
import { Input } from './game/Input.js';
import { Plane } from './game/Plane.js';
import { FlightController } from './game/FlightController.js';
import { CameraRig } from './game/CameraRig.js';

import { Galaxy, CELL_SIZE } from './world/Galaxy.js';
import { Origin } from './world/Origin.js';
import { hashString } from './world/Seed.js';
import { API_BASE, apiPost } from './net/api.js';
import { loadInstance as loadAssetInstance } from './world/AssetCache.js';
import { buildMaterialSet } from './world/MaterialSet.js';
import { preload as preloadRetriever, shortlist as retrieverShortlist, isReady as retrieverIsReady } from './world/AssetRetriever.js';

import { HUD } from './ui/HUD.js';
import { Toast } from './ui/Toast.js';
import { Logbook } from './ui/Logbook.js';
import { PlanetNav } from './ui/PlanetNav.js';
import { DebugHUD } from './ui/DebugHUD.js';

import { LLMClient } from './llm/LLMClient.js';

import { AuthClient } from './auth/AuthClient.js';
import { Upsell } from './auth/Upsell.js';
import { AuthModal } from './ui/AuthModal.js';
import { WelcomeModal } from './ui/WelcomeModal.js';
import { AccountDrawer } from './ui/AccountDrawer.js';
import { LogbookStore } from './logbook/LogbookStore.js';
import { LogbookSync, patchEntryRemote } from './logbook/LogbookSync.js';
import { migrateLocalStorageIfNeeded } from './logbook/migrate.js';
import { ThumbnailCapture } from './logbook/ThumbnailCapture.js';
import { FlightStats } from './game/FlightStats.js';

// Validate a server-returned saved position. Returns null for missing,
// malformed, or non-finite data so we fall through to the default home spawn.
function readSavedPosition(saved) {
  if (!saved || !Array.isArray(saved.pos) || !Array.isArray(saved.fwd)) return null;
  if (saved.pos.length !== 3 || saved.fwd.length !== 3) return null;
  const all = [...saved.pos, ...saved.fwd];
  if (!all.every(Number.isFinite)) return null;
  return saved;
}

// Galaxy-space cell key, matching Galaxy._cellKeyOf semantics.
function cellKeyOf(pos) {
  return `${Math.floor(pos[0] / CELL_SIZE)},${Math.floor(pos[1] / CELL_SIZE)},${Math.floor(pos[2] / CELL_SIZE)}`;
}

async function main() {
  // 1. Init Rapier WASM
  await RAPIER.init();

  // 2. Three.js scene
  const canvas = document.getElementById('canvas');
  // preserveDrawingBuffer enables the thumbnail-capture fallback path:
  // ThumbnailCapture renders to an offscreen target normally, but if that
  // ever fails we can read pixels out of the live canvas instead. The
  // documented perf cost is small at our scene complexity.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
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

  // Floating-origin tracker. Once the plane drifts past threshold, every world
  // body shifts together to keep render coords near (0,0,0).
  const origin = new Origin();

  // 4. Plane allocation (spawn deferred — needs galaxy.defaultSpawn() below)
  const plane = new Plane({ rapier: RAPIER, world });
  scene.add(plane.group);

  // 5. Flight + camera
  const input = new Input();
  const flight = new FlightController({ rapier: RAPIER });
  const cameraRig = new CameraRig({ camera });

  // 6. Auth + logbook store (cloud-backed; bootstraps in background).
  // Defensive: a broken IDB (incognito, quota) shouldn't block boot.
  const auth = new AuthClient();
  const logbookStore = new LogbookStore();
  try {
    await logbookStore.resetTransientSyncing();
    await migrateLocalStorageIfNeeded(logbookStore);
  } catch (e) {
    console.warn('logbook IDB unavailable; entries will not persist:', e);
  }
  const logbookSync = new LogbookSync({ store: logbookStore, auth });
  // Block on auth bootstrap so the player's galaxy seed (derived from user.id)
  // is known before we construct the Galaxy below. Bootstrap is designed to
  // resolve in <800ms and never throw — on network failure it sets online=false
  // and continues with user=null, so we fall back to TUNING.PLANET_SEED.
  await auth.bootstrap();
  logbookSync.start();
  const galaxySeed = auth.user?.id ? hashString(auth.user.id) : TUNING.PLANET_SEED;

  // If the user has a saved position, set origin.galaxyOrigin BEFORE building
  // Galaxy so the home cell — and every subsequent streamed cell — is placed
  // relative to where the plane will spawn (render 0,0,0).
  const savedPosition = readSavedPosition(auth.user?.last_position);
  if (savedPosition) {
    origin.galaxyOrigin.set(savedPosition.pos[0], savedPosition.pos[1], savedPosition.pos[2]);
  }

  // 7. UI
  const toast = new Toast();
  const hud = new HUD();
  const logbook = new Logbook({ store: logbookStore, sync: logbookSync });
  const debugHUD = new DebugHUD();
  const planetNav = new PlanetNav(canvas);

  // 7b. Per-attempt flight stats (top speed, time-to-land, crashes, distance).
  // Reset on spawn/respawn; captured at claim time.
  const flightStats = new FlightStats();
  const thumbnailCapture = new ThumbnailCapture({ renderer, scene, camera });

  // 7c. Account UI: sign-up modal + drawer + 3rd-claim upsell.
  const authModal = new AuthModal({ auth, toast });
  const accountDrawer = new AccountDrawer({ auth, onOpenAuth: () => authModal.open('signup'), toast });
  const upsell = new Upsell({ auth, onOpenAuth: () => authModal.open('signup') });

  // If the player just clicked an email magic link, the worker has already
  // set the session cookie and bounced us back here with ?signin=ok / err.
  // Surface a tiny toast so they know what happened.
  {
    const url = new URL(location.href);
    const signin = url.searchParams.get('signin');
    if (signin) {
      if (signin === 'ok') {
        toast.show('SIGNED IN', 2000, '#6ed28d');
        auth.refresh().then(() => accountDrawer.render());
      } else {
        toast.show(`SIGN-IN: ${signin.toUpperCase()}`, 2500, '#d26e72');
      }
      url.searchParams.delete('signin');
      history.replaceState({}, '', url.pathname + (url.search || '') + url.hash);
    }
  }

  // 7. LLM client (with offline fallback)
  // Same resolution as api.js: explicit ?worker= or localStorage override
  // first, then API_BASE (which handles dev→empty / prod→api.personalspace.fun).
  const workerURL = (new URLSearchParams(location.search)).get('worker')
    || localStorage.getItem('paper-airplane:worker')
    || import.meta.env.VITE_WORKER_URL
    || API_BASE;
  const llm = new LLMClient({ workerURL });

  // --- LLM naming: per-planet pings + commitment-gated approach. ---
  //
  // Streaming makes planets come and go, so per-planet state is keyed by
  // planet seed instead of by index. `pings` doubles as the HUD ping strip
  // backing store; iteration order is insertion order.
  const pings = new Map();           // seed -> { name, teaser, planet }
  const approachSent = new Set();    // seed of planets we've already tried Tier 2 on
  const PING_HUD_LIMIT = 5;          // chip strip caps at the N nearest planets
  const refreshPings = () => {
    const sorted = Array.from(pings.values())
      .map(p => ({ ...p, d: plane.position().distanceTo(p.planet.center) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, PING_HUD_LIMIT);
    hud.setPings(sorted);
  };

  // 8. Galaxy — streaming solar systems based on player galaxy position.
  // The home cell (0,0,0) is always populated so we have a stable spawn point.
  const galaxy = new Galaxy({
    rapier: RAPIER,
    world,
    scene,
    origin,
    seed: galaxySeed,
    onSystemSpawned: (sys) => {
      // Per-planet HUD ping + nav track. Keyed by planet seed so they survive
      // pings-list iteration order and any future despawn/respawn churn.
      const sunCss = `#${sys.sunColor.getHexString()}`;
      for (let i = 0; i < sys.planets.length; i++) {
        const p = sys.planets[i];
        const atm = sys.atmospheres[i];

        planetNav.track(`planet:${p.seed}`, {
          object: p.group,
          label: (p.meta?.name || `P${i + 1}`).toUpperCase(),
          color: '#9ec8ff',
          getDistance: () => Math.max(0, plane.position().distanceTo(p.center) - p.radius),
        });

        // Tier 1 teaser ping. KV cache makes revisits instant.
        // name=null until Tier 2 returns the real planet name — the HUD
        // chip renders a "DISCOVERING…" placeholder in that state so we
        // never expose internal slot labels to the player.
        llm.ping(p.seed, { starColor: sunCss }).then(r => {
          if (!r?.teaser) return;
          pings.set(p.seed, { name: p.meta?.name?.toUpperCase() || null, teaser: r.teaser, planet: p });
          refreshPings();
        }).catch(() => {});
      }
    },
    onSystemDespawned: (sys) => {
      for (const p of sys.planets) {
        planetNav.untrack(`planet:${p.seed}`);
        pings.delete(p.seed);
        approachSent.delete(p.seed);
      }
      refreshPings();
    },
  });

  // Tier 2 (approach). Idempotent per-seed thanks to the Set guard; failures
  // delete the seed so a real retry can re-arm later.
  const tryApproach = (planet) => {
    if (approachSent.has(planet.seed)) return;
    approachSent.add(planet.seed);
    llm.approach(planet.seed, { radius: planet.radius }).then(meta => {
      if (!meta) return;
      planet.applyLLM(meta);
      const label = (meta.name || `P?`).toUpperCase();
      planetNav.setLabel(`planet:${planet.seed}`, label);
      const existing = pings.get(planet.seed);
      if (existing) {
        existing.name = label;
        refreshPings();
      }
      if (planet === activePlanet) hud.setPlanetName(meta.name);
    }).catch(() => { approachSent.delete(planet.seed); });
  };

  // 9. Spawn the plane — restored position if we have one, otherwise the
  // home system's default spawn (above planet[0], aimed tangentially).
  let spawnPos0, spawnFwd0;
  if (savedPosition) {
    spawnPos0 = new THREE.Vector3(0, 0, 0); // galaxyOrigin already set above
    spawnFwd0 = new THREE.Vector3(savedPosition.fwd[0], savedPosition.fwd[1], savedPosition.fwd[2]).normalize();
  } else {
    ({ pos: spawnPos0, fwd: spawnFwd0 } = galaxy.defaultSpawn());
  }
  plane.spawn(spawnPos0, spawnFwd0, TUNING.CRUISE_SPEED);

  // Position-sync state: track the last galaxy-space position we wrote and
  // the cell it belonged to. Save triggers: cell change, OR moved >500m and
  // ≥10s since last save. beforeunload also fires one keepalive save below.
  const positionSync = {
    lastSavedGalaxyPos: savedPosition ? new THREE.Vector3(...savedPosition.pos) : null,
    lastSavedCellKey: savedPosition ? cellKeyOf(savedPosition.pos) : null,
    lastSaveAt: 0,
    inflight: false,
  };
  flightStats.startAttempt();
  camera.position.copy(spawnPos0.clone().addScaledVector(spawnFwd0, -14)).add(new THREE.Vector3(0, 1.8, 0));

  // Resolve initial active planet/atmosphere/system from spawn position.
  let { planet: activePlanet, atmosphere: activeAtmosphere, system: activeSystem } = galaxy.activePlanetFor(plane.position());

  // Crossings
  let prevInside = activeAtmosphere.contains(plane.position());
  let prevActivePlanet = activePlanet;
  let crashRespawnAt = 0;
  let pingRefreshCounter = 0;

  hud.setState(prevInside ? 'IN ATMOSPHERE' : 'IN SPACE');

  // 9a. beforeunload — fire one keepalive save so the player resumes near
  // where the tab closed instead of where the last debounce wrote.
  window.addEventListener('beforeunload', () => {
    if (!auth.user?.id) return;
    const g = origin.toGalaxy(plane.position());
    const fwd = plane.forward();
    apiPost('/api/account/position', {
      pos: [g.x, g.y, g.z],
      fwd: [fwd.x, fwd.y, fwd.z],
    }, { keepalive: true, timeoutMs: 1000 }).catch(() => {});
  });

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
      if (ev.debugEdge) debugHUD.toggle();
      if (ev.resetEdge) {
        // Always reset to the home system (cell 0,0,0). Planet centers may
        // have shifted in render space due to floating-origin rebases.
        const s = galaxy.defaultSpawn();
        plane.spawn(s.pos, s.fwd, TUNING.CRUISE_SPEED);
        flight.reset();
        flightStats.resetAttempt();
        const a = galaxy.activePlanetFor(plane.position());
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
        // Crash → respawn keeps the crash count climbing for this attempt; the
        // next claim's logbook entry then records "took 3 crashes to land".
        flightStats.resetAttempt({ incrementCrashes: true });
        crashRespawnAt = 0;
        toast.show('RESPAWN', 1000, '#ffd86b');
        const a = galaxy.activePlanetFor(plane.position());
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
          flightStats.resetAttempt();
          toast.show('RECOVERED', 1000, '#ffd86b');
        }
      }

      // Resolve the currently-active planet across all loaded systems.
      // Atmosphere wins; else nearest surface. All per-frame logic uses this.
      {
        const a = galaxy.activePlanetFor(plane.position());
        activePlanet = a.planet;
        activeAtmosphere = a.atmosphere;
        activeSystem = a.system;
      }

      // Commitment-gated Tier 2 (approach). Fires once per planet across every
      // loaded system. The seed-keyed `approachSent` Set survives despawn so
      // we don't re-fire when a system streams back in.
      {
        const planePos = plane.position();
        const planeFwd = plane.forward();
        for (const ref of galaxy.allPlanets()) {
          if (approachSent.has(ref.planet.seed)) continue;
          if (ref.atmosphere.contains(planePos)) { tryApproach(ref.planet); continue; }
          const toPlanet = ref.planet.center.clone().sub(planePos);
          const distance = toPlanet.length();
          if (distance > ref.planet.radius + TUNING.APPROACH_DISTANCE) continue;
          toPlanet.divideScalar(distance || 1);
          if (planeFwd.dot(toPlanet) >= TUNING.APPROACH_DOT) tryApproach(ref.planet);
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
        const hit = galaxy.planetForColliderHandle(otherHandle);
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

      // Tick per-attempt stats.
      flightStats.tick(dt, plane.velocity().length());

      // Coverage-based claim. While the plane is in atmosphere, accumulate
      // surveyed cells on the active planet. Crossing the threshold fires
      // the claim. Leaving an atmosphere mid-survey wipes that planet's
      // progress — there's no resuming from the outside.
      {
        const planePos = plane.position();
        let claimCandidate = null;
        for (const ref of galaxy.allPlanets()) {
          if (ref.planet.claimed) continue;
          if (ref.atmosphere.contains(planePos)) {
            ref.planet.coverage.tick(planePos, ref.planet.center);
            if (ref.planet === activePlanet && ref.planet.coverage.pct() >= TUNING.CLAIM_COVERAGE) {
              claimCandidate = ref.planet;
            }
          } else if (ref.planet.coverage.pct() > 0) {
            ref.planet.coverage.reset();
          }
        }

        // Update HUD progress bar for the planet we're currently surveying.
        // Rescale raw coverage to the claim threshold so a full bar = ready to claim.
        if (activePlanet && !activePlanet.claimed && activeAtmosphere?.contains(planePos)) {
          const progress = Math.min(1, activePlanet.coverage.pct() / TUNING.CLAIM_COVERAGE);
          hud.setClaimProgress(activePlanet.meta?.name || `P${activePlanet.seed}`, progress);
        } else {
          hud.setClaimProgress(null, 0);
        }

        if (claimCandidate) {
          const p = claimCandidate;
          p.claimed = true;
          const name = p.meta?.name || `Unnamed-${p.seed}`;
          toast.show(`${name.toUpperCase()} · CLAIMED`, 2200, '#ffd66b');

        const identity = galaxy.identityForPlanet(p);
        const stats = flightStats.capture();
        const entryInput = {
          id: cryptoUUID(),
          ...identity,
          planet_name: name,
          biome: p.meta?.biome || null,
          palette: p.meta?.palette || null,
          landmarks: p.meta?.landmarks || null,
          lore: null,
          lore_status: 'pending',
          claimed_at: Date.now(),
          stats,
        };
        const entryPromise = logbookStore.add(entryInput);
        upsell.noteClaim();
        // Soft-cap nudge once we cross 500 entries. Hard cap (2000) lives on
        // the server; this is just a heads-up.
        logbookStore.getAll().then((all) => {
          if (all.length === 500) toast.show('LOGBOOK · 500 ENTRIES', 2200, '#d4b06e');
          else if (all.length === 1500) toast.show('LOGBOOK · 1500 ENTRIES — APPROACHING CAP', 3000, '#d4b06e');
          else if (all.length === 1900) toast.show('LOGBOOK · NEAR LIMIT (2000)', 3500, '#d26e72');
        }).catch(() => {});

        // Tier 3 — ownership keyed by entry, not Planet. Survives streaming.
        llm.land(p.seed, {
          name: p.meta?.name,
          biome: p.meta?.biome,
          landmarks: p.meta?.landmarks,
        }).then(async (lore) => {
          const entry = await entryPromise;
          if (lore?.surfaceLore) hud.setLandmark(lore.surfaceLore);
          if (!entry) return;
          const patch = {
            lore: lore?.surfaceLore || null,
            lore_status: lore?.surfaceLore ? 'ready' : 'failed',
            landmarks: lore?.landmarkLore
              ? mergeLandmarkLore(p.meta?.landmarks, lore.landmarkLore)
              : (p.meta?.landmarks || null),
          };
          await logbookStore.update(entry.id, patch);
          // Best-effort remote PATCH; if it 404s (entry not POSTed yet), the
          // next sync tick re-POSTs with the updated fields.
          patchEntryRemote(entry.id, {
            lore: patch.lore, lore_status: patch.lore_status,
            landmarks: patch.landmarks,
          });
        }).catch(async () => {
          const entry = await entryPromise;
          if (entry) await logbookStore.update(entry.id, { lore_status: 'failed' });
        });

        // Thumbnail — capture immediately. The plane is still flying, the
        // camera is already framed on the planet, no settle window needed.
        thumbnailCapture.snapshotNow().then(async (blob) => {
          if (!blob) return;
          const entry = await entryPromise;
          if (entry) await logbookStore.attachThumbnail(entry.id, blob);
        });
        }  // end if (claimCandidate)
      }  // end coverage block

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

      // Floating-origin rebase. Runs after physics + sync so every per-step
      // computation above sees consistent positions; the shift applies to the
      // plane and every loaded system together so the player never sees a pop.
      const shift = origin.maybeRebase(plane.position());
      if (shift) {
        plane.translate(shift);
        galaxy.translate(shift);
      }

      // Galaxy streaming pass. Spawns systems entering SPAWN_RADIUS (bounded
      // to MAX_SPAWNS_PER_STEP), despawns systems past CULL_RADIUS. Runs after
      // rebase so the spawn renderOrigin computation uses the up-to-date
      // origin.galaxyOrigin.
      galaxy.update(plane.position());

      // Re-sort the HUD ping strip every ~half-second so the visible chips
      // track the player's position as they fly between systems.
      pingRefreshCounter = (pingRefreshCounter + 1) % 30;
      if (pingRefreshCounter === 0) refreshPings();

      // Position persistence — save the player's galaxy-space coords on cell
      // boundary crossings + every ~10s while moving. Authenticated only;
      // failures are silent (next attempt overwrites).
      if (auth.user?.id && !positionSync.inflight) {
        const planeGalaxy = origin.toGalaxy(plane.position());
        const cellKey = cellKeyOf([planeGalaxy.x, planeGalaxy.y, planeGalaxy.z]);
        const now = performance.now();
        const movedFar = positionSync.lastSavedGalaxyPos
          ? planeGalaxy.distanceTo(positionSync.lastSavedGalaxyPos) > 500
          : true;
        const stale = now - positionSync.lastSaveAt > 10000;
        const cellChanged = cellKey !== positionSync.lastSavedCellKey;
        if (cellChanged || (movedFar && stale)) {
          const fwd = plane.forward();
          positionSync.inflight = true;
          apiPost('/api/account/position', {
            pos: [planeGalaxy.x, planeGalaxy.y, planeGalaxy.z],
            fwd: [fwd.x, fwd.y, fwd.z],
          }).then(() => {
            positionSync.lastSavedGalaxyPos = planeGalaxy.clone();
            positionSync.lastSavedCellKey = cellKey;
            positionSync.lastSaveAt = now;
          }).catch(() => {}).finally(() => { positionSync.inflight = false; });
        }
      }
    },

    onRender: (dt) => {
      // Atmosphere shader breathes with player altitude
      activeAtmosphere.tick(plane.position(), camera);
      // Sky color blend (sun tint near the surface)
      const r = activeAtmosphere.density(plane.position());
      const skyA = new THREE.Color(0x04060c);
      const tintSun = activeSystem?.sunColor || new THREE.Color(0xfff2d6);
      const skyB = new THREE.Color(0x8bb8dc).lerp(tintSun, 0.25);
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
  // Welcome modal + retrieval warmup. The warmup (MiniLM model fetch,
  // ~22 MB once, cached after) always fires — first-time visitors see
  // progress in the modal's bar; returning visitors hit browser cache
  // and the preload finishes silently in the background.
  let _welcomeModal;
  const warmupPromise = preloadRetriever({
    onProgress: (frac) => _welcomeModal?.setProgress?.(frac),
  }).catch((err) => {
    // Don't block the modal forever on a flaky network — retrieval has
    // its own degraded-mode (BM25-only) fallback.
    console.warn('[warmup] retriever preload failed; continuing:', err);
  });

  _welcomeModal = new WelcomeModal({
    onDismiss: () => { loop.setPaused(false); input.drain(); },
    warmupPromise,
  });
  const welcomeModal = _welcomeModal;

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Escape') return;
    if (welcomeModal.isOpen) return;     // welcome modal blocks ESC
    e.preventDefault();
    setPaused(!paused);
  });
  if (resumeBtn) resumeBtn.addEventListener('click', () => setPaused(false));

  // Done bootstrapping
  document.getElementById('boot').classList.add('hidden');

  if (welcomeModal.shouldShow()) {
    loop.setPaused(true);
    welcomeModal.open();
  }

  // Debug hooks
  window.__GAME = {
    plane, galaxy, flight, cameraRig, origin,
    auth, logbookStore, logbookSync, flightStats, thumbnailCapture,
    get planet() { return activePlanet; },
    get atmosphere() { return activeAtmosphere; },
    get system() { return activeSystem; },
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
        loadedSystems: galaxy.systems.size,
      };
    },
    snapshot() {
      const s = galaxy.defaultSpawn();
      plane.spawn(s.pos, s.fwd, TUNING.CRUISE_SPEED);
      flight.reset();
      return 'spawned';
    },
    // Phase 2 — quickly verify the hybrid retrieval pipeline. Returns
    // [{id, score, sources}] for the given query + slot. Empty catalog
    // returns []. Example:
    //   await __GAME.testShortlist('towering obsidian spire', 'hero', 8)
    async testShortlist(query, role = 'hero', k = 8) {
      const t0 = performance.now();
      const result = await retrieverShortlist({ query, role, k });
      console.log(`[testShortlist] ${(performance.now() - t0).toFixed(1)}ms · retriever ready: ${retrieverIsReady()}`);
      return result;
    },
    // Phase 1 — drop a GLB onto the active planet's surface to verify the
    // AssetCache / MaterialSet path end-to-end. Accepts either a catalog id
    // (resolved against assets/catalog.json) or a raw URL string.
    //
    //   __GAME.testAsset('/assets/bundled/foo.glb')
    //   __GAME.testAsset({ url: 'https://example.com/x.glb', scale: 5 })
    //
    // Returns a Promise resolving to the mounted THREE.Group; useful for
    // poking at the result in DevTools.
    async testAsset(spec) {
      const opts = typeof spec === 'string' ? { url: spec } : (spec || {});
      const url = opts.url;
      if (!url) { console.warn('testAsset: pass a URL or { url, scale }'); return null; }
      const matSet = buildMaterialSet(activePlanet.palette);
      const group = await loadAssetInstance(url, matSet, renderer);
      // Place on the highest point of the active planet so it's findable.
      const radial = new THREE.Vector3(0, 1, 0);
      const surfacePos = activePlanet.center.clone()
        .add(radial.clone().multiplyScalar(activePlanet.radius + 1));
      group.position.copy(surfacePos);
      group.scale.setScalar(opts.scale ?? 1);
      group.userData.testAsset = true;
      activePlanet.group.add(group);
      console.log(`testAsset mounted on planet ${activePlanet.seed} at`, surfacePos);
      return group;
    },
  };

  loop.start();
}

// Per-entry id for new logbook entries. crypto.randomUUID is universally
// available in modern browsers; fallback path stays for old WebKit.
function cryptoUUID() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

// Combine Tier 2 landmarks (name, slotId, kind) with Tier 3 lore blurbs
// (slotId, blurb) into a single array suitable for the logbook detail view.
function mergeLandmarkLore(landmarks, landmarkLore) {
  if (!Array.isArray(landmarks)) return Array.isArray(landmarkLore) ? landmarkLore : null;
  const byId = new Map((landmarkLore || []).map((l) => [l.slotId, l.blurb]));
  return landmarks.map((lm) => ({ ...lm, blurb: byId.get(lm.slotId) || null }));
}

main().catch(err => {
  console.error('Boot failure', err);
  const boot = document.getElementById('boot');
  if (boot) { boot.textContent = 'BOOT ERROR — see console'; }
});
