# Personal Space (paper-airplane)

Fly a paper airplane between procedurally generated planets; claim them into a
logbook. Deployed at personalspace.fun (frontend: Cloudflare Pages, auto-deploys
from `main`) + a Cloudflare Worker at api.personalspace.fun (LLM proxy, auth,
logbook; deploy manually with `cd worker && npx wrangler deploy`).

## Where truth lives

- **`docs/plans/2026-11-11-001-feat-v1-polish-roadmap-plan.md`** — the v1.0
  roadmap (Foundations → Look → Loop → Sound → Brain → Reach), findings, and
  the $200/month API budget. Its **Progress table** says which phase is live.
- `docs/plans/2026-05-23-001-feat-planet-visuals-llm-driven-assets-plan.md`
  — the planet-visuals master plan (Phases 1-15, all shipped except Phase 8
  performance, now roadmap Phase 5). Each phase has a sub-plan doc in
  `docs/plans/` with shipped-notes in its header.
- `plan.md` — the older whole-project plan (galaxy streaming, logbook, auth);
  still accurate for non-visuals systems.
- Workflow: one plan doc per phase → implement on a branch → PR → squash-merge.

## Architecture (60 seconds)

Planet generation is LLM-driven with a **concept spine** (Phase 14): a Haiku
`/concept` call invents one weird, *visible* premise per planet
(`{name, teaser, premise, question, tier, terrain, motif, asset_keywords}`,
KV-cached by seed). The teaser is what the player navigates by. Everything
downstream obeys it:

- `src/llm/ConceptScheduler.js` — concepts are requested **lazily**: only for
  the system the player is in, near, or has aimed at from open space
  (`CONCEPT_*` tunables; aim is ignored inside an atmosphere).
  Other planets read UNCHARTED. Never request concepts per spawned system.
- `shared/planet-dice.js` (+ `shared/prng.js`) — every deterministic roll
  behind the concept prompt: tier (quiet/notable/singular 60/33/7), sparks,
  and the per-system deals (register, name initial, landform, ground
  pattern). Imported by the game AND the worker; `conceptContextFor()` is the
  single source of the prompt context. `src/world/ConceptSeed.js` re-exports.
- Worker spend guard (`worker/src/lib/llm-guard.js`, `budget.js`,
  `llm-context.js`): LLM routes need a session cookie, are rate-limited, and
  stop at `DAILY_BUDGET_USD` (503 → client falls back to `Placeholder.js`).
  `/concept` takes identity only (`system_seed, planet_index, radius`) and
  derives its own context; other routes sanitize theirs. Usage lands in D1
  `llm_usage` (`cd worker && npm run usage`).
- `Planet.applyConcept` — reshapes terrain (sea level/amplitude) + slots +
  collider while the planet is still a distant dot.
- Tier 2 `/tier2/direct` (Sonnet) elaborates the premise; retrieval + Haiku
  `/tier2/pick` run **in parallel** with it off the concept keywords (Phase 9).
- Placement engine: `PlacementRules.js` (per-family align/slope/embed +
  bbox-normalized scale), `Motifs.js` (uniform-lean, all-facing-point,
  grid-rows, procession, shared-heading), `Features.js` (clustered scatter),
  `Landmarks.js` (slots + mounts), `AxisUp.js` (signed ground-snap, pivot
  recenter).
- Catalog: 572 bundled CC0 assets (`src/world/assets/catalog.json`, generated —
  edit `tools/import-assets.js`/`family.js` and re-run import + `npm run
  build:catalog`; never hand-edit). Weak hero matches trigger a Poly Pizza CC0
  search via the worker (`/assets/search`, Phase 7) — GLBs load from their CDN
  (ToS: never re-host), credits render in the logbook + `/credits.html`.
