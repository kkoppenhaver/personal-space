---
title: Personal Space v1.0 — from tech demo to polished game
type: feat
status: active
date: 2026-11-11
scope: whole project (supersedes plan.md "Phase 3+ vision roadmap" and master-plan Phase 8)
---

# Personal Space v1.0 — from tech demo to polished game

## Progress

| Phase | Status | PR | Notes |
|---|---|---|---|
| 0. Foundations | ✅ Done | [#33](https://github.com/kkoppenhaver/personal-space/pull/33), [#34](https://github.com/kkoppenhaver/personal-space/pull/34) | **Live 2026-11-12** (client via Pages; worker version `5a78740c` at 100%; D1 migration 0003 applied). 0a: #32 squash-merged, #30/#31 closed. 0b: session-gated, rate-limited LLM routes; $3.70/day breaker; `llm_usage` ledger; `/concept` derives its own context via `/shared`; tool output validated before caching, one retry, strict concept schema (the real-model check caught 1 malformed concept in 15). 0c: lazy concepts (3 requests at start, was 45); concept + pick on Haiku 5.5. 0d: 95 unit tests, browser smoke test, seed gallery, CI; logbook lost-update fix. Measured about $0.10 per four-planet session (was about $0.29). #34: aim-to-chart only counts in open space (an orbiting plane was charting systems nobody aimed at). |
| 1. Look | 🔄 In progress | [#35](https://github.com/kkoppenhaver/personal-space/pull/35), [#37](https://github.com/kkoppenhaver/personal-space/pull/37) | **1a (true colours) shipped 2026-11-12. 1b step 1 (look lab) shipped 2026-11-12. Art direction picked 2026-11-12: sunlit low-poly, with soft shadows. 1b step 2 (the look in the game) in review.** All 572 bundled models re-baked to carry their authored colours as vertex colours (bundle 6.7 MB → 2.7 MB, 959 → 572 draw primitives); the renderer grades those colours toward the planet palette. See the 1a notes below. 1b to 1f pending. |
| 2. Loop | ⌛ Pending | — | |
| 3. Sound | ⌛ Pending | — | |
| 4. Brain | ⌛ Pending | — | |
| 5. Reach | ⌛ Pending | — | |

### Carried forward from Phase 0

Found while building and verifying Phase 0; not fixed there.

- **Two Tier 2 calls can fire within 8 seconds of START.** The intent gate's cone is wide (`APPROACH_DOT` 0.85, about 32°), so the default spawn heading often commits a second planet. At $0.0144 a call that is the largest remaining waste per session. Tighten the gate, or let Phase 4c's cheaper approach call absorb it.
- **The journal never hears about Poly Pizza models.** `_tier3ContextOf` resolves mounted names from the bundled catalog only.
- **Offline or with the model host blocked, some planets mount no assets.** BM25-only retrieval returns an empty list for one slot and the pick is skipped. Retrieval is replaced in Phase 4c.
- **A logbook row uploaded while its lore is still arriving can miss the lore on the server.** The local copy is fine.
- **Concept tics on Haiku 5.5** (30 samples): lamps or lanterns left on in about a third, stone fox or stag statues in about a quarter. For Phase 4a's evals.
- **Teasers overrun 80 characters** in about a fifth of concepts. Not rejected.
- **The seed gallery already shows Phase 1 work:** a dim lab light rig (1b), scatter floating off the surface on the dunes planet, oversized heroes. (Single-colour assets: fixed in 1a.)
- **Local dev against the prod LLM needs a dev key:** `npx wrangler secret put DEV_LLM_KEY` (16+ characters), then `localStorage.setItem('paper-airplane:devkey', …)`. Not set yet.

## TL;DR

1. **The idea is strong; the build is a tech demo.** The concept spine (one weird, visible premise per planet) is the right core. What surrounds it is prototype-grade: flat single-colour assets, no shadows, no sound, a debug-panel HUD, and a claim you earn by doing nothing for 10 seconds.
2. **Seven weeks of work is not on `main`.** PRs #30, #31, #32 (stacked, opened 2026-09-24) hold terrain shapes, the rendering pass, registers and motes. Landing them is step one.
3. **The API key is unguarded and wasteful.** LLM routes have no auth, no rate limit and no spend cap. A new player triggers about 45 concept calls at boot for planets they will never see. A session costs about $0.29 today; the plan gets it to about $0.05.
4. **Five build phases after a foundations phase:** Look, Loop, Sound, Brain, Reach. About 22 PRs.
5. **The $200/month buys three things:** live generation for roughly 2,000 sessions, an eval harness that gates every prompt change, and (if a spike passes) a monthly batch of Claude-authored hero props that grows the asset vocabulary.

## What I reviewed

- All source at the tip of the PR stack (`feat/surfaces-terrain-shapes`, a7258e3), about 13.6k lines, plus the worker, the plan docs and the saved project notes.
- The game itself, run from that tip in offline (placeholder) mode. I warped to planets, claimed two, opened the logbook, and read the console.
- Current Claude pricing and the Claude 5 migration notes, fetched 2026-11-11.

Everything below marked "measured" came from that run. Everything marked "estimate" is arithmetic on prompt sizes and is called out as such.

## What to keep

These are good and the plan builds on them, not around them:

- **Concept-as-spine.** Teaser → terrain → picks → lore all obey one premise. This is the product.
- **Placement engine.** Ground snap, slope gates, motifs, clustered scatter, landmark exclusion zones.
- **Dev benches.** `?contactSheet`, `?placementLab`, `?terrainLab`, `__GAME.*` hooks. They are why visual work can be verified.
- **Accounts and logbook infrastructure.** Anonymous-first sessions, passkeys, D1 + R2, offline outbox.
- **The vision.** Per-player galaxies, ephemerality, the logbook as the only thing you keep, sharing artifacts not coordinates.

## Findings

Ranked by how much each one hurts a first-time player.

| # | Finding | Evidence | Fixed in |
|---|---|---|---|
| 1 | **Assets render as one flat colour.** A palm's trunk and leaves are the same mint green. | `applyMaterialSet` (`src/world/MaterialSet.js`) replaces every mesh material with one family colour. 243 of 572 GLBs are multi-material and lose their contrast. Another 100 Kenney GLBs reference an external texture (for example `Textures/colormap.png`) that is not shipped (404 in the console), so their colour data is gone before the recolour runs. | 1a |
| 2 | **The claim is passive.** Entering an atmosphere and holding nothing claims the planet in about 10 seconds. | Measured: 44% after 5 s, claimed inside 9 s, zero input. The 60° coverage cone marks 25% on the first tick and the threshold is 50%. The player never has to look at the premise. | 2a |
| 3 | **No audio at all.** | No `AudioContext`, no audio files anywhere in `src/`. | 3 |
| 4 | **No depth cues.** No shadows, no ambient occlusion, no tone mapping, flat Lambert shading. Assets look pasted on. | No `shadowMap`, `toneMapping` or composer in the codebase. | 1b |
| 5 | **Skies are muddy and leak.** Stars and other planets' halos show through the daytime sky. The dusk side is brown, the night side flat teal. | Measured in three screenshots at different sun angles. | 1c |
| 6 | **Ground patterns alias.** Rings and patchwork render as jagged triangle checkerboards. | Patterns are painted per face on 4 m facets (`TerrainGen.js`). | 1d |
| 7 | **The HUD is a debug panel.** `ATMOS ρ 0.23`, `STATE FLYING`, a permanent controls line. Nav labels overlap each other and the stats box. | `index.html`, `PlanetNav.js`. | 1f |
| 8 | **The logbook artifact is weak.** A 320 px drawer. The thumbnail is auto-captured at whatever moment the bar fills, often brown sky with the planet at the bottom edge. | Measured. Also: entries stuck on "lore drifting in…" after the lore arrived. Likely a lost update: `LogbookStore` does whole-object read-modify-write from several async paths. | 0d, 2d |
| 9 | **Travel is dead time.** Sibling planets are up to 5 km apart at 28 to 45 m/s. Systems are 15 km apart: about 9 minutes of empty space. | `SolarSystem.js`, `Galaxy.js`, `Tuning.js`. | 2c |
| 10 | **Desktop keyboard only.** No touch, no gamepad. A shared link opened on a phone is unplayable. | `Input.js`. | 5b |
| 11 | **Heavy first load.** 6.9 MB catalog JSON with embeddings in the bundle, a 22 MB MiniLM model and ORT wasm, all to do asset retrieval in the browser. START is gated on it. | `dist/` is 40 MB. | 4c |
| 12 | **Everything is live at once.** 11 systems, 45 planets, 2.29 M triangles, 389 meshes, 45 trimesh colliders, frustum culling off. | Measured. 121 fps on this Mac; a phone will not cope. | 5a |
| 13 | **LLM routes are an open, unmetered proxy.** No session check, no rate limit, no spend cap. `context` is arbitrary client JSON pasted into the prompt. | `worker/src/routes/llm.js`. Rate-limit bindings exist but only auth, email and thumbnails use them. | 0b |
| 14 | **Most concept calls are for planets nobody visits.** A concept call fires for every planet of every spawned system: about 90% of concept calls and roughly 60% of a session's LLM spend. | `onSystemSpawned` in `main.js`. Measured 45 planets loaded right after START. | 0c |
| 15 | **No safety net.** No tests, no CI, no lint. `main.js` is 1,234 lines holding the loop, claim flow, lighting and LLM orchestration. | Repo listing. | 0d |

## Design rules

Carried over from your stated vision. Every phase is checked against these.

1. **Polish the moment, not the navigation.** One shot per planet, so the minutes spent on it must be worth remembering.
2. **Wild but cohesive.** One premise threaded through everything. No visible taxonomy.
3. **The logbook entry is the product.** It should be something a player wants to send to a friend.
4. **Share artifacts, never coordinates.**
5. **Explain once, then let the player feel it.** No repeated toasts for mechanics.
6. **Surfaces first.** When two tasks compete, the one that makes a planet's surface more distinct wins.

## Roadmap

One PR is one focused build session plus about 20 minutes of your time to playtest and deploy.

| Phase | Outcome | PRs | Needs you |
|---|---|---|---|
| **0. Foundations** ✅ | Stack landed, wallet guarded, spend measured, CI on | 4 (done 2026-11-12) | Done |
| **1. Look** | Planets look authored: real colours, shadows, clean skies, crisp ground, a real HUD | 6 | Pick an art direction from three presets (done: sunlit low-poly) |
| **2. Loop** | You find the premise and photograph it. Travel is short. The logbook is a book. | 5 | Playtest the photo claim |
| **3. Sound** | Wind, paper, shutter, and generative ambience keyed to each planet's mood | 2 | Listen |
| **4. Brain** | Claude 5 models, one call per system, journal written about your photo, evals gate changes | 5 | Worker deploys |
| **5. Reach** | Phones and gamepads work, far planets are cheap, entries have share pages | 4 | Decide default privacy for shared entries |

At three PRs a week this is about eight weeks. Phases 1 and 2 can interleave: I would ship 1a (true colours), then 2a (photo claim), then the rest, so the two biggest changes are playable early.

---

## Phase 0 — Foundations ✅ Done 2026-11-12

Shipped in #32, #33 and #34; what was found and left is under "Carried forward from Phase 0" near the top. The text below is the plan as written.

**0a. Land the stack (1 PR, about 30 minutes).**
- Squash-merge `feat/surfaces-terrain-shapes` into `main` as one PR. It contains #30 and #31; close those as superseded. Retargeting three stacked squash-merges one by one produces conflicts for no benefit.
- You: deploy the worker from merged `main` with `cd worker && npx wrangler deploy`
- `feat/phase-15-graphics` (your 2026-09-24 push) extracts a shared renderer and light rig (`src/render/Rig.js`). #31 changed the lights it captures. I will port the idea in 1b; the branch can then be deleted.

**0b. Guard the wallet (1 PR, worker + client).**
- Require the session cookie on `/concept`, `/tier*` and `/assets/search`. Every visitor already gets an anonymous session; the LLM client just needs `credentials: 'include'`.
- Rate-limit per user and per IP with the existing Workers binding type.
- **Daily spend breaker.** Record `usage` from every Anthropic response into a D1 table (`day, route, model, tokens in/out/cached, est. cost`). When the day's total passes `DAILY_BUDGET_USD`, routes answer `{degraded: true}` and the client falls back to its offline generator. The player sees a quieter planet, never an error.
- **Server-derived context.** The worker recomputes tier, sparks, register, initial, shape and pattern from the seeds (move `ConceptSeed.js` and the dealing functions into a module both sides import). The client sends identity only. This closes the arbitrary-prompt hole.
- You: set a $200 monthly limit on the API key's workspace in the Anthropic Console. That is the hard backstop.

**0c. Stop paying for unseen planets (same PR as 0b or the next).**
- Request concepts only for the system the player is in, plus any system they are aimed at inside approach range. Other pings read "uncharted" until then. About 45 calls per new galaxy becomes about 5.
- Move `concept` and `pick` from Haiku 4.5 to Haiku 5.5. List price is one tenth; its tokenizer counts about 30% more tokens, so roughly one eighth in practice. Haiku 5.5 still accepts the forced `tool_choice` these routes use, so it is a model-string change plus a `PROMPT_VERSION` bump. Spot-check 15 concepts before deploy, as #30 did.

**0d. Safety net (1 PR).**
- GitHub Action on every PR: `npm run build`, then a Playwright smoke run (boot offline, `__GAME.warpTo`, fail on console errors) that uploads a **seed gallery**: the same 8 fixed seeds rendered through `?placementLab`. Visual changes get reviewed as before/after images.
- Fix the logbook lost update: field-level merge inside one IndexedDB transaction. Add a unit test that interleaves `update`, `attachThumbnail` and `markSyncing`.
- Start splitting `main.js` as phases touch it: `ClaimSystem`, `ApproachDirector`, `SkyAndLight`. No big-bang refactor.

**Done when:** `main` matches what you play, a day's spend is one SQL query, and a runaway client cannot spend more than the daily budget. **Met:** all three, verified on the live site.

## Phase 1 — Look

**1a. True colours (1 PR). The biggest visual jump for the least work.** ✅ Shipped 2026-11-12 ([#35](https://github.com/kkoppenhaver/personal-space/pull/35)).

What was built, and where it differs from the first draft of this plan:

- **The colour was not all there to keep.** A survey of the 572 bundled models found 329 carrying colour, 100 (four Kenney kits) pointing at a `colormap.png` that was never shipped and was not in the raw mirror, and 143 (three Quaternius kits) with no colour at all, just the exporter's default grey.
- **Import bake** (`tools/bake-colors.mjs`, run by `tools/import-assets.js`): every bundled GLB is rebuilt from its source as one Draco primitive whose `COLOR_0` holds the authored albedo. No textures, no UVs.
  - Kenney colormap kits: the four atlases, taken from Kenney's own OpenGameArt uploads (kenney.nl's download link refused scripted requests). Every mirror GLB is byte-identical to the one in the same zip.
  - Quaternius space: the kit's `Atlas.png`.
  - Quaternius nature: averages of the pack's own textures, per UV island for the alpha-cut sheets.
  - Quaternius stylized trees: no textures exist anywhere, so a small name palette (`tools/part-palette.json`): bark, leaves, needles, per species.
  - Result: 572 of 572 carry colour; bundle 6.7 MB → 2.7 MB; 959 → 572 primitives; bounding boxes within 0.5%.
- **Runtime grade** (`ColorGrade.js`, `AuthoredColor.js`, `ColorSystem.gradeCentre`, `MaterialSet.applyMaterialSet`): done on the CPU when an asset mounts, not in a shader. Each asset's mean colour is pulled toward the biome accent by its family's blend amount, and every part keeps its offset from that mean. `GRADE` holds the tunables.
- **One draw call per scattered asset:** every mesh is vertex-coloured with the same neutral material, so multi-part models merge without material groups.
- Gate used: `tools/verify-bake.mjs`, the contact sheet, the seed gallery before and after, `__GAME.auditMaterials()` (0 leaks in game), and `&flat=1` in the placement lab for A/B.
- Known limits: Quaternius leaf and petal cards are alpha-cut quads, so they still render as solid polygons; stylized trees are two flat colours each.

**1b. Light, shadow, tone (1 to 2 PRs).**

*Step 1, the look lab, shipped 2026-11-12 ([#37](https://github.com/kkoppenhaver/personal-space/pull/37)); sunlit low-poly was picked from it. Step 2 puts that look into the game: in review.*

Step 1 (the bench):
- **`?lookLab=1`** drew the five reference planets in four looks: the game as it was, paper diorama, **sunlit low-poly (picked)**, inked storybook. The sunlit draft had sharp, dark shadows; they were softened the same day (edge about three times softer, more sky fill, a little sun still reaching shadowed ground).

Step 2 (the game), what was built:
- **One look, in the game and every bench.** `src/render/Looks.js` keeps `sunlit` (numbers unchanged from the lab) and `now` (the pre-1b game, kept one more PR as the A/B baseline on the look lab). Paper, ink, `LookMaterial.js` and the outline, tilt-shift, hatch, lift and grain stages are gone: sunlit's shading is plain cosine, which the game's Lambert materials already do (checked: lab renders before and after the swap match).
- **Lights:** the shared `Rig.js` replaces main.js's hand-built lights. The sun still follows the active system's star (tinted toward its colour as before) and the hemisphere's up still follows the plane's radial up. The look has no fill light, so the night side is darker than before 1b: lit windows and lamps are still to come.
- **Shadows:** terrain, landmarks, heroes, instanced scatter and the plane cast; everything solid receives (the plane does not: thin paper stripes itself). `src/render/Shadows.js` sets the flags in one place. Only the planet the player is at casts. Assets that are still materialising get a depth material with the same dither, so they cast no shadow until they appear.
- **Shadow fit** (`src/render/ShadowFit.js`, unit-tested): the 2048 box sits over the ground just ahead of the camera, about 50 to 60 m half-size near the ground, growing with altitude in 1.25× steps (with hysteresis) up to the whole planet from far out. Its centre is snapped to whole shadow texels in light space, measured from the planet centre, so shadows do not shimmer as the plane moves and do not jump on a floating-origin rebase (checked by shifting the world in a paused game: identical shadows). The rebase also moves the chase camera now; before, it swooped across the whole shift.
- **Finishing pipeline in the game:** HDR → GTAO → bloom → ACES (OutputPass) → saturation, contrast, vignette. The sky colour moved to `scene.background` (a clear colour through the composer is sRGB-encoded twice). GTAO's prepass skips see-through things (atmosphere, sun glow, contrail, motes) and assets mid-reveal.
- **Logbook thumbnails** render through the same pipeline at 512² (same tier stages, shadow box fitted to the capture camera). Average brightness of a capture and the live frame agree within 1/255 on every tier.
- **Benches:** placement lab (so the seed gallery) and terrain lab use the shared rig and pipeline; screenshot mode draws on demand. The contact sheet keeps its own flat audit lighting: it is a colour audit of 572 cells, and a composer per cell would make it unusably slow.
- **Quality tiers** (`src/render/Quality.js`, pure and unit-tested): high (everything, 2048 shadows, 4× MSAA, up to 2× pixels), medium (no GTAO, 1024 shadows, 2× MSAA, 1.5× pixels), low (no composer, tone mapping on the renderer, no shadows, 1× pixels). Auto starts at high, waits 2.5 s and 8 frames, measures 90 frames, and steps down if the median is over 28 ms; a run of very slow frames decides at once (software rendering lands on low in about 5 s). It only steps down and stops once a tier holds. Override: the pause menu (saved), `?quality=` (one session), `__GAME.setQuality()`.

Changed in review, after looking at the game and measuring on a real GPU:
- **Bloom threshold 1.0 → 2.0.** At 1.0, pale ground facing the sun (about 1.7 in the HDR buffer) and the white plane glowed, which put a haze over bright scenes. Now only light sources and glints glow. The star's disc is drawn 4× brighter than its colour so it does.
- **Contact shading at half resolution**, and **2× MSAA instead of 4× on dense displays** (pixel ratio 1.5 or more). On an Apple M4 Pro at 2880×1800 the top tier cost about 17 ms a frame with 4× MSAA and about 12 ms with 2×.
- **Auto quality also counts dropped frames.** A machine that almost keeps up has a fine median and a stutter (every fifth frame late). More than 15% of frames late, in two measuring windows in a row, now steps down a tier.
- Known: pale ground under a high sun is very bright (near white). The look was tuned with the sun at 50° from overhead; straight overhead gives about a third more light. Left as is until it is seen in play.

Still to do in 1b:
- Night side: lit windows, lamp posts and fireflies instead of flat dark.
- Remove the `now` look once nobody needs the A/B.
- Known: a display locked at 30 Hz reads as slow to auto and lands on low (override in the pause menu).

**1c. Sky (1 PR).**
- Fix draw order so nothing shows through a daytime sky.
- Sky gradient by sun elevation with a real dusk palette. A one-draw noise cloud shell, varied by biome and register.
- From space: a thin lit limb. The atmosphere disc currently reads 2.5× the planet.

**1d. Ground (1 PR).**
- Smooth-shaded terrain, tessellated higher for the active planet only (detail 48 near, 8 far).
- Compute patterns in the fragment shader, not per face. Rings, rows and patchwork stay crisp at any facet size.
- Slope-based rock tint, a shoreline foam band, fine grain so the ground is not a flat fill.

**1e. Camera and plane (1 PR).**
- On approach, bias the look-at toward the hero so the premise is in frame when you arrive.
- A better paper plane (more folds, slight wing flex). Kept small: the vehicle is slated to become a shuttle.

**1f. HUD identity (1 PR).**
- Replace the stats box with two quiet instruments (speed, altitude). Drop `ATMOS` and `STATE`.
- Nav markers: nearest three, edge arrows, no overlap with other UI.
- Remove the permanent controls line (the pause menu has it). Add a title screen.

**Art direction: sunlit low-poly, picked 2026-11-12 in the look lab.** Crisp flat-shaded facets in clear daylight, soft-edged shadows, cool blue shade, filmic colour. My recommendation had been paper diorama; the look lab (`?lookLab=1`) showed both, plus an inked storybook look, on the five reference planets. Every later Look step (sky, ground, HUD) follows this choice.

**Done when:** the seed gallery reads as one art style, and a stranger shown a screenshot does not say "prototype".

## Phase 2 — Loop

The loop becomes **Arrive → Find → Frame → Keep.**

**2a. The player takes the picture (1 to 2 PRs).**
- Press a key to open the viewfinder: time slows, the frame letterboxes, zoom is adjustable. Press again to shoot. **That photo is the claim and the logbook image.**
- Soft guidance only: faint corner brackets on the premise's subject when it is in view. No fail state, no score.
- The survey bar stays as a stat ("surveyed 62%"), no longer the trigger. At 100% it prompts for the shot once.
- Why: the pipeline works hard to put a premise on the surface, and today nothing asks the player to look at it. With 4d the journal is written about what they framed, so a careless photo gets a wry entry and a good one gets a keepsake. The reward is intrinsic.

**2b. Land and look (1 PR).** Landing already exists as a state with no purpose. Give it one: free-look from the ground, ground-level photos, flick to take off.

**2c. Short transit (1 PR).** Hold throttle in open space to enter a slipstream (about 10×, with streaks) that eases off near atmospheres. Targets: under 25 seconds between sibling planets, under 45 between systems.

**2d. The logbook as a book (1 PR).** Full-screen spreads: the postcard, name, teaser, journal entry, flight stats, and a rarity stamp (quiet, notable, singular; foil for singular). A grid of postcards as the index. Milestones are one-shot.

**2e. The first 90 seconds (1 PR).** Replace the three-paragraph modal with a title card over the live scene. The first planet is hand-authored and pre-generated, so it always lands and has no LLM wait. Controls are taught in context, once each.

**Done when:** a new player photographs their first premise inside three minutes without reading instructions, and wants to show someone the entry.

## Phase 3 — Sound

**3a. Engine and foley (1 PR).** A WebAudio graph: wind from filtered noise driven by airspeed and air density, paper flutter on bank, atmosphere entry and exit swells, shutter, crumple, a soft tick as the survey fills. CC0 one-shots where synthesis falls short. Mixer and mutes saved locally; audio starts on first input.

**3b. Generative ambience (1 PR).** Each planet already has a register (eerie, playful, cozy, grand…) and a biome. Map those to scale, tempo and instrument patch; the seed picks the motif. Space is a sparse pad; entering an atmosphere crossfades to the planet's bed. No licensed music and almost no download.

**Done when:** eyes closed, you can tell space from atmosphere and a cozy planet from an eerie one.

## Phase 4 — Brain

**4a. Evals first (1 PR).** A 60-seed golden set run through the whole pipeline on the Batch API (half price). An Opus 5.5 judge scores each planet against the Phase 14 quality bar: is it retellable, is it visible through the engine's levers, is it on register, do siblings contrast, does the name fit. A second check looks at a rendered frame of the built planet. The report is attached to the PR. No prompt or model change ships without a run.

**4b. Model migration (1 PR).**
- Lore moves from Sonnet 4.6 to Sonnet 5.5, and so does direction until 4c folds it into the approach call. This is not a string swap: Sonnet 5.5 rejects forced `tool_choice` with a 400. Move to structured outputs (`output_config.format`).
- Also: read content blocks by type (responses can start with thinking), raise `max_tokens` (thinking counts toward it; today's caps are 200 to 900), set `effort` explicitly, handle `stop_reason: "refusal"` by falling back.
- Adopt `@anthropic-ai/sdk` in the worker in place of raw `fetch` for typed errors and retries.

**4c. Fewer, smarter calls (1 to 2 PRs).**
- **One concept call per system.** The model writes all siblings together, so contrast comes from the writing itself. Registers and initials stay as inputs.
- **One call per approach, with the whole catalog in a cached prefix.** 572 assets is about 20k tokens; cache reads on Haiku 5.5 cost $0.01 per million. The model picks IDs directly and the worker validates them. Missing objects still go to Poly Pizza.
- **Delete browser retrieval.** MiniLM, ORT wasm, MiniSearch, and the embeddings in `catalog.json` all go. First load drops by about 30 MB and START no longer waits on a download.
- **Enrich the catalog once.** Caption all 572 assets from contact-sheet renders with a vision model (about $5). Better descriptions mean better picks.
- Update the caching note in `CLAUDE.md`: on the 5.5 models the minimum cacheable prefix is 512 tokens, so caching now pays.

**4d. The journal knows what you photographed (1 PR).** The lore call receives the postcard (about 600 tokens of image) with the concept and the mounted assets, and writes about what is in the frame. Singular-tier planets get Opus 5.5.

**4e. The Forge — a bet, timeboxed to two sessions.**
- Today the concept prompt must say "if the premise can't be shown with these kits, pick another premise". That is the ceiling on how wild a planet can be.
- Idea: Claude authors hero props as small JSON recipes (boxes, lathes, extrusions, arrays, mirrors; flat-shaded, vertex-coloured) that a runtime builder compiles. Generation runs offline in batch with a render, critique, revise loop, then a human spot-check on the contact sheet. Passing props join the catalog.
- Go or no-go: at least 14 of 20 trial props pass the spot-check. If go, a standing monthly batch adds roughly 150 props. If no-go, the budget folds back into runtime.

**Done when:** an approach resolves in under 5 seconds at the median, a session costs about $0.05, and the judge score is at or above the pre-migration baseline.

## Phase 5 — Reach

**5a. Performance (1 PR, replaces master-plan Phase 8).** Only the active system is fully built. Far systems are low spheres with no collider. Terrain generation moves off the main thread. Frustum culling goes back on. Budgets: 60 fps on an M1 Air, 30 fps on a mid-range phone.

**5b. Touch and gamepad (1 PR).** Drag-to-steer with a throttle zone, standard gamepad mapping, a HUD that reflows on small screens.

**5c. Share pages (1 PR).** `personalspace.fun/e/<id>` rendered by the worker: postcard, name, teaser, journal entry, stamp, with Open Graph tags so links unfurl. A copy-link button in the logbook. Entries are private until the player shares one. Also: page description, OG image and favicon for the game itself.

**5d. Settings and telemetry (1 PR).** Audio, quality, invert pitch, reduced motion. A first-party funnel in Workers Analytics Engine (boot, start, first atmosphere, first photo, sign-up) and an error beacon. No third-party scripts.

**Done when:** a link shared to a phone unfurls with the postcard, opens, and is playable.

---

## How the $200 a month is spent

I am assuming the $200 is for the game's API key (players plus offline pipelines), not for build sessions.

### Cost per new-player session (estimates)

Based on prompt sizes at the PR tip and prices fetched 2026-11-11. Expect ±50% until 0b's usage log replaces these with measurements.

| Stage | Concepts | Per planet entered | Session (4 planets) | Sessions per $110 |
|---|---|---|---|---|
| **Today** (Haiku 4.5 + Sonnet 4.6) | 45 × $0.0043 = $0.19 | $0.025 | **≈ $0.29** | ≈ 380 |
| **After Phase 0** (lazy concepts, Haiku 5.5 on concept and pick) | 5 × $0.0006 = $0.003 | $0.022 | **≈ $0.09** | ≈ 1,200 |
| **After Phase 4** (per-system concept, cached-catalog picks, photo lore on Sonnet 5.5) | $0.002 | $0.002 + $0.013 per photo | **≈ $0.05** | ≈ 2,200 |

After Phase 4, about 80% of runtime spend is the journal entry, which is the thing the player keeps.

**First measurements (2026-11-12, from the `llm_usage` ledger, small sample).** They land close to the "After Phase 0" row:

| Route | Model | Tokens in / out per call | Cost per call | Estimate was |
|---|---|---|---|---|
| concept (n=30) | Haiku 5.5 | 4,198 / 507 | $0.00067 | $0.0006 |
| tier 2 direct (n=2) | Sonnet 4.6 | 1,761 / 608 | $0.0144 | $0.012 |
| pick (n=2) | Haiku 5.5 | 2,015 / 465 | $0.00044 | $0.0004 |
| tier 3 lore (n=2) | Sonnet 4.6 | 1,214 / 350 | $0.0089 | $0.0098 |

That is about $0.024 per planet entered and about $0.10 for a four-planet session. Latency: concept about 3 s (7 s on the first call after a deploy while the strict schema compiles), pick 3 to 4 s, tier 2 12 to 14 s, tier 3 about 10 s.

### Monthly envelope

| Bucket | $/month | What it buys |
|---|---|---|
| Runtime | 110 | Live generation. Breaker at $3.70 a day. |
| Evals | 30 | About 10 batch runs of the golden set with an Opus judge. |
| Forge and content | 40 | Monthly prop batch if 4e passes; otherwise returns to runtime. |
| Reserve | 20 | Launch-day spikes. |

### Which model does what (after Phase 4)

| Job | Model | Why |
|---|---|---|
| System concepts | Haiku 5.5 (Sonnet 5.5 if the eval says the gap is worth 20×) | Highest volume; decided by judge score per dollar |
| Approach: palette, names, picks | Haiku 5.5 with cached catalog | Fast, cheap, constrained |
| Journal entry with photo | Sonnet 5.5; Opus 5.5 for singular planets | The kept artifact |
| Eval judge, Forge | Opus 5.5 on Batch | Offline, half price |

Prices used, per million tokens in/out: Haiku 5.5 $0.10 / $0.50, Sonnet 5.5 $2 / $10, Opus 5.5 $4 / $20, Haiku 4.5 $1 / $5, Sonnet 4.6 $3 / $15. Batch is 50% off.

## Decisions

Each has a default. I will proceed on the defaults unless you say otherwise.

| # | Decision | Default |
|---|---|---|
| 1 | Replace the passive survey claim with a player-taken photo? | **Yes.** Survey stays as a stat. |
| 2 | Art direction | **Sunlit low-poly** with soft shadows, picked by you in the look lab on 2026-11-12. (I had recommended paper diorama.) |
| 3 | Budget split and daily breaker | **The envelope above, $3.70/day.** |
| 4 | Run the Forge spike? | **Yes, two sessions, after 4c.** |
| 5 | Shared entries: default visibility | **Private until the player shares.** |

## Risks

| Risk | Mitigation |
|---|---|
| Colour baking changes how every asset looks at once | Contact sheet before and after; grade strength is one uniform that can be dialled back |
| Post-processing and shadows cost frames on weak GPUs | Three tiers from day one; low tier is today's pipeline plus true colours |
| The photo claim is less approachable than a bar that fills | Soft brackets, a one-time prompt at full survey, no fail state; playtest before removing the old path |
| Catalog-in-prompt picks invent IDs | Server-side validation with a nearest-name repair; eval tracks invalid-ID rate |
| Haiku 5.5 concepts are flatter than hoped | That is what 4a measures; Sonnet 5.5 for concepts is still about $0.03 a system |
| Forge props look worse than kit assets | Hard go/no-go gate; nothing ships without the spot-check |
| A traffic spike exhausts the day's budget | Breaker degrades to offline generation; reserve bucket; Console hard limit |

## How each phase is verified

1. **Seed gallery** on every PR: 8 fixed seeds, before and after.
2. **Benches:** contact sheet for assets, placement lab for single planets, terrain lab for landforms, a new look lab for art direction.
3. **Eval report** for any prompt or model change (from 4a on).
4. **Usage table** for any change that touches call volume (from 0b on).
5. **Your playtest.** About 20 minutes per PR, against that phase's "done when".

## Appendix — numbers from the 2026-11-11 run

- Tip of stack, offline mode, Chrome on this Mac, 1440×860.
- Loaded right after START: 11 systems, 45 planets, 2,293,443 triangles, 389 meshes, 181 MB JS heap, 121 fps.
- Claim timing with zero input: 44% survey at 5 s from a 28 m warp; claimed within 9 s from a 60 m warp.
- Console: 7 × `GLTFLoader: Couldn't load texture Textures/colormap.png`.
- Catalog: 572 assets (341 Kenney, 189 Quaternius, 42 KayKit). 100 reference an external texture that is not shipped; 243 are multi-material; none carry vertex colours.
- `dist/`: 40 MB. `catalog.json`: 6.9 MB with embeddings.
- Port 5173 was in use by another project, so the run used 5174 and no worker. Live-LLM output quality was judged from the prompts and the PR notes, not from a fresh prod run.
