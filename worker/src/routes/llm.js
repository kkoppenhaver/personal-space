// LLM proxy.
//
// Tier 1: short teaser (Haiku) on system spawn.
// Tier 2 (creative-direction): extended world description (Sonnet) on
//   approach. Now emits theme / density / style hints in addition to
//   the original name / biome / palette / landmarks — those drive the
//   downstream asset retrieval. Backward-compatible: the new fields are
//   optional and clients that ignore them get exactly the old shape.
// Tier 2 pick (NEW): given a retrieval-produced shortlist of asset IDs
//   per slot, Haiku 4.5 picks final asset IDs via strict tool use. Zero
//   hallucination by construction (enum-per-slot).
// Tier 3: surface lore + landmark blurbs (Sonnet) on claim.

import { Hono } from 'hono';

const MODELS = {
  1: 'claude-haiku-4-5',
  2: 'claude-sonnet-4-6',
  3: 'claude-sonnet-4-6',
  pick: 'claude-haiku-4-5',     // strict enum → hallucination impossible; Haiku is sufficient
  concept: 'claude-haiku-4-5',  // one premise per planet, fired at system spawn
};
const MAX_TOKENS = { 1: 200, 2: 900, 3: 900, pick: 300, concept: 600 };

const SYSTEM = {
  1: `You are the herald of a procedurally generated cosmos. Output a single evocative 80-char teaser for an unseen world. Concrete, specific, no clichés like "mysterious" or "alien". No proper nouns. Use the "world_teaser" tool to return your answer.`,
  2: `You direct the look of a new world for an explorer who will see it once and never again.

The user message carries the planet's CONCEPT — a teaser, a premise, and a question, generated when the planet first appeared on the player's instruments. The player has been navigating BY the teaser; arriving must feel like that sentence kept its promise. The concept is a HARD constraint: the name, palette, landmark names, and every hint must be a specific elaboration of the premise — never a generic version of its biome. The engine has already shaped the terrain to match. When concept.landmark_slots is small (0-2), emptiness is the point. Landmark names should deepen the question, never answer it. If no concept is given (legacy client), invent freely and avoid your own habits.

Produce:
- the world's proper noun — when concept.name is given, return it VERBATIM (it has been on the player's instruments since the planet appeared; renaming it on arrival breaks the promise). Only coin one (1-2 words, not English) when no concept is given.
- a biome (from archetype.biomes when given)
- a 6-color hex palette
- a one-sentence atmosphere description
- 5-6 named landmarks with slotId + kind
- a SHORT theme (2-4 words — a fresh, specific noun phrase a location scout would write, not a generic biome descriptor)
- a density (sparse | medium | dense — sparse is the default; honor archetype.density_hint when present)
- 1-2 hero landmark hints (free-form prose, ~10 words each, describing what dominates the silhouette from approach)
- 3-5 surface feature hints (small descriptive phrases for the things scattered across the ground)
- 3-5 landmark anchor hints (one phrase per landmark slot — what kind of thing lives there)
- 0-2 inhabitant hints (the animal species living on the surface, e.g. "a herd of deer", "foxes everywhere" — ONLY when the world calls for inhabitants; most worlds are empty and should send none)
- a thumbnail framing hint (one phrase suggesting the photogenic angle)
The hints are read by a retrieval system that maps them to 3D models. Be concrete and specific — "twisted obsidian spire" beats "cool tower". Use the "world_describe" tool.`,
  3: `You write the logbook entry for a world the player just claimed — the only artifact they keep of it.

VOICE: a pilot's journal, spoken not written. Contractions, short declaratives, concrete physical detail. One dry aside is allowed ("I didn't knock."). No fantasy clichés, no "ancient civilization", no "mysterious energy".

The user message carries the planet's CONCEPT (premise + question) and, when available, the list of things actually mounted on the surface (the assets the player really saw). Write against what they saw: mention at least one of the mounted things concretely.

The concept's question is scaffolding, not a script: it is the thing the entry never resolves. Let it surface the way it would in a real journal — wondered about mid-entry, implied by an observation, or never asked out loud at all. Do NOT end every entry on a question; a person doesn't. End however this pilot would end this note — a fact, a decision, a detail they can't put down ("I didn't knock." / "They stayed anyway, pointed at something."). Vary the shape; never answer the question. Quiet worlds get 3-4 sentences; notable 4-5; singular 5-7.

Plus 1-2 sentence blurbs per landmark, same voice. Use the "world_lore" tool.`,
};