- Asset colour (roadmap 1a): every bundled GLB is **baked** at import
  (`tools/bake-colors.mjs`) to one Draco primitive whose `COLOR_0` holds the
  model's authored colours — no textures, no UVs. At mount,
  `MaterialSet.applyMaterialSet` grades those colours toward the planet
  palette: the asset's mean colour is re-centred on the biome
  (`ColorSystem.gradeCentre`, `GRADE` tunables) and every part keeps its
  offset from that mean (`ColorGrade.js`). Meshes with no authored colour
  fall back to the flat family colour. Dynamic Poly Pizza assets keep their
  own materials.
- Tier 3 lore: pilot's journal, spoken-not-written, written against the
  actually-mounted assets, never answers the planet's question.
- Look (roadmap 1b, `src/render/`): **sunlit low-poly**, in the game and
  every bench except the contact sheet. `Looks.js` holds its numbers (do not
  retune casually; they were approved on the look lab). `Rig.js`: sun + sky
  hemisphere + ambient, one PCF sun shadow map. `ShadowFit.js`: the shadow
  box follows the camera (small near the ground, the whole planet from
  far), snapped to shadow texels from the planet centre, so no shimmer and
  no jump on a floating-origin rebase. `Shadows.js` `setShadowFlags` is the
  only place cast/receive flags are set (Planet, Plane call it; reveal-
  dithered assets get a dithered depth material). Only the active planet
  casts. `Post.js`: HDR → GTAO (half resolution) → bloom → OutputPass
  (ACES) → saturation/contrast/vignette. Lambert materials are already
  right for the look. Bloom's threshold is 2: sunlit ground reaches about
  1.7 and must not glow, so anything meant to glow (the star's disc, later
  lamps and windows) has to be drawn brighter than 2.
- Quality tiers (`Quality.js`, pure + unit-tested; `QualityControl.js`
  glue): high / medium (no GTAO, 1024 shadows) / low (no composer, no
  shadows, tone mapping on the renderer). MSAA is 4× on high, 2× where the
  pixel ratio is 1.5 or more (`msaaFor`). Auto starts high, measures once
  settled (median frame time, and the share of dropped frames over two
  windows), only ever steps down. Override: pause menu (saved),
  `?quality=…` (session), `__GAME.setQuality(…)`.

## Dev commands & benches

- `npm run dev` — Vite (use **port 5173** when pointing at the prod worker:
  CORS allowlist). `?worker=https://api.personalspace.fun` uses the prod LLM,
  which needs the dev bypass (no session cookie cross-site):
  `localStorage.setItem('paper-airplane:devkey', '<DEV_LLM_KEY secret>')`.
- `?contactSheet=1` — render the whole asset catalog as an audit grid (pack
  filter, RAW toggle). Gate for any new pack import.
- `?placementLab=1&seed=…&sea=…&motif=…&tier=…&hero=<catalog-id>` — one
  forced-concept planet through the real applyVisuals path, no flying.
  `&flat=1` shows the pre-1a flat family colours for A/B.
- `?lookLab=1` — the lighting bench (roadmap 1b): the five reference
  planets in the game's look or the pre-1b baseline (`now`, kept one more
  PR for A/B), switched live (1–2 look, ←/→ planet, V photo view).
  `npm run look:sheet` renders every planet × view × look to
  `look-sheet/index.html` (gitignored). Placement and terrain labs take
  `&look=now` too.
- Console hooks: `__GAME.testTier2(seed)` (full chain, uses the planet's
  concept), `__GAME.rollStats()` (tier pacing), `__GAME.auditMaterials()`,
  `__GAME.testAsset(url)`, `__GAME.debugPlacement = true`,
  `__GAME.llmCalls()` (network LLM requests this session, per route),
  `__GAME.conceptScheduler.stats`, `__GAME.quality` /
  `__GAME.setQuality('auto'|'high'|'medium'|'low')`, `__GAME.testThumbnail()`
  (capture vs live canvas, side by side).
- `npm run build` — must pass before any PR.

## Testing

- `npm test` — vitest unit tests (`tests/unit/**/*.test.js`, node env;
  `fake-indexeddb` for the logbook store).
