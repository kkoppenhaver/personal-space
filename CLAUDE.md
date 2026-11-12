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
  the system the player is in, near, or has aimed at (`CONCEPT_*` tunables).
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
- Tier 3 lore: pilot's journal, spoken-not-written, written against the
  actually-mounted assets, never answers the planet's question.

## Dev commands & benches

- `npm run dev` — Vite (use **port 5173** when pointing at the prod worker:
  CORS allowlist). `?worker=https://api.personalspace.fun` uses the prod LLM,
  which needs the dev bypass (no session cookie cross-site):
  `localStorage.setItem('paper-airplane:devkey', '<DEV_LLM_KEY secret>')`.
- `?contactSheet=1` — render the whole asset catalog as an audit grid (pack
  filter, RAW toggle). Gate for any new pack import.
- `?placementLab=1&seed=…&sea=…&motif=…&tier=…&hero=<catalog-id>` — one
  forced-concept planet through the real applyVisuals path, no flying.
- Console hooks: `__GAME.testTier2(seed)` (full chain, uses the planet's
  concept), `__GAME.rollStats()` (tier pacing), `__GAME.auditMaterials()`,
  `__GAME.testAsset(url)`, `__GAME.debugPlacement = true`,
  `__GAME.llmCalls()` (network LLM requests this session, per route),
  `__GAME.conceptScheduler.stats`.
- `npm run build` — must pass before any PR.

## Testing

- `npm test` — vitest unit tests (`tests/unit/**/*.test.js`, node env;
  `fake-indexeddb` for the logbook store).
- `npm run test:e2e` — Playwright on the production bundle, offline (no worker,
  no LLM; port 5187; SwiftShader WebGL): `smoke.spec.js` boots the game,
  warps, fails on page errors / console errors. The console-error allowlist
  lives in `tests/e2e/guard.js` — every entry needs a reason.
- **Seed gallery** (`gallery.spec.js`): 8 fixed planets through
  `?placementLab=1&shot=1` → `test-results/seed-gallery/*.png` (CI artifact
  `seed-gallery`). Deterministic: compare before/after on any visual PR. Keep
  the list stable; rename a file when you change its entry.
- CI (`.github/workflows/ci.yml`): build, unit, worker `--dry-run` bundle, e2e.

## Conventions & gotchas

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
