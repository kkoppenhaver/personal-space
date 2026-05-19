import * as THREE from 'three';
import { mulberry32 } from './Seed.js';

// Instanced low-poly scale features: rocks, flora. Placed by sampling random
// surface positions and accepting/rejecting based on elevation band.

export function buildInstancedFeatures({ geometry, elevations, radius, seed, palette, excludeZone = null }) {
  const rand = mulberry32(seed ^ 0xfeed);
  const group = new THREE.Group();
  const pos = geometry.attributes.position;
  const vCount = pos.count;

  // Pick "anchor" vertices in each band by sampling many random vertex indices.
  const samples = 2200;
  const rockTransforms = [];
  const floraTransforms = [];
  const tmp = new THREE.Vector3();
  const exCenter = excludeZone?.center;
  const exR = excludeZone?.radius ?? 0;
  const exR2 = exR * exR;

  for (let s = 0; s < samples; s++) {
    const i = Math.floor(rand() * vCount);
    const e = elevations[i];
    if (e < 0.43) continue; // skip water
    tmp.fromBufferAttribute(pos, i);
    // Skip exclusion zone (e.g. landing pad area)
    if (exCenter && tmp.distanceToSquared(exCenter) < exR2) continue;
    const r = tmp.length();
    const dir = tmp.clone().divideScalar(r);
    if (e > 0.75) {
      // rocks on high elevation
      const size = 0.6 + rand() * 1.2;
      rockTransforms.push({ dir, height: r, size, twist: rand() * Math.PI * 2 });
    } else if (e > 0.46 && e < 0.7) {
      // flora on mid bands
      if (rand() < 0.7) {
        const size = 0.5 + rand() * 0.8;
        floraTransforms.push({ dir, height: r, size, twist: rand() * Math.PI * 2 });
      }
    }
  }

  // ROCKS: low-poly tetrahedron
  if (rockTransforms.length > 0) {
    const g = new THREE.TetrahedronGeometry(1.0, 0);
    const m = new THREE.MeshLambertMaterial({ color: new THREE.Color(palette.high).multiplyScalar(0.9), flatShading: true });
    const inst = new THREE.InstancedMesh(g, m, rockTransforms.length);
    const dummy = new THREE.Object3D();
    rockTransforms.forEach((t, i) => {
      const up = t.dir;
      dummy.position.copy(up).multiplyScalar(t.height + 0.4 * t.size);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
      const qSpin = new THREE.Quaternion().setFromAxisAngle(up, t.twist);
      dummy.quaternion.copy(qSpin).multiply(q);
      dummy.scale.setScalar(t.size);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    });
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
  }

  // FLORA: cone "mushroom-tree"
  if (floraTransforms.length > 0) {
    const g = new THREE.ConeGeometry(0.9, 2.2, 5);
    const m = new THREE.MeshLambertMaterial({ color: new THREE.Color(palette.low).multiplyScalar(0.85), flatShading: true });
    const inst = new THREE.InstancedMesh(g, m, floraTransforms.length);
    const dummy = new THREE.Object3D();
    floraTransforms.forEach((t, i) => {
      const up = t.dir;
      dummy.position.copy(up).multiplyScalar(t.height + 1.0 * t.size);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
      const qSpin = new THREE.Quaternion().setFromAxisAngle(up, t.twist);
      dummy.quaternion.copy(qSpin).multiply(q);
      dummy.scale.setScalar(t.size);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    });
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
  }

  return group;
}
