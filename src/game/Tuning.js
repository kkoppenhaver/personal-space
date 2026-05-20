// Single source of truth for flight feel. Live-tunable via ?dev=1 panel.

export const TUNING = {
  // Plane body
  MASS: 0.08,
  BODY_RADIUS: 1.2,         // larger than visual mesh: avoids tunneling through terrain at speed
  LINEAR_DAMPING: 0.05,
  ANGULAR_DAMPING: 8.0,

  // Cruise (the engine). Two cruise speeds blended by atmospheric density:
  // SPACE_CRUISE_SPEED in vacuum, CRUISE_SPEED inside atmosphere.
  CRUISE_SPEED: 18,
  SPACE_CRUISE_SPEED: 28,
  CRUISE_HALFLIFE: 0.6,
  MAX_SPEED: 45,            // hard cap, just in case

  // Atmosphere + gravity
  ATM_TOP: 150,
  // No real gravity force. Atmospheric "orbit" comes from kinematic curving:
  // orbital-tracking ω rotates fwd to stay tangent, auto-cruise pushes velocity
  // along fwd, and a "stay at altitude" force cancels any radial drift when the
  // player isn't actively pitching. Pitching up/down disables that cancel so
  // the player can change altitude deliberately.
  ALTITUDE_HOLD_GAIN: 4.0,

  // Player torques (target angular velocity, rad/s, when input = ±1)
  PITCH_RATE: 2.0,
  BANK_RATE: 3.0,
  BANK_YAW_GAIN: 0.55,

  // Brake (held SHIFT). Subtracts from target speed; floors at BRAKE_FLOOR of cruise.
  BRAKE_AMOUNT: 12,
  BRAKE_FLOOR: 0.3,

  // Held throttle (SPACE). Adds on top of base cruise; clamps to MAX_SPEED.
  // Ramp halflife keeps the press from feeling instant — short enough to feel
  // responsive, long enough that brief taps don't surge.
  THROTTLE_BOOST: 17,
  THROTTLE_HALFLIFE: 0.35,

  // Takeoff
  TAKEOFF_SPEED: 12,
  TAKEOFF_UP_FRACTION: 0.3,
  TAKEOFF_WINDUP: 0.2,

  // Kinematic attitude time constants (seconds to reach target).
  // AUTO_LEVEL_TIME is intentionally slow so atmospheric entry doesn't snap the
  // nose up — player has time to keep diving with pitch input if desired.
  AUTO_LEVEL_TIME: 2.5,
  AUTO_ROLL_TIME:  1.0,

  // Collisions
  COLLISION_SOFT: 4,
  COLLISION_HARD: 8,
  RESPAWN_DELAY: 1.0,

  // Camera
  FOV_BASE: 60,
  FOV_PER_SPEED: 0.6,
  FOV_MAX_EXTRA: 18,
  CAM_SPRING_HALFLIFE: 0.12,
  CAM_LOOKAHEAD: 0.5,
  CAM_ROLL_PASSTHROUGH: 0.15,

  // Input smoothing (halflife in seconds — how fast pitch/bank ramp toward target).
  // Slightly slower for less abrupt transitions; auto-corrections fade in
  // proportionally to (1 - |smoothed input|), so the handoff is gradual.
  INPUT_SMOOTH_HALFLIFE: 0.18,

  // Player rate caps (rad/s at full input). Slightly gentler than before to
  // reduce overshoot and the post-input wobble.
  // (PITCH_RATE/BANK_RATE below override the older values.)

  // LLM approach commitment thresholds. Tier 2 ("approach") fires for a
  // planet when EITHER the plane is in its atmosphere OR it is roughly
  // aimed at the planet from close enough to count as committed.
  APPROACH_DOT: 0.85,         // dot(fwd, toPlanetUnit) ≥ this
  APPROACH_DISTANCE: 1500,    // metres beyond planet.radius

  // World
  PLANET_RADIUS: 100,
  PLANET_SEED: 1337,
  // Spawn out in space, planet ahead. Atmosphere top is PLANET_RADIUS+ATM_TOP=400,
  // so ~200m of pre-atmosphere flight to build anticipation (~11s at cruise).
  SPAWN_DISTANCE: 600,
};

// Make tuning live-editable from console: window.TUNING.CRUISE_SPEED = 25
if (typeof window !== 'undefined') {
  window.TUNING = TUNING;
}
