import * as THREE from 'three';
import { mulberry32 } from './Seed.js';

// One landing zone per planet. Picks a spot on land at moderate elevation
// (deterministic from seed), builds a visible pad + tall vertical beacon, and
// exposes a check for whether the plane has touched down inside the pad.
//
// All geometry is in PLANET-LOCAL space — the parent group is the planet's
// group, which lives at planet.center in world space.

const TMP = new THREE.Vector3();

export class LandingZone {
  constructor({ planet, seed }) {
    this.planet = planet;
    this.length = 40;
    this.width  = 9;
    this.radius = this.length * 0.5 + 2;   // soft "claim" radius around the runway center
    this.beaconHeight = 220;
    this.claimed = false;

    // Pick a deterministic surface point on land at mid elevation.
    const rand = mulberry32((seed ^ 0xa110ba5e) >>> 0);
    const posAttr = planet.geometry.attributes.position;
    const elevations = planet.elevations;

    // Shuffle candidate indices, take the first one with acceptable elevation.
    const ELEV_MIN = 0.50;     // above water
    const ELEV_MAX = 0.72;     // below peaks
    let chosenIdx = -1;
    for (let attempt = 0; attempt < 400; attempt++) {
      const i = Math.floor(rand() * posAttr.count);
      const e = elevations[i];
      if (e >= ELEV_MIN && e <= ELEV_MAX) { chosenIdx = i; break; }
    }
    if (chosenIdx < 0) {
      // Fallback — any vertex above water
      for (let i = 0; i < posAttr.count; i++) {
        if (elevations[i] > 0.45) { chosenIdx = i; break; }
      }
    }

    // surfacePoint is in planet-local space (planet group is at planet.center)
    this.surfacePoint = new THREE.Vector3().fromBufferAttribute(posAttr, chosenIdx);
    this.normal = this.surfacePoint.clone().normalize();   // outward from planet center

    // Local surface basis: longAxis runs along the runway, widthAxis crosses it.
    // Derived from the planet's "north" via cross with the outward normal.
    const worldUp = new THREE.Vector3(0, 1, 0);
    this.longAxis = new THREE.Vector3().crossVectors(this.normal, worldUp);
    if (this.longAxis.lengthSq() < 1e-3) {
      this.longAxis.crossVectors(this.normal, new THREE.Vector3(1, 0, 0));
    }
    this.longAxis.normalize();
    // widthAxis must satisfy widthAxis × longAxis = normal (right-handed basis),
    // i.e. widthAxis = longAxis × normal.
    this.widthAxis = new THREE.Vector3().crossVectors(this.longAxis, this.normal).normalize();

    // Build a quaternion that maps the geometry's local frame (X=width, Y=length, Z=normal) to world.
    this.surfaceQ = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(this.widthAxis, this.longAxis, this.normal)
    );

    // Flatten the terrain around the pad so the runway sits flush.
    // Inner radius = fully flat; outer = smooth falloff back to original.
    this.flattenRadiusInner = Math.max(this.length / 2 + 2, this.width / 2 + 2);
    this.flattenRadiusOuter = this.flattenRadiusInner * 2.0;
    this._flattenSurroundingTerrain();

