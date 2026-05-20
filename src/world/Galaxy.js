import * as THREE from 'three';
import { SolarSystem } from './SolarSystem.js';
import { mulberry32, hashSeeds } from './Seed.js';

// Galaxy — sparse grid of solar systems. Each grid cell either has a system
// or doesn't (deterministic from galaxySeed + cellCoord). Cells within
// SPAWN_RADIUS of the player are loaded; cells beyond CULL_RADIUS are torn
// down. The home cell (0,0,0) always has a system so the player has a place
// to start.
//
// Coordinates:
//   - cellCoord: integer (ix, iy, iz) grid index in galaxy space
//   - cellOrigin (galaxy): cellCoord * CELL_SIZE — the canonical galaxy
//     position of that cell's sun
//   - renderOrigin: cellOrigin - origin.galaxyOrigin (where the sun should
//     appear right now; updated in place by SolarSystem.translate during
//     floating-origin rebases)

const CELL_SIZE = 15000;       // 15 km per cell — comfortably bigger than a system (ORBIT_MAX = 5km)
const SPAWN_RADIUS = 22500;    // load cells within 1.5 cells of the player
const CULL_RADIUS = 35000;     // keep cells loaded a bit longer so backtracking is cheap
const SYSTEM_DENSITY = 0.45;   // fraction of cells that contain a system (after density seed)
const MAX_SPAWNS_PER_STEP = 1; // cap geometry construction work per fixed step

export class Galaxy {
  constructor({ rapier, world, scene, origin, seed, onSystemSpawned, onSystemDespawned } = {}) {
    this.rapier = rapier;
    this.world = world;
    this.scene = scene;
    this.origin = origin;
    this.seed = (seed | 0) >>> 0;
    this.onSystemSpawned = onSystemSpawned || (() => {});
    this.onSystemDespawned = onSystemDespawned || (() => {});

    // cellKey ("ix,iy,iz") -> SolarSystem
    this.systems = new Map();
    // cellKey -> boolean cache so we don't re-hash density every frame
    this._occupancyCache = new Map();

    this.starfield = buildStarfield();
    scene.add(this.starfield);

    // Always seed the home cell so boot has a known system to spawn the player
    // beside, regardless of what the density hash says.
    this._forceOccupy('0,0,0');
    this._spawn(new THREE.Vector3(0, 0, 0), '0,0,0');
  }

  // Cell math
  _cellKeyOf(galaxyPos) {
    return `${Math.floor(galaxyPos.x / CELL_SIZE)},${Math.floor(galaxyPos.y / CELL_SIZE)},${Math.floor(galaxyPos.z / CELL_SIZE)}`;
  }

  _cellCoordFromKey(key) {
    const [x, y, z] = key.split(',').map(Number);
    return new THREE.Vector3(x, y, z);
  }

  _cellOriginGalaxy(cellCoord) {
    return cellCoord.clone().multiplyScalar(CELL_SIZE);
  }

  _isOccupied(cellKey) {
    if (this._occupancyCache.has(cellKey)) return this._occupancyCache.get(cellKey);
    const cc = this._cellCoordFromKey(cellKey);
    const rand = mulberry32(hashSeeds(this.seed, cc.x, cc.y, cc.z));
    const occ = rand() < SYSTEM_DENSITY;
    this._occupancyCache.set(cellKey, occ);
    return occ;
  }

  _forceOccupy(cellKey) {
    this._occupancyCache.set(cellKey, true);
  }

  // Walk every loaded planet across every loaded system. Convenience for
  // main.js loops that need to consider all currently-active worlds.
  *allPlanets() {
    for (const sys of this.systems.values()) {
      for (let i = 0; i < sys.planets.length; i++) {
        yield { system: sys, planet: sys.planets[i], atmosphere: sys.atmospheres[i], index: i };
      }
    }
  }

  // Active planet across all loaded systems: atmosphere wins; else closest surface.
  activePlanetFor(pos) {
    let best = null;
    let bestDist = Infinity;
    for (const ref of this.allPlanets()) {
      if (ref.atmosphere.contains(pos)) return ref;
      const d = pos.distanceTo(ref.planet.center) - ref.planet.radius;
      if (d < bestDist) { bestDist = d; best = ref; }
    }
    return best;
  }

