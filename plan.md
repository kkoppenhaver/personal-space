# Personal Space — Running Plan

A single-player browser game: pilot a paper airplane through an LLM-coauthored procedurally generated universe. Tiny planets (Le Petit Prince scale), LLM names places, you keep a logbook of where you've been.

Plan-of-record. Edit freely as decisions evolve. Older versions live in `/Users/keanan/.claude/plans/dreamy-jumping-zephyr.md` (the original brainstorm) but this file is the source of truth going forward.

---

## Done (Phase 1 — MVP single-system loop)

- **Boot + render loop + Rapier physics** — `src/main.js`, `src/game/GameLoop.js`, 60Hz fixed timestep with accumulator.
- **Plane** (`src/game/Plane.js`) — Rapier ball body w/ ~1.2m radius (prevents tunneling), low-poly paper plane mesh with anhedral wings, central spine fold, vertical tail fin, and darker fold lines for silhouette.
- **Flight controller** (`src/game/FlightController.js`) — fully kinematic ("paper spaceship") model.
  - `setLinvel` blends velocity toward `fwd * targetSpeed` each step.
  - `setAngvel` directly written from `computeKinematicAngvel`.
  - Cruise speed: 18 m/s in atmosphere, 28 m/s in space (rho-blended).
  - Hard altitude lock when no pitch input — radial velocity is projected out of the target so the plane orbits at constant altitude.
  - Smoothed pitch/bank inputs (halflife 0.18s) prevent post-input wobble.
  - Auto-corrections (orbital tracking, auto-roll) fade by `(1 - |input|)` so handoffs are gradual.
- **Aero corrections** (`src/game/Aero.js`):
  - Orbital tracking — `ω = (pos × v) / r²` — rotates `fwd` to stay tangent as the plane orbits. Geometric, not aerodynamic; not scaled by rho.
  - Auto-roll — gentle rotation toward planeUp ≈ radialUp when not banking. (Auto-level removed — was over-correcting nose-up.)
  - Player pitch (around plane.right), bank (roll around fwd + coordinated yaw around planeUp).
  - Bank yaw uses `+planeUp * bankInput` so ArrowLeft turns left + ArrowRight turns right.
- **Camera rig** (`src/game/CameraRig.js`) — chase camera behind plane along actual fwd direction (so it tracks pitch); up axis locked to radialUp in atmosphere for stable horizon; classic chase in space; smooth slerp blend at the boundary. FOV breathes with speed.
- **Terrain + planet** (`src/world/Planet.js`, `TerrainGen.js`, `Landmarks.js`, `Features.js`):
  - Subdivided icosahedron, multi-octave noise displacement, vertex colors banded by elevation.
  - Trimesh Rapier collider matching the mesh.
  - Hero landmark "spires" picked from elevation peaks.
  - ~1200 instanced low-poly rocks + flora distributed by Poisson-ish sampling, weighted by elevation band.
- **Atmosphere shell + transitions** (`src/world/Atmosphere.js`) — translucent shell, rho-derived sky color, "↓ ENTERING ATMOSPHERE ↓" / "↑ ENTERING SPACE ↑" toasts and white flash at the boundary. `ATM_TOP = 150m`.
- **HUD** (`src/ui/HUD.js`) — speed, altitude-above-terrain, atmospheric density, plane state, toasts, landmark text.
- **Debug HUD** (`src/ui/DebugHUD.js`) — fixed-width monospace overlay (top-left) showing pos, vel, fwd/up/right, angvel, tilt angles, raw + smoothed input, which corrections are firing, flick state.
- **Planet nav indicators** (`src/ui/PlanetNav.js`) — DOM-overlay rings with labels at edge of viewport showing tracked objects' distance + direction. Off-screen targets clamped to viewport edges as arrows. Per-target visibility gating (e.g. landing pad only shows in atmosphere).
- **Landing zone** (`src/world/LandingZone.js`) — one runway per planet, deterministic from seed:
  - 40m × 9m rectangular asphalt strip with edge stripes, dashed centerline, threshold chevrons, touchdown bar.
  - 220m tall beacon column (orange core + tan halo) visible from atmosphere top for long-distance spotting.
  - Surrounding terrain flattened to a tangent plane (inner radius ~22m fully flat, outer ~44m smoothstep blend back to original).
  - Trimesh collider rebuilt on flattened geometry so collisions and visuals agree.
  - Features (flora/rocks) skip the flattened zone.
  - "Claim" trigger: plane in `grounded` state within pad center radius → fires "<NAME> · CLAIMED" toast + logbook entry + Tier 3 lore reveal.
