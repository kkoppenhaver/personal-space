import * as THREE from 'three';
import { TUNING } from './Tuning.js';

// Plane wraps a Rapier ball body + a low-poly paper mesh. Tracks high-level
// state (flying / grounded / crashed / launching). All physical reads go
// through helper methods that return fresh THREE vectors.

const FORWARD = new THREE.Vector3(0, 0, -1);
const UP      = new THREE.Vector3(0, 1, 0);
const RIGHT   = new THREE.Vector3(1, 0, 0);

export class Plane {
  constructor({ rapier, world }) {
    this.rapier = rapier;
    this.world = world;

    // Mesh — folded paper plane shape (simple flat triangles)
    this.group = new THREE.Group();
    this.mesh = buildPaperPlaneMesh();
    this.group.add(this.mesh);

    // Rigid body
    const bodyDesc = rapier.RigidBodyDesc.dynamic()
      .setLinearDamping(TUNING.LINEAR_DAMPING)
      .setAngularDamping(TUNING.ANGULAR_DAMPING)
      .setCcdEnabled(true);
    this.body = world.createRigidBody(bodyDesc);

    const colDesc = rapier.ColliderDesc.ball(TUNING.BODY_RADIUS)
      .setDensity(TUNING.MASS / ((4 / 3) * Math.PI * Math.pow(TUNING.BODY_RADIUS, 3)))
      .setFriction(0.4).setRestitution(0.2)
      .setActiveEvents(rapier.ActiveEvents.COLLISION_EVENTS);
    this.collider = world.createCollider(colDesc, this.body);

    this.state = 'flying';
    this.launchWindup = 0;
    this.launchFwd = null;
    this.crashFlash = 0;
    this.crumpleSpin = 0;

    this.lastSafePos = new THREE.Vector3();
    this.lastSafeFwd = new THREE.Vector3();
  }

  spawn(pos, fwd, speed) {
    const q = new THREE.Quaternion().setFromUnitVectors(FORWARD, fwd.clone().normalize());
    this.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: fwd.x * speed, y: fwd.y * speed, z: fwd.z * speed }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.state = 'flying';
    this.lastSafePos.copy(pos);
    this.lastSafeFwd.copy(fwd);
    this.mesh.scale.setScalar(1);
    this.mesh.rotation.set(0, 0, 0);
  }

  respawnAt(pos, fwd, speed) {
    this.spawn(pos, fwd, speed);
  }

  get mass() { return this.collider.mass(); }
  // Sphere moment of inertia: (2/5) * m * r². Used to scale torques so input
  // rates produce sane angular accelerations regardless of body size.
  get angularInertia() { return 0.4 * this.mass * TUNING.BODY_RADIUS * TUNING.BODY_RADIUS; }

  position() { const t = this.body.translation(); return new THREE.Vector3(t.x, t.y, t.z); }
  velocity() { const v = this.body.linvel(); return new THREE.Vector3(v.x, v.y, v.z); }
  quaternion() { const q = this.body.rotation(); return new THREE.Quaternion(q.x, q.y, q.z, q.w); }
  forward() { return FORWARD.clone().applyQuaternion(this.quaternion()); }
  up()      { return UP.clone().applyQuaternion(this.quaternion()); }
  right()   { return RIGHT.clone().applyQuaternion(this.quaternion()); }

  altitudeAboveTerrain(planet) { return planet.altitudeAbove(this.position()); }

  applyForce(v) { this.body.addForce({ x: v.x, y: v.y, z: v.z }, true); }
  applyImpulse(v) { this.body.applyImpulse({ x: v.x, y: v.y, z: v.z }, true); }
  applyTorque(v) { this.body.addTorque({ x: v.x, y: v.y, z: v.z }, true); }

  setVelocity(v) { this.body.setLinvel({ x: v.x, y: v.y, z: v.z }, true); }

  sync() {
    const t = this.body.translation();
    const q = this.body.rotation();
    this.group.position.set(t.x, t.y, t.z);
    this.group.quaternion.set(q.x, q.y, q.z, q.w);
    // Crumple animation
    if (this.state === 'crashed') {
      this.crumpleSpin += 0.4;
      this.mesh.rotation.set(this.crumpleSpin, this.crumpleSpin * 0.7, this.crumpleSpin * 0.3);
      this.mesh.scale.setScalar(0.6);
    } else {
      this.mesh.rotation.set(0, 0, 0);
      this.mesh.scale.setScalar(1);
    }
  }

  crash() {
    this.state = 'crashed';
    this.body.setAngvel({ x: 6, y: 3, z: 4 }, true);
  }

  land() {
    this.state = 'grounded';
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.lastSafePos.copy(this.position());
    this.lastSafeFwd.copy(this.forward());
  }

  bumpImpact(impact) {
    // medium bump — just transient nothing; collision resolution does the work.
  }

  beginLaunch() {
    if (this.state !== 'grounded') return;
    this.state = 'launching';
    this.launchWindup = TUNING.TAKEOFF_WINDUP;
    this.launchFwd = this.forward();
  }

  tickLaunch(input, dt) {
    if (this.state !== 'launching') return;
    this.launchWindup -= dt;
    if (this.launchWindup <= 0) {
      const fwd = this.forward();
      const up = this.position().clone().normalize();
      const v = fwd.clone().multiplyScalar(TUNING.TAKEOFF_SPEED).add(
        up.multiplyScalar(TUNING.TAKEOFF_SPEED * TUNING.TAKEOFF_UP_FRACTION)
      );
      this.setVelocity(v);
      this.state = 'flying';
    }
  }

  // Called by FlightController each fixed step after physics so cached
  // last-safe pos/fwd updates while flying.
  updateSafePoint() {
    if (this.state === 'flying') {
      this.lastSafePos.copy(this.position());
      this.lastSafeFwd.copy(this.forward());
    }
  }
}