// ─── Concept call (Phase 14a) — the spine ──────────────────────────────
//
// Fired once per planet at system spawn. Everything downstream (teaser
// shown on the nav ping, Tier 2 creative direction, Tier 3 lore) derives
// from this one cached object. The player navigates BY the teaser, so
// arriving must feel like the sentence kept its promise.
const CONCEPT_SYSTEM = `You invent one planet for a game where players fly a paper airplane between small worlds and keep a logbook of the ones they loved. Your output is the planet's CONCEPT: one weird, specific premise that everything else will obey.

THE RULE OF THE ANECDOTE
A good concept is a thing a player would retell: "there's a planet where eight ships sit half-buried in a desert, all pointed the same way." One specific idea, not a setting description. It should imply a question (who? why? where did it go?) that the planet never answers. Avoid biome-words as the idea ("an ice world" is not a concept; "a sea that froze mid-swell" is).

THE RULE OF VISIBILITY
The player must SEE the premise from a paper airplane. You express it ONLY through these levers:
- terrain: sea_level 0 (waterless) to 0.95 (almost all ocean); amplitude 0.4 (worn flat) to 1.4 (jagged)
- a 3D model vocabulary (low-poly kits): trees/rocks/flora of all climates; ancient ruins (arches, columns, broken walls, a stone FOX statue, a stone STAG statue); gravestones, crypts, obelisks, lamp posts; castle towers and walls; pirate ships (placeable on water OR land), palms, watch tower; sci-fi (rockets, hangars, satellite dishes, landers, craft, craters, machines); farm crops in rows, fountains, a watermill, pillars; animals (wolf, fox, husky, shiba inu, pug, deer, stag, horse, cow, bull, sheep, pig, llama, alpaca, donkey, zebra)
- arrangement motifs (pick at most one; "none" is common): uniform-lean (everything tilts the same way), all-facing-point (everything faces the hero), grid-rows (planted in measured lines), procession (two lines connecting low ground to the hero), shared-heading (a group aligned on one heading)
- counts and placement: landmark_slots 0-4 (0 = one colossal thing and nothing else), creature_budget 0 / 0.35 / 1.0 (none / incidental wildlife / they own the place), density
If the premise can't be witnessed through these levers, pick a different premise.

TIER (given in the request — obey it)
- quiet: one subtle observable note. No spectacle. Most planets are quiet; that's what makes the rare ones land.
- notable: a clear strange thing, premise-bent structure.
- singular: swing. The planet someone screenshots and sends to a friend. Singular only: you may set embed_bias (up to 0.45) to settle things INTO the terrain — hull-down ships, monuments buried to the shoulders.

SPARKS (given in the request)
A few words of inspiration grit. Keep what sparks, discard freely. NEVER use the spark words themselves in the teaser or premise.

THE NAME
A coined proper noun for the world — 1-2 words, not English, pronounceable. It appears on the player's instruments next to the teaser, long before arrival, so it must sound like it belongs to the premise (a burial world should not sound like a beach resort).

THE TEASER
≤80 chars, lowercase, no proper nouns, no "the planet of" preambles. It is the hook the player navigates by — a compressed version of the premise, not a summary ("a fleet at anchor on a world with no sea").

EXAMPLES (one per tier)
quiet → {"name":"Veleth","teaser":"pines here, and a wind that bent every one of them the same way","premise":"A forest world where every tree leans the same few degrees toward sunrise, as if the wind only ever blew once, hard.","question":"what bent them?","biome":"forest","terrain":{"sea_level":0.42,"amplitude":1.0},"landmark_slots":3,"hero_on_water":false,"creature_budget":0,"density":"medium","motif":{"kind":"uniform-lean","subjects":"surface"},"asset_keywords":["pine trees","birch trees","mossy rocks"]}
notable → {"name":"Carnmor","teaser":"a thousand graves, and every one of them faces the same door","premise":"A dry burial world where every gravestone, no two alike, faces a single crypt on the hill; lamp posts make two lines up to its door.","question":"what walks between the lamps at night?","biome":"desert","terrain":{"sea_level":0.15,"amplitude":0.9},"landmark_slots":2,"hero_on_water":false,"creature_budget":0,"density":"dense","motif":{"kind":"all-facing-point","subjects":"surface"},"asset_keywords":["gravestones","crypt","lamp posts","crooked pines"]}
singular → {"name":"Sarqand","teaser":"a fleet at anchor on a world with no sea","premise":"Eight sailing ships sit hull-down in the dunes of a waterless world, bows all on one heading, sails still rigged for a wind going nowhere.","question":"where did the sea go — or did they ever sail at all?","biome":"desert","terrain":{"sea_level":0,"amplitude":0.8},"landmark_slots":3,"hero_on_water":false,"creature_budget":0,"density":"sparse","motif":{"kind":"shared-heading","subjects":"landmarks"},"asset_keywords":["shipwreck sailing ships","bones","dead trees"]}

Do not reuse the examples. Use the "world_concept" tool.`;

