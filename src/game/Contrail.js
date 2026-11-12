import * as THREE from 'three';

// Wingtip contrails: two thin ribbons trailing the paper plane's tips.
// They make speed and banking legible (the trails curve through a turn)
// and give screenshots a line of motion. Ribbons lie in the wing plane
// (width along plane.right) so the chase cam — behind and above — sees
// them face-on rather than edge-on.
//
// Samples live in render space; the floating-origin rebase must call
// translate(). A jump larger than MAX_GAP between samples (respawn,
// warp) clears the trail instead of drawing a streak across the sky.

const SAMPLES = 16;          // ~0.27s of history — a wisp, not a rail
const HALF_WIDTH = 0.09;
const MAX_GAP = 12;          // meters between consecutive samples
const TIP_LOCAL = [
  new THREE.Vector3(-1.05 * 1.6, -0.32 * 1.6, 0.70 * 1.6),
  new THREE.Vector3(1.05 * 1.6, -0.32 * 1.6, 0.70 * 1.6),
];

export class Contrail {
  constructor(scene) {
    this.trails = TIP_LOCAL.map(() => ({
      pts: [],   // { p: Vector3, side: Vector3 }
    }));
    const vCount = SAMPLES * 2;
    this.meshes = this.trails.map(() => {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vCount * 3), 3).setUsage(THREE.DynamicDrawUsage));
      geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(vCount * 4), 4).setUsage(THREE.DynamicDrawUsage));
      const idx = [];
      for (let i = 0; i < SAMPLES - 1; i++) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        idx.push(a, b, c, b, d, c);
      }
      geom.setIndex(idx);
      geom.setDrawRange(0, 0);
      const mat = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.frustumCulled = false;
      scene.add(mesh);
      return mesh;
    });
    this._tmp = new THREE.Vector3();
    this.intensity = 1;
  }

  clear() {
    for (const t of this.trails) t.pts.length = 0;
    for (const m of this.meshes) m.geometry.setDrawRange(0, 0);
  }

  translate(delta) {
    for (const t of this.trails) for (const s of t.pts) s.p.add(delta);
  }

  /**
   * @param {THREE.Object3D} planeObj  the plane's render group (matrixWorld current)
   * @param {THREE.Vector3} right      plane right axis (world)
   * @param {number} strength          0..1 — scales opacity (speed / boost)
   */
  update(planeObj, right, strength) {
    planeObj.updateMatrixWorld();
    for (let k = 0; k < this.trails.length; k++) {
      const t = this.trails[k];
      const p = this._tmp.copy(TIP_LOCAL[k]).applyMatrix4(planeObj.matrixWorld);
      const last = t.pts[0];
      if (last && last.p.distanceToSquared(p) > MAX_GAP * MAX_GAP) t.pts.length = 0;
      t.pts.unshift({ p: p.clone(), side: right.clone() });
      if (t.pts.length > SAMPLES) t.pts.length = SAMPLES;
      this._write(this.meshes[k], t.pts, strength);
    }
  }

  _write(mesh, pts, strength) {
    const pos = mesh.geometry.attributes.position;
    const col = mesh.geometry.attributes.color;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const { p, side } = pts[i];
      const age = i / (SAMPLES - 1);           // 0 = newest
      const w = HALF_WIDTH * (0.35 + 1.4 * age); // spreads as it ages
      pos.setXYZ(i * 2, p.x - side.x * w, p.y - side.y * w, p.z - side.z * w);
      pos.setXYZ(i * 2 + 1, p.x + side.x * w, p.y + side.y * w, p.z + side.z * w);
      // Fade in over the first few samples (no hard edge at the tip) and
      // out toward the tail.
      const a = strength * 0.4 * Math.min(1, i / 3) * Math.pow(1 - age, 1.6);
      col.setXYZW(i * 2, 1, 1, 1, a);
      col.setXYZW(i * 2 + 1, 1, 1, 1, a);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    mesh.geometry.setDrawRange(0, Math.max(0, n - 1) * 6);
  }
}
