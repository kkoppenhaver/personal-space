# Personal Space

A single-player browser game: pilot a paper airplane through an LLM-coauthored procedurally generated universe. Tiny planets at Le Petit Prince scale, an LLM names the places you find, and a logbook tracks where you've been.

![Screenshot](docs/screenshot.png)

## Run it locally

```
npm install
npm run dev
```

Open the URL Vite prints (defaults to `http://127.0.0.1:5173`). The game runs fully offline — without an LLM worker configured it falls back to deterministic placeholder names and teasers.

To point at a deployed worker:

```
http://127.0.0.1:5173/?worker=https://api.example.com
```

…or persist it for the browser session:

```js
localStorage.setItem('paper-airplane:worker', 'https://api.example.com');
```

## Controls

| Key | Action |
| --- | --- |
| ↑ / ↓ | Pitch (flight-sim convention: ↑ = nose down) |
| ← / → | Bank (left / right) |
| `SPACE` | Held throttle. Also tap-to-takeoff when grounded |
| `SHIFT` | Brake |
| `L` | Toggle logbook |
| `R` | Reset to spawn |
| `ESC` | Pause |

## What's in here

```
src/
  main.js                  Bootstrap, fixed-step loop, glue
  game/
    GameLoop.js            60Hz fixed timestep with accumulator + pause
    Input.js               Keyboard handling
    Plane.js               Rapier ball body + paper plane mesh
    FlightController.js    Kinematic cruise + attitude
    Aero.js                Orbital tracking and auto-roll math
    CameraRig.js           Atmosphere/space chase camera with blend
    Tuning.js              All flight + LLM tuning constants
  world/
    Galaxy.js              Sparse hash grid; streams systems in and out
    SolarSystem.js         Sun + 3–6 planets, each with atmosphere + pad
    Planet.js              Subdivided icosahedron + trimesh collider
    TerrainGen.js          Multi-octave value noise displacement
    Atmosphere.js          Translucent shell + rho function
    LandingZone.js         Runway, beacon, terrain flattening, claim trigger
    Landmarks.js           Hero spire picks from elevation peaks
    Features.js            ~1200 instanced rocks + flora per planet
    Origin.js              Floating-origin rebasing (5km threshold)
    Seed.js                Mulberry32 PRNG + value noise
  ui/
    HUD.js                 Speed/alt/atmos readout + ping strip
    PlanetNav.js           Edge-clamped nav rings with distance labels
    Toast.js               Centered transient text + flash
    Logbook.js             Slide-out panel of claimed planets
    DebugHUD.js            Top-left telemetry overlay
  llm/
    LLMClient.js           Tiered scheduler, in-flight dedupe, LS cache
    Prompts.js             Tier 1/2/3 prompt assembly
    Placeholder.js         Deterministic offline fallback
worker/                    Cloudflare Worker (see worker/README.md)
```

## How the world is built

- **Galaxy** is a sparse hash grid keyed by `floor(galaxyCoord / CELL_SIZE)`. Cells are deterministically occupied from the galaxy seed; systems spawn within `SPAWN_RADIUS` of the player and despawn beyond `CULL_RADIUS`. The home cell `(0,0,0)` is always populated so spawn is stable.
- **Solar systems** place a sun at their origin and 3–6 planets at log-spaced orbits (200m–5km) using sector-based angular distribution plus inclination jitter — planets never line up.
- **Planets** are subdivided icosahedrons displaced by multi-octave noise, with a trimesh Rapier collider built from the deformed mesh. Vertex colors are banded by elevation; one runway per planet flattens the surrounding terrain into a tangent disc before the collider is built, so visuals and collisions agree.
- **Floating origin** kicks in once the plane drifts >5km from render `(0,0,0)`. Every active body — plane, planets, atmospheres, sun — is shifted by the same delta between fixed steps so render coords stay near zero indefinitely.

## How naming works

A tiered LLM scheduler keeps prompts cheap and responsive:

- **Tier 1 (Haiku)** — fires on system spawn, one per planet. Returns a one-line teaser; cheap enough to do for every planet in view.
- **Tier 2 (Sonnet)** — commitment-gated. Per fixed step, for each not-yet-named planet, fires once when you're inside its atmosphere *or* aimed at it (`dot(fwd, toPlanet) ≥ 0.85`) within `radius + 1500m`. Returns name, biome, palette, landmark names.
- **Tier 3 (Sonnet, more tokens)** — fires when you actually land on the pad. Returns surface lore that appears as a one-time fly-out.

Cache key is `(tier, seed, normalizedContext)`, so revisiting any planet returns identical content. With a worker, the cache lives in Workers KV; without one, it lives in `localStorage` under `paper-airplane:llmcache:v1`.

## LLM worker (optional)

The game ships ready to use a Cloudflare Worker that proxies Anthropic. Setup, deploy, and local-dev instructions live in [`worker/README.md`](worker/README.md). The worker enforces JSON output via tool use, holds the API key, and provides the KV cache.

## Console & storage

`window.__GAME` exposes `plane`, `flight`, `cameraRig`, `galaxy`, `origin`, and the current `planet` / `atmosphere`. Useful tweaks from the dev console:

```js
TUNING.CRUISE_SPEED = 24;                            // live-edit any tuning
__GAME.inspect();                                    // pos/vel/fwd/angvel snapshot
__GAME.snapshot();                                   // respawn
localStorage.removeItem('paper-airplane:logbook:v1');// wipe logbook
localStorage.removeItem('paper-airplane:llmcache:v1');// wipe local LLM cache
```

## Stack

- [Three.js](https://threejs.org/) for rendering
- [Rapier3D](https://rapier.rs/) (compat WASM build) for physics + collision events
- [Vite](https://vitejs.dev/) for dev/build
- [Cloudflare Workers + KV](https://workers.cloudflare.com/) for the LLM proxy
- [Anthropic API](https://docs.anthropic.com/) — Haiku 4.5 for Tier 1, Sonnet 4.6 for Tier 2/3