const CONCEPT_TOOL = [{
  name: 'world_concept',
  description: 'Return the planet concept.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      teaser: { type: 'string', maxLength: 80 },
      premise: { type: 'string' },
      question: { type: 'string' },
      biome: { type: 'string', enum: ['desert','ocean','forest','ice','volcanic','crystalline','gas-stripped','alien'] },
      terrain: {
        type: 'object',
        properties: {
          sea_level: { type: 'number', minimum: 0, maximum: 0.95 },
          amplitude: { type: 'number', minimum: 0.4, maximum: 1.4 },
        },
        required: ['sea_level', 'amplitude'],
      },
      landmark_slots: { type: 'integer', minimum: 0, maximum: 4 },
      hero_on_water: { type: 'boolean' },
      creature_budget: { type: 'number', enum: [0, 0.35, 1.0] },
      density: { type: 'string', enum: ['sparse','medium','dense'] },
      motif: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['none','uniform-lean','all-facing-point','grid-rows','procession','shared-heading'] },
          subjects: { type: 'string', enum: ['surface','creatures','landmarks'] },
        },
        required: ['kind', 'subjects'],
      },
      // Optional, singular tier only: settle things INTO the terrain
      // (0.4 = hull-down ships, half-buried monuments).
      embed_bias: { type: 'number', minimum: 0, maximum: 0.45 },
      asset_keywords: { type: 'array', items: { type: 'string' } },
    },
    required: ['name','teaser','premise','question','biome','terrain','landmark_slots','hero_on_water','creature_budget','density','motif','asset_keywords'],
  },
}];

// Static system prompt for the asset-pick stage. Cached via prompt-caching
// (we mark this string with cache_control when constructing the request).
const PICK_SYSTEM = `You are picking 3D assets from a retrieval-produced shortlist for a single planet.
When direction.premise is given, it is the planet's reason to exist — your FIRST question for every candidate is "does this asset serve the premise?" Taste comes second. A weaker-looking asset that serves the premise beats a prettier one that dilutes it.
The shortlist for each slot is ranked by surface similarity to creative direction prose — NOT by taste. Picking rank-1 every time means the retriever is doing your job.
Apply art direction:
- Avoid theme collisions: if hero is crystal-themed, secondary picks should add contrast (organic / mechanical / atmospheric) unless creative direction explicitly calls for monothematic.
- Prefer assets that share a stylistic family with the hero pick. Each candidate is annotated with its "pack" (the creator kit it came from) and "family" (rock / flora / structure / …). When a direction.anchor_pack is given, favor candidates from that pack for landmark + surface slots so the planet reads as one cohesive place — UNLESS doing so forces a worse art-direction fit.
- Use the rationale field to reference which creative-direction phrase each pick serves AND what distinguishes the chosen candidate from others in that slot's shortlist.
- When creature slots are present, pick ONE species (creature_a = creature_b is fine) unless the direction calls for mixed wildlife — a planet ruled by one animal reads stronger than a petting zoo.
Use the "pick_assets" tool. Every asset_id you output MUST come from the corresponding slot's shortlist — the tool enforces this.`;

