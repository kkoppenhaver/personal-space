---
title: Planet visuals Phase 14 — concept-as-spine (wild-but-cohesive worlds)
type: feat
status: planned
date: 2026-06-10
parent: docs/plans/2026-05-23-001-feat-planet-visuals-llm-driven-assets-plan.md
supersedes: the archetype TAXONOMY from Phase 12 (the parametric terrain, composition clamps, and creature/float machinery all survive as the engine this phase drives)
---

# Planet visuals Phase 14 — concept-as-spine

## Overview

Phase 12's archetype table fixed LLM mode collapse by **enumerating** variety — but enumeration is the opposite of the product promise. After thirty planets, "ocean world" is a bucket, and buckets read as same-y one level up. Keanan's steer (2026-06-10): optimize for planets that are *truly unique, wild, AND cohesive* — "save it to the logbook and tell your friends" quality — with no visible taxonomy.

This phase replaces category-driven generation with **one weird premise per planet**, generated early and threaded through everything:

> **The unit of sharing is an anecdote, not an environment.** Nobody shares "a big ocean planet." They share *"there's a planet where eight ships sit hull-down in the dunes, all bows to the same heading, and there's no water anywhere."* The generator's job is one specific, nameable, **visible** idea — and then total obedience to it.

## Design pillars (settled in-conversation, 2026-06-10)

1. **Anecdote framing.** Each planet gets a single premise that (a) is specific enough to retell, (b) implies a question the planet never answers, and (c) is *witnessed from the cockpit*, not just described in text. Mystery is a feature: the gap between what you see and what you can explain is the share-impulse.
2. **Wild ≠ random.** Surprise comes from incongruity-with-implied-logic, and cohesion comes from one dominant note — every asset, color, and arrangement auditions against the premise.
3. **Creative freedom in idea-space, hard honesty about render-space.** The concept call is handed the menu of levers we can actually render (terrain shape, palette, asset vocabulary, arrangement motifs, scale/embed/density, naming) and asked for premises expressible through them.
4. **Teaser-first exploration.** The one-sentence call lands at *system spawn* so the player chooses which planets are personally interesting before committing to fly. The teaser IS the premise compressed — arriving must feel like the sentence kept its promise.
5. **Rarity texture.** Not every planet screams. Tier dial: **quiet ~60% / notable ~33% / singular ~7%**, seed-rolled. Tiers control *coordination budget*, not idea-weirdness: motif count, slot-structure exceptions, override permissions, lore length. The quiet ones make the singular ones land.

## The quality bar (worked examples)

Five reference planets, all buildable from the current 572-asset catalog + five new motifs. Teaser → the early sentence; lore voice = "naturalist's journal, spoken not written."

| Tier | Teaser | Build essence |
|---|---|---|
| quiet | "pines here, and a wind that bent every one of them the same way" | pines/birch scatter + **uniform-lean** motif; nothing else unusual |
| quiet-notable | "the foxes keep a statue of a fox" | hero `quaternius:ruins:Statue_Fox` ~2× + Fox herds, **all-facing-point** at the statue, broken columns |
| notable | "an orchard in perfect rows; the sea took the back half" | sea ~0.6, **grid-rows** corn/palms running past the waterline at deep embed, watermill hero |
| notable | "a thousand graves, and every one of them faces the same door" | dry world, gravestone scatter **all-facing-point** at crypt-large hero, **procession** of lightposts |
| singular | "a fleet at anchor on a world with no sea" | sea = 0, desert palette; ship-wreck hero + ship landmarks (cross-role exception), **shared-heading** + embed ~0.4 (hull-down), bones scatter |

Reference lore sample (voice spec, tier 5): *"Eight ships. No water. I don't mean low tide — there is no water on this planet, no basin, no sign there ever was any. They sit hull-down in the dunes like they're riding at anchor, bows all on the same heading, sails still rigged. For what wind? Going where? I climbed the wreck on the high dune. Hold was full of sand. Sand was full of bones. If there was ever a sea here, it left before they did. And they stayed anyway, all of them, pointed at something."*

**Voice spec (all tiers):** naturalist's journal, spoken not written — contractions, short declaratives, one dry aside allowed ("I didn't knock."), end on the question the planet asks, never answer it. No fantasy clichés.

## Architecture

### 1. The concept object — single source of truth

New worker route `POST /concept` (Haiku 4.5, strict tool use), fired per planet at **system spawn** — replacing the existing Tier 1 teaser call at the same call site (ping fan-out, `main.js`), so call volume is ~unchanged and cost is roughly neutral.

```json
{
  "teaser": "a fleet at anchor on a world with no sea",      // ≤80 chars, the nav hook
  "premise": "Sailing ships half-buried in a waterless desert, all pointed the same way — they arrived expecting a sea, or watched one leave.",
  "name_hint": "old-map proper noun direction (optional)",
  "biome": "desert",
  "terrain": { "seaLevelQuantile": 0.0, "ampScale": 0.8 },
  "motif": { "kind": "shared-heading", "subjects": "landmarks", "param": null },
  "asset_keywords": ["shipwreck sailing ship", "bones", "dead tree"],
  "question": "where did the sea go?"                          // private — feeds lore, never shown
}
```

- **Input:** seed + radius + **tier** (rolled client-side, see §3) + **spark dice** (see §2) + the render-lever menu (motif names, terrain ranges, catalog vocabulary summary) + 3-4 few-shot examples at the right tier.
- **Cached** in Worker KV (`concept:{seed}:{hash}`) + client localStorage. Deterministic-after-first-roll; everything downstream derives from the cached object.
- **Teaser path:** HUD pings display `concept.teaser` (Tier 1 route retired; keep as fallback).