- **Crash recovery** — hard collision (>8 m/s normal velocity) triggers `state=crashed`, plane crumples for 1s, then respawns at `ATM_TOP + 30m` directly above the crash site with the pre-crash heading tangentially projected.
- **Logbook** (`src/ui/Logbook.js`) — slide-out panel (L key), persisted to `localStorage` under `paper-airplane:logbook:v1`. Entry on first landing per planet.
- **LLM client** (`src/llm/LLMClient.js`, `Prompts.js`, `Placeholder.js`) — 3-tier scheduler (Haiku ping / Sonnet approach / Sonnet landing), in-flight dedupe, AbortController timeouts, exponential backoff, deterministic Placeholder fallback if Worker unreachable.
- **Cloudflare Worker** (`worker/src/index.js`) — **DEPLOYED** at `https://paper-airplane-llm.keanan-75b.workers.dev`. Anthropic API proxy with KV cache by `(tier, seed, normalizedContext)`. Models: `claude-haiku-4-5` for Tier 1, `claude-sonnet-4-6` for Tier 2/3. JSON-schema-enforced via tool use. Origin allowlist for CORS.
- **Lighting** — sun directional light (0.75), opposite-side fill (0.45), strong hemisphere (0.95), ambient (0.25). No truly dark side on planets.

---

## Up next (Phase 2 — galaxy streaming)

Goal: deliver the "infinite universe" promise from the original brainstorm. Multiple planets per system, then multiple systems, navigable indefinitely.

### Build order

| # | Task | File(s) | Done? |
|---|------|---------|-------|
| 13 | SolarSystem class | `src/world/SolarSystem.js`, refactor `main.js` | ☑ |
| 14 | Multi-planet PlanetNav + Tier 1 ping HUD strip | `src/ui/PlanetNav.js`, `src/ui/HUD.js`, `main.js` | ☑ |
| 15 | Origin.js — floating-origin rebasing | `src/world/Origin.js` (new) | ☑ |
| 16 | Galaxy.js — system streaming | `src/world/Galaxy.js` (new) | ☑ |
| 17 | Logbook revisit-by-coordinates | `src/ui/Logbook.js`, `main.js` | ☐ |

**Task 13 notes (done):** `SolarSystem` builds a seeded sun + 3–6 planets at log-spaced orbits (200m–5km) with small inclination jitter. Each planet owns its own `Atmosphere` and `LandingZone`. `activePlanetFor(pos)` resolves the "current" planet (atmosphere-containing → else closest). Collision events look up the planet via a `colliderHandle → planet` Map. Crashes, recovery, landing-zone claims, and atmosphere-crossing toasts all dispatch off the active planet, and switching between atmospheres emits exit-then-enter toasts cleanly. `system.defaultSpawn()` puts the plane outside planet[0]'s atmosphere on the deep-space side, aimed tangentially.

**Bonus (done):** Held throttle on **SPACE** (`TUNING.THROTTLE_BOOST = 17`, ramp halflife 0.35s, capped at `MAX_SPEED=45`). Replaces the old tap-flick boost — `flickEdge` is still drained but only consumed by `Plane.beginLaunch` for takeoff from the ground.

