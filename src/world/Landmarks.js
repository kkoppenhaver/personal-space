import * as THREE from 'three';
import { mulberry32 } from './Seed.js';

// Pick 3..6 hero landmark slots from the terrain mesh.
// Heuristic: top-K elevation peaks separated by min-angular-distance,
// then optionally a basin and a coast.

export function pickLandmarkSlots({ geometry, elevations, radius, seed, count = 5 }) {
  const pos = geometry.attributes.position;
  const vCount = pos.count;
  const rand = mulberry32(seed ^ 0xdeadbeef);

  // Build candidate list of high-elevation vertices.
  const peakIdx = [];
  for (let i = 0; i < vCount; i++) {
    if (elevations[i] > 0.78) peakIdx.push(i);
  }
  // Shuffle, then greedy-pick spread by angular distance.
  for (let i = peakIdx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [peakIdx[i], peakIdx[j]] = [peakIdx[j], peakIdx[i]];
  }

  const picks = [];
  const tmp = new THREE.Vector3();
  const dirs = [];
  const minDot = 0.35; // ~70° apart
  for (const i of peakIdx) {
    tmp.fromBufferAttribute(pos, i).normalize();
    let ok = true;
    for (const d of dirs) {
      if (tmp.dot(d) > minDot) { ok = false; break; }
    }
    if (!ok) continue;
    const dir = tmp.clone();
    dirs.push(dir);
    const world = dir.clone().multiplyScalar(radius * 1.08);
    picks.push({
      slotId: picks.length,
      kind: 'peak',
      direction: dir,
      position: world,
      name: `Peak-${picks.length + 1}`,
    });
    if (picks.length >= count) break;
  }

  // Find one basin (low non-water vertex)
  for (let i = 0; i < vCount; i++) {
    const e = elevations[i];
    if (e > 0.43 && e < 0.5) {
      tmp.fromBufferAttribute(pos, i).normalize();
      let ok = true;
      for (const d of dirs) { if (tmp.dot(d) > minDot) { ok = false; break; } }
      if (ok) {
        const dir = tmp.clone();
        dirs.push(dir);
        picks.push({
          slotId: picks.length,
          kind: 'basin',
          direction: dir,
          position: dir.clone().multiplyScalar(radius * 1.02),
          name: `Basin-${picks.length + 1}`,
        });
        break;
      }
    }
  }

  return picks;
}

// Build hero marker meshes for picked landmarks. Each gets a small low-poly
// shape that pokes out of the surface, so the player can visually identify them.
export function buildLandmarkMeshes(landmarks, palette) {
  const group = new THREE.Group();
  for (const lm of landmarks) {
    let mesh;
    if (lm.kind === 'peak') {
      // tall slim spire
      const g = new THREE.ConeGeometry(2.0, 12.0, 5);
      const m = new THREE.MeshLambertMaterial({ color: new THREE.Color(palette.snow).multiplyScalar(0.95), flatShading: true });
      mesh = new THREE.Mesh(g, m);
      mesh.position.copy(lm.position);
      const up = lm.direction.clone();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
      mesh.quaternion.copy(q);
    } else if (lm.kind === 'basin') {
      // ring + center disk (like a crater)
      const g = new THREE.TorusGeometry(4.5, 0.5, 6, 16);
      const m = new THREE.MeshLambertMaterial({ color: new THREE.Color(palette.high).multiplyScalar(1.1), flatShading: true });
      mesh = new THREE.Mesh(g, m);
      mesh.position.copy(lm.position);
      const up = lm.direction.clone();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), up);
      mesh.quaternion.copy(q);
    }
    if (mesh) {
      mesh.userData.slotId = lm.slotId;
      group.add(mesh);
    }
  }
  return group;
}