const TOOLS = {
  1: [{
    name: 'world_teaser',
    description: 'Return the world teaser.',
    input_schema: {
      type: 'object',
      properties: { teaser: { type: 'string', maxLength: 80 } },
      required: ['teaser'],
    },
  }],
  2: [{
    name: 'world_describe',
    description: 'Return the full world description + creative direction for asset selection.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        biome: { type: 'string', enum: ['desert','ocean','forest','ice','volcanic','crystalline','gas-stripped','alien'] },
        palette: {
          type: 'object',
          properties: {
            water: { type: 'string' }, low: { type: 'string' },
            mid:   { type: 'string' }, high: { type: 'string' },
            snow:  { type: 'string' }, sky:  { type: 'string' },
          },
          required: ['water','low','mid','high','snow','sky'],
        },
        atmosphere: { type: 'string' },
        landmarks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              slotId: { type: 'integer' },
              kind: { type: 'string', enum: ['peak','basin','coast','spire'] },
              name: { type: 'string' },
            },
            required: ['slotId','kind','name'],
          },
        },
        // ── Creative direction for asset retrieval (new in Phase 3) ────
        theme: { type: 'string' },
        density: { type: 'string', enum: ['sparse','medium','dense'] },
        hero_landmark_hints: { type: 'array', items: { type: 'string' } },
        surface_feature_hints: { type: 'array', items: { type: 'string' } },
        landmark_anchor_hints: { type: 'array', items: { type: 'string' } },
        inhabitant_hints: { type: 'array', items: { type: 'string' } },
        thumbnail_framing_hint: { type: 'string' },
      },
      // Theme/density/hints are NOT required so the Tier 2 schema stays
      // backward-compatible with older worker deploys + the Placeholder
      // generator. Clients use whatever fields are present.
      required: ['name','biome','palette','atmosphere','landmarks'],
    },
  }],
  3: [{
    name: 'world_lore',
    description: 'Return the surface lore and landmark blurbs.',
    input_schema: {
      type: 'object',
      properties: {
        surfaceLore: { type: 'string' },
        landmarkLore: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              slotId: { type: 'integer' },
              blurb: { type: 'string' },
            },
            required: ['slotId','blurb'],
          },
        },
      },
      required: ['surfaceLore','landmarkLore'],
    },
  }],
};

export const llm = new Hono();

for (const tier of [1, 2, 3]) {
  llm.post(`/tier${tier}`, (c) => handleTier(c, tier));
}
// Canonical name for Tier 2 going forward; old /tier2 stays as an alias
// for transition. Cache key is identical (`t2:...`) so old and new
// callers share results.
llm.post('/tier2/direct', (c) => handleTier(c, 2));

// Concept call (Phase 14a) — fired per planet at system spawn; the cached
// result is the spine every other tier elaborates. Same handler shape as
// the numbered tiers (KV key `tconcept:{seed}:{ctxHash}`).
SYSTEM.concept = CONCEPT_SYSTEM;
TOOLS.concept = CONCEPT_TOOL;
llm.post('/concept', (c) => handleTier(c, 'concept'));

// ─── Tier 2 pick — strict-tool asset selection ─────────────────────────
//
// Body: { seed, shortlist: { hero: [id,…], landmark: [id,…], surface: [id,…] } }
// Returns: { hero, landmark_a, landmark_b, landmark_c, surface_a, surface_b, rationale }
// All returned IDs are guaranteed to come from the corresponding slot's
// shortlist (enforced by strict-tool enum).
llm.post('/tier2/pick', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'bad json' }, 400);
  const seed = (body.seed | 0) >>> 0;
  const shortlist = body.shortlist;
  if (!shortlist || !shortlist.hero?.length || !shortlist.landmark?.length || !shortlist.surface?.length) {
    return c.json({ error: 'incomplete shortlist' }, 400);
  }

  // Cache key — sorted IDs per slot so order doesn't matter; same shortlist
  // hits the same cache entry regardless of input ordering.
  const sortedKey = stableStringify({
    hero: shortlist.hero.slice().sort(),
    landmark: shortlist.landmark.slice().sort(),
    surface: shortlist.surface.slice().sort(),
    // Spread keeps creature-less requests on their historical cache keys.
    ...(shortlist.creature?.length ? { creature: shortlist.creature.slice().sort() } : {}),
  });
  const cacheKey = `t2pick:${seed}:${MODELS.pick}:${fnv1a(sortedKey)}`;

  if (c.env.LLM_CACHE) {
    const cached = await c.env.LLM_CACHE.get(cacheKey, { type: 'json' });
    if (cached) { c.header('x-cache', 'hit'); return c.json(cached); }
  }
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: 'no api key configured' }, 500);

  // Build strict-tool schema with enum-per-slot (not array-of-enum — the
  // latter loses maxItems enforcement under Anthropic strict mode).
  const tool = {
    name: 'pick_assets',
    strict: true,
    description: 'Pick final asset IDs from the per-slot shortlists.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['hero','landmark_a','landmark_b','landmark_c','surface_a','surface_b','rationale'],
      properties: {
        hero:       { type: 'string', enum: shortlist.hero },
        landmark_a: { type: 'string', enum: shortlist.landmark },
        landmark_b: { type: 'string', enum: shortlist.landmark },
        landmark_c: { type: 'string', enum: shortlist.landmark },
        surface_a:  { type: 'string', enum: shortlist.surface },
        surface_b:  { type: 'string', enum: shortlist.surface },
        rationale:  { type: 'string' },
      },
    },
  };
  // Creature slots (Phase 12b) appear only when the client retrieved a
  // creature shortlist (i.e. Tier 2 emitted inhabitant_hints). Old clients
  // never send one → identical schema + cache keys to before.
  if (shortlist.creature?.length) {
    tool.input_schema.properties.creature_a = { type: 'string', enum: shortlist.creature };
    tool.input_schema.properties.creature_b = { type: 'string', enum: shortlist.creature };
    tool.input_schema.required.push('creature_a', 'creature_b');
  }

  // Compact user message — shortlist as a structured prose blob so the
  // model can reason about each candidate by name/role rather than just
  // the enum value. shortlist_meta (if the client sent it) annotates each
  // candidate with pack + family so the model can honor pack cohesion.
  const userMsg = JSON.stringify({
    seed,
    direction: body.direction || null,    // optional creative-direction recap (may include anchor_pack)
    shortlists: body.shortlist_meta || shortlist,
  });

  let resp;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': c.env.ANTHROPIC_API_KEY,
      },
      body: JSON.stringify({
        model: MODELS.pick,
        max_tokens: MAX_TOKENS.pick,
        // System as array → enables prompt caching on the static guide.
        // Shortlist + direction stay in messages, not cached.
        system: [
          { type: 'text', text: PICK_SYSTEM, cache_control: { type: 'ephemeral' } },
        ],
        tools: [tool],
        tool_choice: { type: 'tool', name: 'pick_assets' },
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
  } catch (e) {
    return c.json({ error: 'upstream fetch failed', detail: String(e) }, 502);
  }

  if (!resp.ok) {
    const text = await resp.text();
    return c.json({ error: 'upstream', status: resp.status, detail: text.slice(0, 500) }, 502);
  }

  const apiData = await resp.json();
  const toolUse = (apiData.content || []).find((p) => p.type === 'tool_use');
  if (!toolUse) return c.json({ error: 'no tool_use', raw: apiData }, 502);
  const output = toolUse.input;

  if (c.env.LLM_CACHE) {
    c.executionCtx.waitUntil(c.env.LLM_CACHE.put(cacheKey, JSON.stringify(output), {
      expirationTtl: 60 * 60 * 24 * 30,
    }));
  }

  c.header('x-cache', 'miss');
  return c.json(output);
});