**Bonus (done):** Basic pause menu (ESC). `GameLoop.setPaused(bool)` skips `onFixedStep` and zeroes the accumulator so resume doesn't fire a catch-up burst. Independent `window.keydown` listener so it works while the sim is frozen; `input.drain()` on resume prevents stale edges. DOM overlay with title, resume button, and controls summary.

**Task 14 notes (done):** Tier 1 pings fan out to every planet at boot; each result becomes a chip in the `#pings` strip labeled with a slot name (`P{i+1}`) until Tier 2 names it. Tier 2 ("approach") is commitment-gated per fixed step: fires once when the plane is either inside the planet's atmosphere or aimed at it (`dot(fwd, toPlanet) ≥ APPROACH_DOT=0.85`) within `radius + APPROACH_DISTANCE=1500m`. Per-planet landing-pad nav indicators replace the single shared proxy; each one's `visible()` checks its own atmosphere, so only the pad of the planet you're currently in shows up. HUD state row updates with the active planet's name on every planet change.

**Task 16 notes (done):** `src/world/Galaxy.js` owns a sparse `cellKey → SolarSystem` map. Cell occupancy is deterministic from `hash(galaxySeed, cellCoord)` at `SYSTEM_DENSITY=0.45` (cached on first miss). `CELL_SIZE=15000`, `SPAWN_RADIUS=22500`, `CULL_RADIUS=35000`, `MAX_SPAWNS_PER_STEP=1` bound mid-flight construction stutter. Home cell `(0,0,0)` is force-occupied at boot so the player always has a starting system. `galaxy.update(planeRenderPos)` runs at end of each fixed step (after the floating-origin rebase) and walks candidate cells within `SPAWN_RADIUS` to spawn, then any loaded system beyond `CULL_RADIUS` to despawn. `SolarSystem` now accepts `galaxyOrigin` and `renderOrigin` so it can be placed anywhere in render space; `defaultSpawn` uses `renderOrigin` instead of world origin. `SolarSystem.dispose()` removes Rapier bodies, walks the group tree to dispose geometries/materials, detaches from the parent. Per-planet HUD ping and PlanetNav tracks are now keyed by planet seed and registered via `onSystemSpawned` / `onSystemDespawned` callbacks. Pad nav indicators stay parented under `planet.group` so floating-origin still works. The starfield moved from per-system to Galaxy (untinted) since multiple suns made per-system tinting moot. `activePlanetFor` and `planetForColliderHandle` aggregate across all loaded systems via a generator `allPlanets()`. Sky tint reads from `activeSystem.sunColor` instead of a captured singleton.

**Task 15 notes (done):** `src/world/Origin.js` tracks `galaxyOrigin` (the galaxy-space coordinate currently mapped to render `(0,0,0)`) and a 5km `threshold`. After each fixed step, `origin.maybeRebase(plane.position())` returns a shift vector when the plane exceeds threshold; the same shift is applied to `plane.translate()` and `system.translate()`. `Planet.translate` updates `center`, `group.position`, and the Rapier body. `Atmosphere.translate` re-syncs mesh position + the `uPlanetCenter` shader uniform from the (already-moved) planet. `SolarSystem.translate` walks every planet/atmosphere pair, shifts the sun, and leaves the starfield at scene origin (skybox treatment). Pad nav proxies are now parented under `planet.group` using local `surfacePoint` so they follow rebases for free. Reset and `__GAME.snapshot()` pull a fresh `system.defaultSpawn()` each call since planet centers move in render space. `origin` is exposed on `window.__GAME` for console inspection; `origin.toGalaxy(renderPos)` is the conversion Task 16/17 will use for system streaming and per-entry coords.

### Task 13 — SolarSystem.js

Wrap the current single-planet world in a `SolarSystem` class with:

- One **sun** at system origin: emissive sphere + point light, distinct color per system (from seed).
- **3–6 planets**, deterministic from system seed:
  - Orbital radius: spread between 200m and 5km from sun.
  - Planet seed = `hash(systemSeed, planetIndex)`.
  - Static placement is fine for v1; can add Keplerian-ish orbits later.