    // Build visuals
    this.group = new THREE.Group();
    this._buildRunway();
    this._buildBeacon();
  }

  // Modifies planet.geometry vertex positions in a smooth disc around the pad
  // so the runway can lie flush on a flat patch. Called before the trimesh
  // collider is built — collision and visuals will match.
  _flattenSurroundingTerrain() {
    const pos = this.planet.geometry.attributes.position;
    const colors = this.planet.geometry.attributes.color?.array;
    const center = this.surfacePoint;
    const normal = this.normal;
    const rIn = this.flattenRadiusInner;
    const rOut = this.flattenRadiusOuter;
    const v = new THREE.Vector3();
    const offset = new THREE.Vector3();
    const tangentOffset = new THREE.Vector3();

    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      offset.copy(v).sub(center);
      const along = offset.dot(normal);
      tangentOffset.copy(offset).sub(normal.clone().multiplyScalar(along));
      const tDist = tangentOffset.length();
      if (tDist > rOut) continue;

      // Smoothstep weight: 1 inside inner radius, → 0 by outer
      let t;
      if (tDist <= rIn) t = 1;
      else {
        const u = (rOut - tDist) / (rOut - rIn);
        t = u * u * (3 - 2 * u);
      }

      // Flattened position = remove the along-normal component (project onto
      // tangent plane through center).
      const flat = v.clone().sub(normal.clone().multiplyScalar(along));
      v.lerp(flat, t);
      pos.setXYZ(i, v.x, v.y, v.z);

      // Paint the flattened patch with a muted earth/runway tone so it reads
      // as "prepared ground" even if no runway mesh covers it.
      if (colors && t > 0.5) {
        const blend = (t - 0.5) * 2;       // 0..1 across the inner half
        // Mute the existing color toward a dim sand color
        const r0 = colors[i * 3], g0 = colors[i * 3 + 1], b0 = colors[i * 3 + 2];
        colors[i * 3]     = r0 * (1 - blend) + 0.40 * blend;
        colors[i * 3 + 1] = g0 * (1 - blend) + 0.32 * blend;
        colors[i * 3 + 2] = b0 * (1 - blend) + 0.22 * blend;
      }
    }
    if (this.planet.geometry.attributes.color) this.planet.geometry.attributes.color.needsUpdate = true;
  }

  _buildRunway() {
    // Helper to add a flat piece, positioned at the surface point, raised a
    // little above the terrain, oriented in the runway's local frame.
    const liftBase = 0.4;
    const addStripe = (geom, color, opacity, liftExtra = 0, localOffset = [0, 0, 0]) => {
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false });
      const mesh = new THREE.Mesh(geom, mat);
      const localOff = new THREE.Vector3(localOffset[0], localOffset[1], 0).applyQuaternion(this.surfaceQ);
      mesh.position.copy(this.surfacePoint)
        .add(this.normal.clone().multiplyScalar(liftBase + liftExtra))
        .add(localOff);
      mesh.quaternion.copy(this.surfaceQ);
      this.group.add(mesh);
      return mesh;
    };

    // Dark base — the asphalt
    addStripe(new THREE.PlaneGeometry(this.width, this.length), 0x1a120a, 0.85, 0);

    // Long edge stripes — paint along the two sides
    const edgeW = 0.5;
    addStripe(new THREE.PlaneGeometry(edgeW, this.length * 0.96), 0xfff2d6, 0.95, 0.02, [-this.width / 2 + edgeW / 2, 0]);
    addStripe(new THREE.PlaneGeometry(edgeW, this.length * 0.96), 0xfff2d6, 0.95, 0.02, [ this.width / 2 - edgeW / 2, 0]);

    // Dashed centerline
    const dashCount = 6;
    const dashLen = (this.length * 0.7) / (dashCount * 2 - 1);
    const dashWid = 0.5;
    for (let i = 0; i < dashCount; i++) {
      const y = -this.length * 0.35 + (i * 2) * dashLen + dashLen / 2;
      addStripe(new THREE.PlaneGeometry(dashWid, dashLen), 0xfff2d6, 0.9, 0.02, [0, y]);
    }

    // Threshold chevrons at one end (the "approach" end) — bold orange bars
    const thrCount = 4;
    const thrBarW = this.width * 0.85;
    const thrBarH = 0.7;
    const thrSpacing = 1.1;
    const thrStartY = -this.length / 2 + 2;
    for (let i = 0; i < thrCount; i++) {
      const y = thrStartY + i * thrSpacing;
      addStripe(new THREE.PlaneGeometry(thrBarW, thrBarH), 0xff8c2c, 0.95, 0.03, [0, y]);
    }

    // Bright touchdown bar near the threshold end
    addStripe(new THREE.PlaneGeometry(thrBarW * 0.6, 1.4), 0xfff2d6, 1.0, 0.04, [0, thrStartY + thrCount * thrSpacing + 2]);

    // Far-end bar (so it's clearly bounded on both sides)
    addStripe(new THREE.PlaneGeometry(thrBarW, 0.6), 0xff8c2c, 0.9, 0.03, [0, this.length / 2 - 1.5]);
  }

  _buildBeacon() {
    // Tall vertical column of light. Two stacked cones flipped so the bottom
    // is bright and it tapers off as it rises — looks like a beacon, not a wall.
    const beaconBase = this.surfacePoint.clone();
    const beaconCenter = beaconBase.clone().add(this.normal.clone().multiplyScalar(this.beaconHeight / 2));

    const beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.2, 2.5, this.beaconHeight, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xff8c2c,
        transparent: true,
        opacity: 0.30,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    beacon.position.copy(beaconCenter);
    beacon.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.normal));
    this.group.add(beacon);

    // Inner brighter column for "core" of beacon
    const core = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.6, this.beaconHeight, 8, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xfff2d6,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    core.position.copy(beaconCenter);
    core.quaternion.copy(beacon.quaternion);
    this.group.add(core);
  }

  // World-space position of the pad center.
  worldPosition() {
    return this.surfacePoint.clone().add(this.planet.center);
  }

  // Distance from a world-space plane position to the pad center.
  distanceFrom(planeWorldPos) {
    return planeWorldPos.distanceTo(this.worldPosition());
  }

  // Has the plane touched down inside the pad?
  isLanded(plane) {
    if (plane.state !== 'grounded') return false;
    return this.distanceFrom(plane.position()) < this.radius;
  }

  markClaimed() {
    this.claimed = true;
    // Visually mark — could swap colors or pulse. For now, leave geometry alone.
  }
}