  planetForColliderHandle(handle) {
    for (const sys of this.systems.values()) {
      const hit = sys.planetForColliderHandle(handle);
      if (hit) return hit;
    }
    return null;
  }

  // Convenience for boot: home system is always at cell (0,0,0).
  homeSystem() {
    return this.systems.get('0,0,0');
  }

  defaultSpawn() {
    return this.homeSystem().defaultSpawn();
  }

  // Per-step spawn/despawn pass. Call once per fixed step with the plane's
  // render-space position; we convert to galaxy space internally.
  update(planeRenderPos) {
    const planeGalaxy = this.origin.toGalaxy(planeRenderPos);
    const centerCell = this._cellKeyOf(planeGalaxy);
    const [cx, cy, cz] = centerCell.split(',').map(Number);

    // Spawn pass — scan candidate cells within SPAWN_RADIUS, build at most
    // MAX_SPAWNS_PER_STEP this step to bound mid-flight stutter.
    const reach = Math.ceil(SPAWN_RADIUS / CELL_SIZE);
    let spawnsLeft = MAX_SPAWNS_PER_STEP;
    for (let dx = -reach; dx <= reach && spawnsLeft > 0; dx++) {
      for (let dy = -reach; dy <= reach && spawnsLeft > 0; dy++) {
        for (let dz = -reach; dz <= reach && spawnsLeft > 0; dz++) {
          const key = `${cx + dx},${cy + dy},${cz + dz}`;
          if (this.systems.has(key)) continue;
          if (!this._isOccupied(key)) continue;
          const cellGalaxy = this._cellOriginGalaxy(this._cellCoordFromKey(key));
          if (cellGalaxy.distanceTo(planeGalaxy) > SPAWN_RADIUS) continue;
          this._spawn(cellGalaxy, key);
          spawnsLeft--;
        }
      }
    }

    // Despawn pass — any loaded system whose galaxy origin is beyond
    // CULL_RADIUS. Iterate via Array.from so we can mutate the map.
    for (const [key, sys] of Array.from(this.systems.entries())) {
      const d = sys.galaxyOrigin.distanceTo(planeGalaxy);
      if (d > CULL_RADIUS) this._despawn(key);
    }
  }

  // Shift every loaded system by `delta` (called during floating-origin
  // rebases). Starfield stays put — we treat it as a skybox anchored to
  // scene origin, which means the rebased player stays near its center.
  translate(delta) {
    for (const sys of this.systems.values()) sys.translate(delta);
  }

  _spawn(cellGalaxy, cellKey) {
    const renderOrigin = cellGalaxy.clone().sub(this.origin.galaxyOrigin);
    const systemSeed = hashSeeds(this.seed, ...cellKey.split(',').map(Number));
    const sys = new SolarSystem({
      rapier: this.rapier,
      world: this.world,
      seed: systemSeed,
      galaxyOrigin: cellGalaxy,
      renderOrigin,
    });
    this.scene.add(sys.group);
    this.systems.set(cellKey, sys);
    this.onSystemSpawned(sys, cellKey);
  }

  _despawn(cellKey) {
    const sys = this.systems.get(cellKey);
    if (!sys) return;
    this.onSystemDespawned(sys, cellKey);
    sys.dispose();
    this.systems.delete(cellKey);
  }
}

function buildStarfield() {
  const count = 2400;
  const radius = 9000;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const rand = mulberry32(0xfa11e2);

  for (let i = 0; i < count; i++) {
    const u = rand(), v = rand();
    const theta = 2 * Math.PI * u, phi = Math.acos(2 * v - 1);
    const r = radius * (0.7 + 0.3 * rand());
    positions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
    const k = 0.75 + 0.25 * rand();
    colors[i * 3 + 0] = k;
    colors[i * 3 + 1] = k;
    colors[i * 3 + 2] = k * (0.92 + 0.08 * rand());
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({
    vertexColors: true,
    size: 1.6,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.9,
  });
  return new THREE.Points(geom, mat);
}