- `npm run test:e2e` — Playwright on the production bundle, offline (no worker,
  no LLM; port 5187; SwiftShader WebGL): `smoke.spec.js` boots the game,
  waits for auto quality to settle (SwiftShader lands on `low` in a few
  seconds), warps, draws every quality tier, fails on page errors /
  console errors. The console-error allowlist
  lives in `tests/e2e/guard.js` — every entry needs a reason. The guard also
  answers every worker route with 503, so nothing reaches port 8787.
- `looklab.spec.js` boots `?lookLab=1` and draws both looks (a shader that
  fails to compile fails the test); CI uploads the images as `look-lab`.
- **Seed gallery** (`gallery.spec.js`): 8 fixed planets (listed in
  `src/dev/galleryPlanets.js`) through
  `?placementLab=1&shot=1` → `test-results/seed-gallery/*.png` (CI artifact
  `seed-gallery`). Deterministic: compare before/after on any visual PR. Keep
  the list stable; rename a file when you change its entry.
- CI (`.github/workflows/ci.yml`): build, unit, worker `--dry-run` bundle, e2e.

## Conventions & gotchas

- Rendering: set the sky with `scene.background` (a `THREE.Color`), never
  `renderer.setClearColor` — through the composer the clear colour would be
  sRGB-encoded twice. Custom `ShaderMaterial`s output linear light and
  include `<tonemapping_fragment>` + `<colorspace_fragment>` (no-ops in the
  composer's HDR buffer, right on the `low` tier). Anything see-through must
  be `transparent` (or `userData.noAO`) so GTAO's prepass skips it.
  Benches in screenshot mode draw on demand: SwiftShader takes seconds per
  full-pipeline frame.

- Worker prompt/schema changes require `npx wrangler deploy` from `worker/` —
  call it out in the PR; the frontend needs nothing (Pages auto-deploy).
  New D1 migrations first: `npx wrangler d1 migrations apply personal-space
  --remote`. When client and worker change together, ship the client first
  (merge → Pages) and keep it compatible with the old worker.
- Testing an undeployed worker version on real infra: the
  `Cloudflare-Workers-Version-Overrides` header only works once the version
  is in the deployment (`wrangler versions deploy <new>@0% <current>@100%`).
  Without that the header is silently ignored and you hit the live worker.
- LLM failures are non-2xx (401/429/502/503). The client falls back to
  `Placeholder.js` for the session and never persists a fallback.
- LLM responses are KV-cached (worker) + localStorage-cached (client,
  `LS_CACHE_KEY` version bump invalidates; worker uses `PROMPT_VERSION` map).
- Re-importing or adding a pack runs the colour bake. The four Kenney
  colormap kits (castle, fantasy-town, graveyard, pirate) need their atlases
  at `~/code/kenney-colormaps/<kit>/colormap.png` (or `$KENNEY_COLORMAP_DIR`);
  see `src/world/assets/README.md`. `node tools/verify-bake.mjs <beforeDir>`
  checks a re-bake against a snapshot. New packs: contact sheet first.
- Catalog `scale_range` is a size *bias*; real scale is bbox-normalized per
  role (`resolveScale`). `scale_override` is the absolute escape hatch.
- Prompt caching is not used. Tier 2/3 (Sonnet 4.6) prompts are below its
  cache minimum. Concept/pick are on Haiku 5.5 (512-token minimum), but
  concept calls fire as a parallel burst per system (every call would pay the
  write surcharge) and pick's per-request tool enums precede the system
  prompt in the prefix. Revisit with the per-system concept call (roadmap 4c).
- Poly Pizza ToS: CC0-only, attribute creators, never re-host GLBs, no
  commercial use >$50k/yr.
- Product voice: optimize for wild-but-cohesive, anecdote-quality planets
  ("tell your friends"), not enumerated variety — see the Phase 14 plan's
  quality bar (five reference planets) before touching generation prompts.