function buildPaperPlaneMesh() {
  // Folded paper plane. Local axes: nose = -Z, up = +Y, right = +X.
  // Wings have negative dihedral (tips droop), and there's a central spine
  // that runs from nose up to the tail fin — so the plane reads as a
  // recognizable V-shape from behind even in perfectly level flight.

  const geom = new THREE.BufferGeometry();

  // Key vertices (using arrays for readability)
  const N  = [ 0,    0,    -1.4];   // nose
  const TC = [ 0,    0.18,  0.45];  // top of central spine (the fold peak), aft
  const TB = [ 0,    0.00,  0.55];  // tail base (center bottom)
  const LB = [-1.05, -0.32, 0.70];  // left wingtip (droops below center)
  const RB = [ 1.05, -0.32, 0.70];  // right wingtip
  const FT = [ 0,    0.55,  0.70];  // tail fin top

  // Five triangle faces, each face listed CCW from its outward-facing side.
  // Wing top surfaces (visible from above) and bottom surfaces (visible from
  // below) share the same triangle since the material is DoubleSide.
  const verts = new Float32Array([
    // Left wing upper face: nose → spine-top → left tip
    ...N, ...TC, ...LB,
    // Left wing lower face: nose → tail-base → left tip (closes the V from underneath)
    ...N, ...LB, ...TB,
    // Right wing upper face: nose → right tip → spine-top
    ...N, ...RB, ...TC,
    // Right wing lower face
    ...N, ...TB, ...RB,
    // Tail fin (vertical triangle): from spine peak up to fin tip down to tail base
    ...TC, ...FT, ...TB,
  ]);

  geom.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geom.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    color: 0xf4ede0,
    side: THREE.DoubleSide,
    roughness: 0.7,
    metalness: 0,
    flatShading: true,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.scale.setScalar(1.6);
  mesh.castShadow = false;

  // Add a subtle darker "fold line" along the spine to read the silhouette
  // better — drawn as a thin line geometry from nose to fin-top to tail-base.
  const lineGeom = new THREE.BufferGeometry();
  const linePts = new Float32Array([...N, ...TC, ...TC, ...FT, ...FT, ...TB, ...TB, ...N]);
  lineGeom.setAttribute('position', new THREE.BufferAttribute(linePts, 3));
  const lineMat = new THREE.LineBasicMaterial({ color: 0x6f5a3a, transparent: true, opacity: 0.65 });
  const folds = new THREE.LineSegments(lineGeom, lineMat);
  folds.scale.setScalar(1.6);
  mesh.add(folds);

  return mesh;
}