- Each planet keeps its current logic — terrain, atmosphere, landing zone, LLM hookup. The system is just an aggregator.
- Plane spawns at the system's edge (outside all planet atmospheres) with a planet ahead.
- A **system starfield** tinted by sun color.
- Atmosphere/altitude logic in `main.js` needs to ask "which planet's atmosphere am I in?" — pick the closest (or one that contains us).

Refactor checklist:
- `main.js` currently has `const planet = new Planet(...)`. Becomes `const system = new SolarSystem(...)`; `const activePlanet = system.activePlanetFor(plane.position())`.
- Collision events bound to a *list* of planet colliders.
- Landing zone claim logic walks each planet's landing zone.

### Task 14 — Multi-planet nav + Tier 1 pings

- Register a `PlanetNav` target for every planet in the system. Color varies (or stays constant + each labeled with planet name).
- Tier 1 fires for each planet on system entry. Each result shows up in the HUD `#pings` strip with the planet name + teaser.
- Tier 2 (approach) fires when player commits toward a planet: `dot(fwd, toPlanet) > 0.85` AND distance < APPROACH_RADIUS. Per-planet, in-flight dedupe.
- Landing zone nav indicator gates to "show only when in *that* planet's atmosphere."

### Task 15 — Floating origin

- Track a `currentOrigin` vector in galaxy coordinates.
- When plane drifts past ~5km from `(0,0,0)` in Three space, rebase: subtract `delta` from `currentOrigin`, translate every active Rapier body + Three mesh by `-delta`.
- Rebase at a fixed-step boundary (between steps), not mid-step.
- Bodies needing translation:
  - Plane
  - All planet bodies in the active system
  - The sun
  - Starfield (or treat as infinitely-far skybox — easier)
- Sanity test: fly 10 minutes in one direction, assert `plane.position().length() < REBASE_THRESHOLD` always; planets render in correct relative positions; no visible pop.

### Task 16 — Galaxy streaming

- `Galaxy` maintains a sparse hash grid keyed by `floor(galaxyCoord / SYSTEM_SPACING)`. Each cell either has a system or is empty (deterministic from `galaxySeed + cellCoord`).
- Each step: project player position into galaxy coords; spawn systems in cells within `SPAWN_RADIUS`; despawn beyond `CULL_RADIUS`.
- "Spawn ahead" — bias spawn radius along player velocity vector so candidate worlds appear in front, not surrounding.
- Each system, when spawned, computes its seed, fires Tier 1 pings for at least one of its planets so they show in the HUD ping strip.
- When player crosses into a new system's "active sphere" (whatever defines being "in" the system), switch the active planet logic to it.
- Cull-behind keeps Three.js mesh count and Rapier body count bounded.

### Task 17 — Logbook revisit-by-coords

- Store `galaxyCoord` and `systemSeed` per logbook entry (already store seed; add coord).
- Existing Worker KV cache makes content deterministic per seed — same coord → same name/lore.
- Verification: visit planet, write down its name, fly to next system, fly back, see same name.

### Open questions — Logbook

- **Persistence.** Today the logbook is `localStorage` only — wipes per-browser, doesn't sync. Decide: stay local? Cloud-backed (Worker + KV/D1) with anonymous user id? Export/import JSON? Account-based?
- **Contents.** What goes in each entry beyond name + biome + timestamp? Candidates: thumbnail/screenshot of the planet (canvas snapshot at claim), full lore text, landmark list, claim coords, time-to-land, path traced. Pick what shows up on the entry detail page.

---

## Phase 3+ — Vision roadmap

Loosely ordered by impact, not necessarily build order.

