import * as THREE from 'three';
import { buildPlanetGeometry, makeTerrainSampler } from './TerrainGen.js';
import { pickLandmarkSlots, buildLandmarkMeshes } from './Landmarks.js';
import { buildInstancedFeatures } from './Features.js';
import { Coverage } from './Coverage.js';

export class Planet {
  constructor({ rapier, world, seed, radius, center = new THREE.Vector3(0, 0, 0) }) {
    this.seed = seed;
    this.radius = radius;
    this.center = center.clone();
    this.meta = null;

    const built = buildPlanetGeometry({ seed, radius });
    this.geometry = built.geometry;
    this.elevations = built.elevations;
    this.palette = built.palette;
    this.seaLevel = built.seaLevel;

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.mesh = new THREE.Mesh(this.geometry, mat);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;

    // Sampler for fast altitude queries without raycasting.
    this.sample = makeTerrainSampler({ seed, radius, seaLevel: built.seaLevel });

    // Pick landmark slots from the actual mesh.
    this.landmarks = pickLandmarkSlots({
      geometry: this.geometry,
      elevations: this.elevations,
      radius,
      seed,
      count: 5,
    });
    this.landmarkGroup = buildLandmarkMeshes(this.landmarks, this.palette);

    // Coverage tracker — what fraction of the surface the player has
    // surveyed from this planet's atmosphere. Drives the claim trigger.
    this.coverage = new Coverage();
    this.claimed = false;

    // Instanced scale features (rocks, flora) covering the whole surface
    // now that there's no flattened pad zone to dodge.
    this.featuresGroup = buildInstancedFeatures({
      geometry: this.geometry,
      elevations: this.elevations,
      radius,
      seed,
      palette: this.palette,
    });

    this.group = new THREE.Group();
    this.group.add(this.mesh);
    this.group.add(this.landmarkGroup);
    this.group.add(this.featuresGroup);
    this.group.position.copy(this.center);

    // Rapier trimesh collider
    const indices = this.geometry.index ? this.geometry.index.array : null;
    const vertices = this.geometry.attributes.position.array;
    const idxArray = indices ? new Uint32Array(indices) : new Uint32Array((() => {
      const n = vertices.length / 3;
      const a = new Uint32Array(n);
      for (let i = 0; i < n; i++) a[i] = i;
      return a;
    })());
    const bodyDesc = rapier.RigidBodyDesc.fixed().setTranslation(center.x, center.y, center.z);
    this.body = world.createRigidBody(bodyDesc);
    const colDesc = rapier.ColliderDesc.trimesh(new Float32Array(vertices), idxArray)
      .setFriction(0.6).setRestitution(0.2)
      .setActiveEvents(rapier.ActiveEvents.COLLISION_EVENTS);
    this.collider = world.createCollider(colDesc, this.body);
  }

  // Distance from `pos` (world coords) along surface up direction → altitude above terrain.
  altitudeAbove(pos) {
    const rel = pos.clone().sub(this.center);
    const r = rel.length();
    const dir = rel.divideScalar(r || 1);
    const h = this.sample(dir.x, dir.y, dir.z);
    return r - h;
  }

  // Add `delta` to this planet's render position. Updates the Three group,
  // the Rapier body, and the cached center. Children (landmarks, features,
  // landing zone) auto-follow because they're parented under `this.group`.
  translate(delta) {
    this.center.add(delta);
    this.group.position.copy(this.center);
    this.body.setTranslation({ x: this.center.x, y: this.center.y, z: this.center.z }, true);
  }

  applyLLM(meta) {
    this.meta = meta;
    if (!meta) return;
    // Apply landmark names by slotId
    if (Array.isArray(meta.landmarks)) {
      for (const m of meta.landmarks) {
        const lm = this.landmarks.find(l => l.slotId === m.slotId);
        if (lm) lm.name = m.name || lm.name;
      }
    }
    // Apply palette retint if provided (mild blend, keep it readable)
    if (meta.palette) {
      const oldPalette = this.palette;
      this.palette = { ...oldPalette, ...meta.palette };
      this._reTintVertexColors();
    }
  }

  _reTintVertexColors() {
    const colors = this.geometry.attributes.color.array;
    const pos = this.geometry.attributes.position;
    const tmp = new THREE.Vector3();
    const colWater = new THREE.Color(this.palette.water);
    const colLow   = new THREE.Color(this.palette.low);
    const colMid   = new THREE.Color(this.palette.mid);
    const colHigh  = new THREE.Color(this.palette.high);
    const colSnow  = new THREE.Color(this.palette.snow);
    const tmpColor = new THREE.Color();
    const seaLevel = this.seaLevel;
    for (let i = 0; i < pos.count; i++) {
      tmp.fromBufferAttribute(pos, i);
      const r = tmp.length();
      const above = (r - this.radius * 0.995) / (this.radius * 0.10 || 1);
      if (above < 0.001) tmpColor.copy(colWater);
      else if (above < 0.25) tmpColor.copy(colLow).lerp(colMid, ss(0, 0.25, above));
      else if (above < 0.65) tmpColor.copy(colMid).lerp(colHigh, ss(0.25, 0.65, above));
      else                   tmpColor.copy(colHigh).lerp(colSnow, ss(0.65, 1.0, above));
      colors[i * 3 + 0] = tmpColor.r;
      colors[i * 3 + 1] = tmpColor.g;
      colors[i * 3 + 2] = tmpColor.b;
    }
    this.geometry.attributes.color.needsUpdate = true;
  }
}

function ss(a, b, t) {
  const x = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
}
