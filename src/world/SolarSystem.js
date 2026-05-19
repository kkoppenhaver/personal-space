import * as THREE from 'three';
import { Planet } from './Planet.js';
import { Atmosphere } from './Atmosphere.js';
import { TUNING } from '../game/Tuning.js';
import { mulberry32, hashSeeds } from './Seed.js';

// One solar system: a sun at the system origin plus 3–6 deterministic planets,
// each with its own atmosphere and landing zone. Everything is built off the
// system seed; later phases swap this seed per visited galaxy cell.

const PLANET_COUNT_MIN = 3;
const PLANET_COUNT_MAX = 6;
const ORBIT_MIN = 200;
const ORBIT_MAX = 5000;
const SUN_RADIUS = 80;

const SUN_PALETTE = [
  0xfff2d6, 0xffe09a, 0xffcf6b, 0xffb169,
  0xffd6a5, 0xf8e6c0, 0xfff0c0, 0xffe580,
  0xffc97e, 0xffa766, 0xefe3b6,
];

export class SolarSystem {
  constructor({ rapier, world, seed }) {
    this.seed = seed >>> 0;
    this.rapier = rapier;
    this.world = world;

    this.group = new THREE.Group();
    this.planets = [];
    this.atmospheres = [];
    this._planetByColliderHandle = new Map();

    const rand = mulberry32(this.seed);

    this.sunColor = new THREE.Color(SUN_PALETTE[Math.floor(rand() * SUN_PALETTE.length)]);
    this.sun = this._buildSun(this.sunColor);
    this.group.add(this.sun);

    const planetCount = PLANET_COUNT_MIN + Math.floor(rand() * (PLANET_COUNT_MAX - PLANET_COUNT_MIN + 1));
    const logMin = Math.log(ORBIT_MIN);
    const logMax = Math.log(ORBIT_MAX);

    // System-wide random angular phase, so planet 0 isn't always on the +X axis.
    const phase = rand() * Math.PI * 2;
    // Shuffle the order in which planets claim angular sectors. Without this,
    // the closest orbit always lands in sector 0, the next in sector 1, etc.
    // — which makes successive planets walk around the sun in a predictable
    // spiral. A shuffled order breaks up that "spiral arm" pattern.
    const sectorOrder = shuffled(planetCount, rand);

    for (let i = 0; i < planetCount; i++) {
      const planetSeed = hashSeeds(this.seed, i + 1);
      const prand = mulberry32(planetSeed);

      // Logarithmic orbit slot with jitter so adjacent planets don't lock-step.
      const slot = (i + 0.4 + prand() * 0.4) / planetCount;
      const orbitR = Math.exp(logMin + (logMax - logMin) * slot);

      // Sector-based angle: each planet owns a 2π/N wedge and picks a random
      // angle inside it. Guarantees minimum angular separation between any
      // two planets, so they never line up from the player's spawn vantage.
      const sector = sectorOrder[i];
      const sectorSize = (Math.PI * 2) / planetCount;
      const jitter = (0.15 + 0.7 * prand()) * sectorSize;
      const theta = phase + sector * sectorSize + jitter;

      // Inclination — wider than before so planets are visibly stacked above
      // and below the system plane, not all in one disc.
      const incl = (prand() - 0.5) * 0.9;
      const center = new THREE.Vector3(
        Math.cos(theta) * Math.cos(incl) * orbitR,
        Math.sin(incl) * orbitR,
        Math.sin(theta) * Math.cos(incl) * orbitR,
      );

      const radius = TUNING.PLANET_RADIUS * (0.8 + prand() * 0.6);

      const planet = new Planet({ rapier, world, seed: planetSeed, radius, center });
      const atmosphere = new Atmosphere({ planet, radius: radius + TUNING.ATM_TOP });

      this.planets.push(planet);
      this.atmospheres.push(atmosphere);
      this.group.add(planet.group);
      this.group.add(atmosphere.mesh);

      this._planetByColliderHandle.set(planet.collider.handle, { planet, atmosphere, index: i });
    }

    this.starfield = this._buildStarfield(this.sunColor);
    this.group.add(this.starfield);
  }

  _buildSun(color) {
    const group = new THREE.Group();
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(SUN_RADIUS, 28, 18),
      new THREE.MeshBasicMaterial({ color }),
    );
    group.add(core);

    // Two halo shells for a soft falloff that reads from far away.
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(SUN_RADIUS * 1.6, 28, 18),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.30, depthWrite: false, side: THREE.BackSide }),
    );
    group.add(halo);
    const outerHalo = new THREE.Mesh(
      new THREE.SphereGeometry(SUN_RADIUS * 2.8, 28, 18),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.BackSide }),
    );
    group.add(outerHalo);

    return group;
  }

  _buildStarfield(tintColor) {
    const count = 2400;
    const radius = 9000;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const rand = mulberry32(hashSeeds(this.seed, 0x57a5));
    const tint = new THREE.Color(tintColor).lerp(new THREE.Color(0xffffff), 0.55);

    for (let i = 0; i < count; i++) {
      const u = rand(), v = rand();
      const theta = 2 * Math.PI * u, phi = Math.acos(2 * v - 1);
      const r = radius * (0.7 + 0.3 * rand());
      positions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = r * Math.cos(phi);
      const k = 0.80 + 0.20 * rand();
      colors[i * 3 + 0] = tint.r * k;
      colors[i * 3 + 1] = tint.g * k;
      colors[i * 3 + 2] = tint.b * k;
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

  // Which planet "owns" this world-space position?
  //
  // - If any planet's atmosphere contains pos, that planet (atmosphere wins).
  // - Otherwise the planet whose surface is closest. We compare
  //   `distance(pos, center) - radius` so a small nearby planet beats a huge
  //   far one of equal center distance.
  activePlanetFor(pos) {
    for (let i = 0; i < this.planets.length; i++) {
      if (this.atmospheres[i].contains(pos)) {
        return { planet: this.planets[i], atmosphere: this.atmospheres[i], index: i };
      }
    }
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < this.planets.length; i++) {
      const d = pos.distanceTo(this.planets[i].center) - this.planets[i].radius;
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    return { planet: this.planets[bestIdx], atmosphere: this.atmospheres[bestIdx], index: bestIdx };
  }

  // Collision handle → which planet does it belong to?
  planetForColliderHandle(handle) {
    return this._planetByColliderHandle.get(handle) || null;
  }

  // Default plane spawn: outside planet[0]'s atmosphere, aimed tangentially so
  // entry carries lateral momentum (not a radial nose-dive).
  defaultSpawn() {
    const p = this.planets[0];
    const radial = p.center.clone();
    if (radial.lengthSq() < 1e-3) radial.set(1, 0, 0);
    radial.normalize();

    const distAboveAtm = 400;
    const spawnPos = p.center.clone().add(
      radial.clone().multiplyScalar(p.radius + TUNING.ATM_TOP + distAboveAtm)
    );

    // Aim toward planet but offset tangentially for an angled approach.
    let tangent = new THREE.Vector3().crossVectors(radial, new THREE.Vector3(0, 1, 0));
    if (tangent.lengthSq() < 1e-3) tangent.crossVectors(radial, new THREE.Vector3(1, 0, 0));
    tangent.normalize();
    const aimTarget = p.center.clone().add(tangent.multiplyScalar(p.radius * 1.8));
    const spawnFwd = aimTarget.sub(spawnPos).normalize();

    return { pos: spawnPos, fwd: spawnFwd };
  }
}

// Fisher–Yates with a seeded RNG. Returns [0..n-1] in a deterministic order.
function shuffled(n, rand) {
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
