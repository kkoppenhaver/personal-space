import * as THREE from 'three';
import { TUNING } from './Tuning.js';
import { damp, dampVec3, smoothstep } from '../util/math.js';

// Camera that:
//   - Inside atmosphere: yaw-only frame anchored to radial-up (stable horizon)
//   - In space: classic chase
//   - Blend by atmFactor with slerp
//   - FOV breathes with speed, slight roll passthrough, lookat lead

const TMP_POS = new THREE.Vector3();
const TMP_TGT = new THREE.Vector3();
const TMP_UP  = new THREE.Vector3();

export class CameraRig {
  constructor({ camera }) {
    this.camera = camera;
    this.smoothedPos = new THREE.Vector3();
    this.smoothedTgt = new THREE.Vector3();
    this.smoothedUp  = new THREE.Vector3(0, 1, 0);
    this.smoothedFov = TUNING.FOV_BASE;
    this.initialized = false;
  }

  update(plane, planet, atmosphere, dt) {
    const planePos = plane.position();
    const planeFwd = plane.forward();
    const planeUp  = plane.up();
    const planeRight = plane.right();
    const v = plane.velocity();
    const speed = v.length();

    const rho = atmosphere.density(planePos);
    const atmFactor = smoothstep(0.0, 0.4, rho);

    // ----- ATMOSPHERE CAM -----
    // Camera sits BEHIND the plane along its actual forward direction (so it
    // tracks pitch and you can see what you're flying into), but its UP axis
    // is anchored to radialUp so the horizon stays stable instead of rolling
    // with every micro-bank. This is the "behind the plane, horizon-locked"
    // configuration the player expects.
    const radialUp = planePos.clone().sub(planet.center).normalize();

    const offsetBack = 6.5;
    const offsetUp   = 1.8;

    const atmCamPos = planePos.clone()
      .addScaledVector(planeFwd, -offsetBack)
      .addScaledVector(radialUp, offsetUp);

    const lookahead = TUNING.CAM_LOOKAHEAD * Math.min(speed, 30) * 0.05;
    const atmTgt = planePos.clone().addScaledVector(planeFwd, lookahead);
    const atmUp  = radialUp.clone();

    // Small roll passthrough so banks read visually without inducing nausea
    atmUp.lerp(planeUp, TUNING.CAM_ROLL_PASSTHROUGH).normalize();

    // ----- SPACE CAM (classic chase) -----
    const spaceCamPos = planePos.clone()
      .addScaledVector(planeFwd, -offsetBack)
      .addScaledVector(planeUp, offsetUp);
    const spaceTgt = planePos.clone().addScaledVector(planeFwd, lookahead);
    const spaceUp  = planeUp.clone();

    // ----- BLEND -----
    TMP_POS.copy(spaceCamPos).lerp(atmCamPos, atmFactor);
    TMP_TGT.copy(spaceTgt).lerp(atmTgt, atmFactor);
    TMP_UP.copy(spaceUp).lerp(atmUp, atmFactor).normalize();

    if (!this.initialized) {
      this.smoothedPos.copy(TMP_POS);
      this.smoothedTgt.copy(TMP_TGT);
      this.smoothedUp.copy(TMP_UP);
      this.initialized = true;
    } else {
      dampVec3(this.smoothedPos, this.smoothedPos, TMP_POS, TUNING.CAM_SPRING_HALFLIFE, dt);
      dampVec3(this.smoothedTgt, this.smoothedTgt, TMP_TGT, TUNING.CAM_SPRING_HALFLIFE * 0.9, dt);
      dampVec3(this.smoothedUp,  this.smoothedUp,  TMP_UP,  TUNING.CAM_SPRING_HALFLIFE * 1.2, dt);
      this.smoothedUp.normalize();
    }

    // FOV breathe
    const extra = Math.min(TUNING.FOV_MAX_EXTRA, Math.max(0, speed - TUNING.CRUISE_SPEED) * TUNING.FOV_PER_SPEED);
    const targetFov = TUNING.FOV_BASE + extra;
    this.smoothedFov = damp(this.smoothedFov, targetFov, 0.15, dt);

    this.camera.position.copy(this.smoothedPos);
    this.camera.up.copy(this.smoothedUp);
    this.camera.lookAt(this.smoothedTgt);
    if (Math.abs(this.camera.fov - this.smoothedFov) > 0.02) {
      this.camera.fov = this.smoothedFov;
      this.camera.updateProjectionMatrix();
    }
  }
}
