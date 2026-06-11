# Personal Space (paper-airplane)

Fly a paper airplane between procedurally generated planets; claim them into a
logbook. Deployed at personalspace.fun (frontend: Cloudflare Pages, auto-deploys
from `main`) + a Cloudflare Worker at api.personalspace.fun (LLM proxy, auth,
logbook; deploy manually with `cd worker && npx wrangler deploy`).

## Where truth lives

- **`docs/plans/2026-05-23-001-feat-planet-visuals-llm-driven-assets-plan.md`**
  — the planet-visuals master plan. Its **Progress table is the source of
  truth** for what's shipped (12/14 phases as of 2026-06-11; Phase 8
  performance + Phase 11 thumbnails remain). Each phase has a sub-plan doc in
  `docs/plans/` with shipped-notes in its header.
- `plan.md` — the older whole-project plan (galaxy streaming, logbook, auth);
  still accurate for non-visuals systems.
- Workflow: one plan doc per phase → implement on a branch → PR → squash-merge.

## Architecture (60 seconds)

Planet generation is LLM-driven with a **concept spine** (Phase 14): at system
spawn, a Haiku `/concept` call invents one weird, *visible* premise per planet
(`{name, teaser, premise, question, tier, terrain, motif, asset_keywords}`,
KV-cached by seed). The teaser is what the player navigates by. Everything
downstream obeys it:

- `src/world/ConceptSeed.js` — deterministic tier roll (quiet/notable/singular
  60/33/7) + spark dice (entropy without buckets).
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
- Tier 3 lore: pilot's journal, spoken-not-written, written against the
  actually-mounted assets, never answers the planet's question.

## Dev commands & benches

- `npm run dev` — Vite (use **port 5173** when pointing at the prod worker:
  CORS allowlist). `?worker=https://api.personalspace.fun` to use prod LLM.
- `?contactSheet=1` — render the whole asset catalog as an audit grid (pack
  filter, RAW toggle). Gate for any new pack import.
- `?placementLab=1&seed=…&sea=…&motif=…&tier=…&hero=<catalog-id>` — one
  forced-concept planet through the real applyVisuals path, no flying.
- Console hooks: `__GAME.testTier2(seed)` (full chain, uses the planet's
  concept), `__GAME.rollStats()` (tier pacing), `__GAME.auditMaterials()`,
  `__GAME.testAsset(url)`, `__GAME.debugPlacement = true`.
- `npm run build` — must pass before any PR.

## Conventions & gotchas

- Worker prompt/schema changes require `npx wrangler deploy` from `worker/` —
  call it out in the PR; the frontend needs nothing (Pages auto-deploy).
- LLM responses are KV-cached (worker) + localStorage-cached (client,
  `LS_CACHE_KEY` version bump invalidates; worker uses `PROMPT_VERSION` map).
- Catalog `scale_range` is a size *bias*; real scale is bbox-normalized per
  role (`resolveScale`). `scale_override` is the absolute escape hatch.
- Prompt caching is NOT worth adding to worker calls: every system prompt is
  far below the model minimums (4096 tokens Haiku 4.5 / 2048 Sonnet 4.6).
- Poly Pizza ToS: CC0-only, attribute creators, never re-host GLBs, no
  commercial use >$50k/yr.
- Product voice: optimize for wild-but-cohesive, anecdote-quality planets
  ("tell your friends"), not enumerated variety — see the Phase 14 plan's
  quality bar (five reference planets) before touching generation prompts.