### 2. Spark dice — entropy without buckets

Seed-rolled draws from orthogonal lists (material, mood, process, scale-feeling, inhabitant-or-absence, time-feeling — e.g. "salt / grief / drowned / colossal"), passed to the concept call as *inspiration grit*: "keep what sparks, discard freely; never mention the words themselves." ~10⁴-10⁵ combinations, no recognizable categories, cache-stable.

**Archetype demotion:** `Archetypes.js` stops being the taxonomy. Its terrain/composition machinery survives (the concept object now sets those knobs); the weighted table either becomes one die ("setting suggestion") or is deleted once concept output quality is verified. `ruled-by-creatures` etc. stop being categories — they're premises the model can simply have.

### 3. Tier dial (client-side roll, free + deterministic)

`rollTier(seed)` → quiet 0.60 / notable 0.33 / singular 0.07.

| Lever | quiet | notable | singular |
|---|---|---|---|
| motifs | 1 | 1 | up to 2 |
| slot structure | standard | premise-bent (counts vary) | exceptions: hero-role assets in landmark slots |
| embed/scale overrides | no | limited | yes (embed-as-expression up to ~0.45, hero scale to 2×) |
| concept prompt ambition | "one subtle observable note" | "a clear strange thing" | "swing — the planet someone screenshots" |
| lore length | 3-4 sentences | 4-5 | 5-7 |

### 4. Motif engine (placement-side, deterministic)

Five motifs + two permissions, on top of the 13b clustering engine:

- **uniform-lean** — shared tilt vector replaces per-instance random twist (≈10 lines).
- **all-facing-point** — instance rotation aims at a target slot (hero) instead of random twist.
- **grid-rows** — tangent-plane row layout around an anchor, row direction param (e.g. shore-perpendicular); members snap to row lines instead of cluster sampling.
- **procession** — two parallel lines of instances connecting two slots (basin → hero), spacing param.
- **shared-heading** — one twist value for all members of a group (the fleet).
- *Permissions (singular only):* **embed-as-expression** (override family embed up to ~0.45) and **cross-role slot fill** (landmark slots may draw hero-role assets).

Motif application is seeded and pure — same concept object → same arrangement. Motif `subjects` selects what it drives (surface scatter family, creature herd, or landmark set).

### 5. Thread-through cohesion

- **Tier 2 direct** receives the concept object as a HARD constraint (replaces the archetype context): palette, landmark names, and hints must elaborate the premise. Prompt line: "the player was promised: '<teaser>' — arriving must feel like that sentence kept its promise."
- **Pick stage** leads with the premise; the model's job is "does this asset serve the premise?" (taste second).
- **Tier 3 lore** receives the premise + `question` + **the actually-mounted asset list + motif** and writes the journal against what the player really saw, in the voice spec above.
- **Thumbnail framing** (Phase 11, now load-bearing): frame the premise's subject using the existing `thumbnail_framing_hint`.

### 6. Terrain timing

Planets construct synchronously at spawn with seed-default terrain; the concept lands async (~1-2s) and may override `seaLevelQuantile`/`ampScale`. **Re-displacement at distance:** rebuild geometry + recolor + swap collider when the concept arrives, only while the planet is far/unapproached (invisible at distance; the 12a parametric path makes this a parameter change, not new code). If a player somehow beelines before the concept lands, the seed-default terrain stands and the concept call's cached terrain applies next session — acceptable degradation.

## Phasing

- **14a — the spine:** `/concept` route + schema + dice + tier roll; client plumbing (replace Tier 1 at ping fan-out, cache, terrain override + re-displacement); Tier 2/3 prompt rewrites (premise-as-constraint, voice spec, lore-against-mounted); retire archetype context. Ships visible value: teasers become anecdotes and match arrival.
- **14b — the vocabulary:** motif engine (5 motifs + 2 permissions), motif field honored end-to-end, pick-prompt premise-first. The five reference planets become lab-reproducible.
- **14c — force multipliers (existing phases, re-prioritized):** Phase 7 Poly Pizza dynamic (catalog breadth = wilder premises renderable), Phase 11 thumbnail framing (the share artifact).

## Success criteria

- 10 fresh systems: every teaser reads as an anecdote (specific, no biome-description words); arrival visibly matches the teaser (eyeball rubric per planet: "can you point at the premise?").
- 30 concept rolls: no two premises near-identical; singular rate ≈ 1/15; quiet planets still each have one articulable note.
- The five reference planets reproducible in the placement lab via forced concept objects.
- Lore mentions ≥1 actually-mounted asset and ends on an unanswered question; voice passes the "spoken not written" read-aloud test.
- Cost: concept call replaces Tier 1 (≈ neutral); Tier 2/3 cadence unchanged.

## Risks

| Risk | Mitigation |
|---|---|
| Haiku premise quality below the bar | Few-shot the five references at-tier; fall back to Sonnet for `singular` tier only (7% of planets — bounded cost) |
| Motif/asset mismatch (grid-rows of cliff chunks) | Motif menu in the concept prompt lists valid subject families per motif; engine validates and degrades to clustering |
| Terrain re-displacement pops visibly | Only while unapproached + distance-gated; skip override if player inside approach gate |
| Teaser overpromises what render can show | Render-lever menu in the prompt + "the player will SEE this from a paper airplane" instruction; eyeball rubric in verification |
| Premise convergence over many sessions (new mode collapse) | Spark dice entropy + per-user recent-premise ring (text similarity demotion) if observed in practice |

## Effort

~4-5 days: 14a ≈ 2 (worker + plumbing + prompts + re-displacement), 14b ≈ 2 (motifs + verification lab work), 14c rides existing phase plans.
