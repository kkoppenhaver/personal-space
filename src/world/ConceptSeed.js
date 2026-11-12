// Concept seeding (Phase 14a) — the deterministic inputs to the spawn-time
// concept call: tier, sparks, register, name initial.
//
// The rolls themselves live in /shared/planet-dice.js because the worker
// re-derives them from the planet's seeds (it does not trust a
// client-supplied prompt context). This module re-exports them so game
// code keeps importing from one place.

export {
  rollTier,
  rollSparks,
  rollRegister,
  rollNameInitial,
  tierStats,
  planetSeedFor,
  conceptContextFor,
} from '../../shared/planet-dice.js';