- **Audio.** Wind volume tracks airspeed. Paper crinkle on collisions. Ambient biome tones (volcanic = low rumble, ice = high crystal whine, etc.). Speech-rate ambient that swells on atmosphere entry.
- **Weather / wind fields.** Per-planet noise → vector field. Aero applies it as a force perpendicular to plane forward. Visible as drifting particles or grass sway.
- **Alien fauna.** A few instanced flocking creatures per biome. React to plane proximity (scatter, follow, etc.). Maybe a sound on encounter.
- **Shareable seeds.** "Copy link to current location" → URL with `?seed=<galaxySeed>&coord=<x,y,z>` → recipient lands in same universe at same spot. Worker KV makes names identical for them.
- **Performance pass.** Planet LOD swap at distance, frustum-cull instanced features, worker-thread noise gen, atlas instance for features.
- **More art directions.** The original brainstorm had four candidate aesthetic directions (full papercraft, Ghibli-painterly, hand-drawn sketched, stylized realism). We're closest to "Ghibli-painterly low-poly w/ paper-plane protagonist" now. Could expose a runtime toggle.
- **Better landing feel.** Touch-down particles. Visible "claimed" flag/banner on the runway. A short pause + bigger lore reveal on claim.
- **Mini-tutorial.** First-time atmosphere entry shows a hint about pitch input. First landing shows takeoff hint.
- **Logbook UI polish.** Per-entry detail page with full lore. Sortable. Maybe a tiny rendering of each planet.

---

## Tuning constants (the things you'll want to tweak)

In `src/game/Tuning.js`. Most-touched:

```
CRUISE_SPEED        18    m/s  — atmospheric cruise
SPACE_CRUISE_SPEED  28    m/s  — vacuum cruise
CRUISE_HALFLIFE     0.6   s    — velocity convergence halflife
ATM_TOP            150    m    — atmosphere thickness
PITCH_RATE          2.0   rad/s
BANK_RATE           3.0   rad/s
BANK_YAW_GAIN       0.55
AUTO_ROLL_TIME      1.0   s
INPUT_SMOOTH_HALFLIFE 0.18 s
FOV_BASE           60     °
FOV_PER_SPEED       0.6   °/(m/s)
COLLISION_HARD      8     m/s  — above = crash
COLLISION_SOFT      4     m/s  — below + level = land
```

All live-editable from the dev console as `window.TUNING.<KEY> = value`.

---

## Operating notes

- Dev server: `npx vite` (defaults to `127.0.0.1:5173`).
- Connect to deployed worker: `?worker=https://paper-airplane-llm.keanan-75b.workers.dev` or `localStorage.setItem('paper-airplane:worker', 'https://...')`.
- Clear LLM cache: `localStorage.removeItem('paper-airplane:llmcache:v1')`.
- Clear logbook: `localStorage.removeItem('paper-airplane:logbook:v1')`.
- Debug telemetry: top-left of viewport, always on. To remove later: comment out `debugHUD.update(...)` in `main.js` render callback.
- Live inspect: `window.__GAME.inspect()` in dev console for pos/vel/fwd/angvel snapshot.
- Reset plane: press `R`. Force respawn: `window.__GAME.snapshot()`.

---

## Known issues / loose ends

- The Cloudflare Worker has no rate limiting yet — runs on Anthropic API budget. Add a per-IP token bucket via Durable Object if hosting publicly.
- Worker allows any origin matching the allowlist — defeats casual scrapers but not determined ones. Acceptable for personal use.
- Planet seed is hardcoded to `1337` in `Tuning.js`. Phase 2 makes this dynamic per system/planet.
- Debug HUD covers a useful chunk of viewport. Either dismiss it later or hide-by-default with a `?debug=1` toggle.
- The runway is always oriented along the planet's "east" tangent at the chosen surface point — not aligned with any meaningful approach corridor. Could make it directionally meaningful later (face the prevailing wind).
- Auto-roll's anti-inversion guard occasionally produces a small wobble when planeUp is right at ±90° from radialUp. Rarely encountered.
