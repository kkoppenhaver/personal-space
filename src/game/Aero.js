import * as THREE from 'three';
import { TUNING } from './Tuning.js';

// Kinematic attitude. All atmospheric corrections are SMOOTHLY scaled:
//   - by rho   → fade across the atmosphere boundary
//   - by (1 - |player input|) → so corrections ease IN as player input eases OUT
//     instead of toggling abruptly when the smoothed input crosses zero. That
//     toggle was the source of the "figure-8 wobble" after releasing keys.

const TMP1 = new THREE.Vector3();
const TMP2 = new THREE.Vector3();
const TMP3 = new THREE.Vector3();

export function computeKinematicAngvel(plane, planet, rho, pitchInput, bankInput) {
  const omega = new THREE.Vector3(0, 0, 0);

  const fwd = plane.forward();
  const planeUp = plane.up();
  const right = plane.right();
  const pos = plane.position();
  const v = plane.velocity();

  const r = pos.distanceTo(planet.center);
  const radialUp = TMP1.copy(pos).sub(planet.center).divideScalar(r || 1);

  // Smooth atmospheric weight (0 in space, 1 deep atmosphere)
  const atm = Math.min(1, Math.max(0, rho));

  // Smooth player-override weights: 1 when player has zero input on this axis,
  // 0 when player is at full deflection.
  const pitchWeight = 1 - Math.min(1, Math.abs(pitchInput));
  const bankWeight  = 1 - Math.min(1, Math.abs(bankInput));

  // --- (1) Orbital tracking: ω at which the local tangent direction rotates
  // as the plane moves. This is GEOMETRIC, not aerodynamic — fwd needs to
  // rotate at exactly this rate (no scaling) to keep its angle to the surface
  // constant during orbit. Scaling it by rho previously caused fwd to "lag"
  // and appear to rise as the plane orbited. Gated only on pitch input.
  if (pitchWeight > 0.001 && atm > 0.001) {
    TMP2.copy(pos).sub(planet.center);
    TMP3.crossVectors(TMP2, v).divideScalar(r * r || 1);
    omega.add(TMP3.multiplyScalar(pitchWeight));
  }

  // --- (2) Auto-level pitch correction: REMOVED.
  // The orbital tracking (1) already rotates fwd at the orbital rate so the
  // plane keeps its attitude relative to the local horizon — pointing nose-
  // down stays nose-down as you orbit. Auto-pulling fwd to horizontal was
  // fighting the player whenever they entered atmosphere mid-dive.

  // --- (3) Auto-roll
  if (bankWeight > 0.001 && atm > 0.001) {
    const dotFwd = radialUp.dot(fwd);
    TMP2.copy(radialUp).sub(TMP3.copy(fwd).multiplyScalar(dotFwd));
    if (TMP2.lengthSq() > 1e-4) {
      TMP2.normalize();
      TMP3.crossVectors(planeUp, TMP2);
      if (TMP3.lengthSq() < 1e-4 && planeUp.dot(TMP2) < -0.5) {
        TMP3.copy(fwd).multiplyScalar(0.5);
      }
      omega.add(TMP3.multiplyScalar(atm * bankWeight / TUNING.AUTO_ROLL_TIME));
    }
  }

  // --- (4) Player pitch
  if (pitchInput !== 0) {
    TMP2.copy(right).multiplyScalar(pitchInput * TUNING.PITCH_RATE);
    omega.add(TMP2);
  }

  // --- (5) Player bank: roll + coordinated yaw around planeUp
  if (bankInput !== 0) {
    TMP2.copy(fwd).multiplyScalar(-bankInput * TUNING.BANK_RATE);
    omega.add(TMP2);
    TMP2.copy(planeUp).multiplyScalar(bankInput * TUNING.BANK_RATE * TUNING.BANK_YAW_GAIN);
    omega.add(TMP2);
  }

  return omega;
}
