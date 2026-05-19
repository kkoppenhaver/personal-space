import * as THREE from 'three';
import { TUNING } from './Tuning.js';
import { computeKinematicAngvel } from './Aero.js';
import { damp } from '../util/math.js';

// "Paper spaceship" flight: both LINEAR velocity and ANGULAR velocity are set
// kinematically each fixed step.
//
//   Cruise: v ← lerp(v, fwd*targetSpeed, alpha). When altitude-lock is active
//   (in-atmosphere, no pitch), the target is projected onto the tangent plane
//   so cruise drives purely-tangential velocity — no radial drift to be fought.
//
//   Attitude: ω ← computeKinematicAngvel(...). Player input + atmospheric
//   corrections, all rho-weighted and player-weighted so handoffs are smooth.

export class FlightController {
  constructor() { this.reset(); }

  reset() {
    this.smoothedPitch = 0;
    this.smoothedBank = 0;
    this.throttleBoost = 0;
  }

  update(plane, input, dt, atmosphere, planet) {
    if (plane.state === 'grounded') {
      plane.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      plane.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      if (input.flickEdge) plane.beginLaunch();
      plane.sync();
      return;
    }
    if (plane.state === 'launching') { plane.tickLaunch(input, dt); plane.sync(); return; }
    if (plane.state === 'crashed')   { plane.sync(); return; }

    // --- Smooth player input ---
    this.smoothedPitch = damp(this.smoothedPitch, input.pitch, TUNING.INPUT_SMOOTH_HALFLIFE, dt);
    this.smoothedBank  = damp(this.smoothedBank,  input.bank,  TUNING.INPUT_SMOOTH_HALFLIFE, dt);
    const pitchUse = Math.abs(this.smoothedPitch) < 0.01 ? 0 : this.smoothedPitch;
    const bankUse  = Math.abs(this.smoothedBank)  < 0.01 ? 0 : this.smoothedBank;
    const pitchWeight = 1 - Math.min(1, Math.abs(pitchUse));

    // (Flick boost retired — Space is now the held throttle. `flickEdge` is
    // still drained from input and consumed by Plane.beginLaunch for takeoff.)

    // --- State refs ---
    const pos = plane.position();
    const v   = plane.velocity();
    const fwd = plane.forward();
    const rho = atmosphere.density(pos);
    const radialOut = pos.clone().sub(planet.center).normalize();

    // --- Kinematic cruise (linear velocity) ---
    // Cruise speed depends on where you are: faster in space, slower in atmosphere.
    const baseCruise = TUNING.SPACE_CRUISE_SPEED + (TUNING.CRUISE_SPEED - TUNING.SPACE_CRUISE_SPEED) * rho;

    // Held throttle (Space). Ramps the boost up while held, decays when
    // released so releasing doesn't snap speed back to baseline. Pure additive
    // — clamps to MAX_SPEED downstream.
    const throttleTarget = input.throttle ? TUNING.THROTTLE_BOOST : 0;
    this.throttleBoost = damp(this.throttleBoost, throttleTarget, TUNING.THROTTLE_HALFLIFE, dt);

    let targetSpeed = baseCruise + this.throttleBoost;
    if (input.brake) {
      targetSpeed -= TUNING.BRAKE_AMOUNT;
      const floor = baseCruise * TUNING.BRAKE_FLOOR;
      if (targetSpeed < floor) targetSpeed = floor;
    }

    let target = fwd.clone().multiplyScalar(targetSpeed);
    const lockWeight = rho * pitchWeight;
    if (lockWeight > 0.001) {
      // Project target onto tangent plane (proportional to lockWeight).
      const tRadial = target.dot(radialOut);
      target.sub(radialOut.clone().multiplyScalar(tRadial * lockWeight));
    }

    const cruiseAlpha = 1 - Math.pow(0.5, dt / TUNING.CRUISE_HALFLIFE);
    const newV = v.clone().lerp(target, cruiseAlpha);
    if (newV.lengthSq() > TUNING.MAX_SPEED * TUNING.MAX_SPEED) newV.setLength(TUNING.MAX_SPEED);
    plane.body.setLinvel({ x: newV.x, y: newV.y, z: newV.z }, true);

    // --- Kinematic attitude (angular velocity) ---
    const desiredAngvel = computeKinematicAngvel(plane, planet, rho, pitchUse, bankUse);
    plane.body.setAngvel({ x: desiredAngvel.x, y: desiredAngvel.y, z: desiredAngvel.z }, true);

    plane.updateSafePoint();
    plane.sync();
  }
}