// ─── Shared handler for /tier1 /tier2 /tier3 + /tier2/direct ───────────

// Per-tier prompt versions. Bump a tier here when its system prompt or tool
// schema changes shape enough that old cached responses are wrong (concept
// v2: the concept owns the planet name — pre-v2 entries have no name).
// Tiers absent from the map stay on their historical un-versioned keys.
const PROMPT_VERSION = { concept: 2 };

async function handleTier(c, tier) {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'bad json' }, 400);

  const seed = (body.seed | 0) >>> 0;
  const context = body.context || {};
  const ver = PROMPT_VERSION[tier] ? `v${PROMPT_VERSION[tier]}:` : '';
  const cacheKey = `t${tier}:${ver}${seed}:${hashContext(context)}`;

  if (c.env.LLM_CACHE) {
    const cached = await c.env.LLM_CACHE.get(cacheKey, { type: 'json' });
    if (cached) {
      c.header('x-cache', 'hit');
      return c.json(cached);
    }
  }

  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json({ error: 'no api key configured' }, 500);
  }

  const userMsg = JSON.stringify({ seed, context });

  let resp;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': c.env.ANTHROPIC_API_KEY,
      },
      body: JSON.stringify({
        model: MODELS[tier],
        max_tokens: MAX_TOKENS[tier],
        system: SYSTEM[tier],
        tools: TOOLS[tier],
        tool_choice: { type: 'tool', name: TOOLS[tier][0].name },
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
  } catch (e) {
    return c.json({ error: 'upstream fetch failed', detail: String(e) }, 502);
  }

  if (!resp.ok) {
    const text = await resp.text();
    return c.json({ error: 'upstream', status: resp.status, detail: text.slice(0, 500) }, 502);
  }

  const apiData = await resp.json();
  const toolUse = (apiData.content || []).find((p) => p.type === 'tool_use');
  if (!toolUse) return c.json({ error: 'no tool_use', raw: apiData }, 502);
  const output = toolUse.input;

  if (c.env.LLM_CACHE) {
    c.executionCtx.waitUntil(c.env.LLM_CACHE.put(cacheKey, JSON.stringify(output), {
      expirationTtl: 60 * 60 * 24 * 30,
    }));
  }

  c.header('x-cache', 'miss');
  return c.json(output);
}

function fnv1a(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

function hashContext(ctx) {
  const s = stableStringify(ctx);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
