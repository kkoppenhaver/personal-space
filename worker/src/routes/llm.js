// LLM proxy.
//
// Concept (Haiku 5.5): one premise per planet, fired at system spawn. The
//   worker derives the prompt context from (system_seed, planet_index);
//   the client's context is ignored (see lib/llm-context.js).
// Tier 2 (creative-direction, Sonnet 4.6): extended world description on
//   approach — name / biome / palette / landmarks plus theme / density /
//   style hints that drive the downstream asset retrieval.
// Tier 2 pick (Haiku 5.5): given a retrieval-produced shortlist of asset
//   IDs per slot, picks final asset IDs via strict tool use. Zero
//   hallucination by construction (enum-per-slot).
// Tier 3 (Sonnet 4.6): surface lore + landmark blurbs on claim.
//
// Every route: llmGuard (session or dev key, rate limits, 16 KB body cap)
// → sanitize → KV cache (free, always served) → daily budget breaker →
// Anthropic → usage ledger (lib/budget.js). Any failure is a non-2xx; the
// client falls back to its offline generator on any non-2xx.

import { Hono } from 'hono';
import { llmGuard } from '../lib/llm-guard.js';
import {
  budgetStatus, recordUsage, recordCacheHit, recordError, secondsUntilUtcMidnight,
} from '../lib/budget.js';
import {
  deriveConceptRequest, sanitizeTier2Context, sanitizeTier3Context, sanitizePickBody,
} from '../lib/llm-context.js';
import { checkConcept, checkTier2, checkTier3 } from '../lib/llm-output.js';

const DEFAULT_ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

export const MODELS = {
  2: 'claude-sonnet-4-6',
  3: 'claude-sonnet-4-6',
  pick: 'claude-haiku-5-5',     // strict enum → hallucination impossible; Haiku is sufficient
  concept: 'claude-haiku-5-5',  // one premise per planet, fired at system spawn
};
// Haiku 5.5's tokenizer counts ~30% more tokens than Haiku 4.5's, so the
// concept / pick caps grew with the model switch (600 → 1000, 300 → 600).
const MAX_TOKENS = { 2: 900, 3: 900, pick: 600, concept: 1000 };
// Labels in the llm_usage ledger.
const ROUTE_LABEL = { 2: 'tier2', 3: 'tier3', concept: 'concept', pick: 'pick' };

const SYSTEM = {
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
- LANDFORM (given in the request as "terrain_shape" — build the premise ON it; it is the biggest thing the player sees): rolling (ordinary hills), one-mountain (a single colossal peak; the hero sits on the summit), ridge (one spine circling the world, splitting it into two facing halves), rift (one great canyon cutting the world in two), crater (one enormous bowl; the hero sits in its centre), cratered (pocked with many craters), terraced (stepped like paddies or an amphitheatre), mesas (flat-topped plateaus with cliff sides), spires (needle peaks from a low plain), dunes (long parallel ridges on one heading), archipelago (many small islands in one sea), plates (the ground split into raised tiles, like basalt columns), flat (a plain with almost no relief)
- GROUND PATTERN (given as "ground_pattern" — paint that the land wears): none, patchwork (a quilt of fields), rows (furrows on one heading), rings (concentric bands around the hero), spots (dappled marks), veins (bright cracks), stripes (banded latitudes)
- a 3D model vocabulary (low-poly kits): trees/rocks/flora of all climates; ancient ruins (arches, columns, broken walls, a stone FOX statue, a stone STAG statue); gravestones, crypts, obelisks, lamp posts; castle towers and walls; pirate ships (placeable on water OR land), palms, watch tower; sci-fi (rockets, hangars, satellite dishes, landers, craft, craters, machines); farm crops in rows, fountains, a watermill, pillars; animals (wolf, fox, husky, shiba inu, pug, deer, stag, horse, cow, bull, sheep, pig, llama, alpaca, donkey, zebra)
- arrangement motifs (pick at most one; "none" is common): uniform-lean (everything tilts the same way), all-facing-point (everything faces the hero), grid-rows (planted in measured lines), procession (two lines connecting low ground to the hero), shared-heading (a group aligned on one heading)
- counts and placement: landmark_slots 0-4 (0 = one colossal thing and nothing else), creature_budget 0 / 0.35 / 1.0 (none / incidental wildlife / they own the place), density
- asset_keywords: 3-5 concrete OBJECTS that stand on the ground, most important first (the first becomes the hero and is searched for by name if the kit lacks it — "copper bells", "a cottage", "greenhouse domes", "a kettle"). Never terrain ("dunes", "grass", "worn stone", "hills") — the landform already draws the ground.
If the premise can't be witnessed through these levers, pick a different premise. The landform and pattern are dealt so that neighbouring worlds differ — a premise that ignores them wastes the most visible thing on the planet (a ridge world is where two things face each other across a spine; a crater world is about what sits in the bowl; a terraced world was built or grown in steps).

TIER (given in the request — obey it)
- quiet: one subtle observable note. No spectacle. Most planets are quiet; that's what makes the rare ones land.
- notable: a clear strange thing, premise-bent structure.
- singular: swing. The planet someone screenshots and sends to a friend. Singular only: you may set embed_bias (up to 0.45) to settle things INTO the terrain — hull-down ships, monuments buried to the shoulders.

SPARKS (given in the request)
A few words of inspiration grit. Keep what sparks, discard freely. NEVER use the spark words themselves in the teaser or premise.

REGISTER (given in the request as "register" — obey it)
The emotional key the planet is written in: eerie, playful, tender, absurd, grand, cozy, industrious, celebratory, serene, melancholy, mischievous, proud. The player sees this planet's teaser side by side with its neighbours', and each neighbour was dealt a DIFFERENT register — so the sky reads as a spread of moods, not five elegies. A playful planet is genuinely funny or charming (a hundred pugs in a hedge maze that all lead to one fountain); a cozy one is somewhere you'd want to land; a grand one is awe, not dread. Death, graves, bones, ribs, and ruins are ONE flavor among many — only reach for them when the register is eerie or melancholy. The tier still sets the volume; the register sets the key.

THE NAME
A coined proper noun for the world — 1-2 words, not English, pronounceable. It appears on the player's instruments next to the teaser, long before arrival, so it must sound like it belongs to the premise and register (a cozy world should not sound like a tomb). When "name_initial" is given, the name MUST start with that letter — its neighbours start with other letters, so they never read as a set. Avoid the stems "oss-", "keth-", "vel-", "mal-", "thr-".

THE TEASER
≤80 chars, lowercase, no proper nouns, no "the planet of" preambles. It is the hook the player navigates by — a compressed version of the premise, not a summary ("a fleet at anchor on a world with no sea").

EXAMPLES (one per tier; note the registers differ — spread your planets across the whole range)
quiet, register serene, terrain_shape ridge → {"name":"Veleth","teaser":"pines here, and a wind that bent every one of them the same way","premise":"A forest world where every tree leans the same few degrees toward sunrise, as if the wind only ever blew once, hard.","question":"what bent them?","biome":"forest","terrain":{"sea_level":0.42,"amplitude":1.0,"shape":"ridge","pattern":"none"},"landmark_slots":3,"hero_on_water":false,"creature_budget":0,"density":"medium","motif":{"kind":"uniform-lean","subjects":"surface"},"asset_keywords":["pine trees","birch trees","mossy rocks"]}
notable, register playful, terrain_shape crater, ground_pattern rings → {"name":"Pumbleno","teaser":"forty llamas in a ring around one fountain, all politely waiting their turn","premise":"A grassy little world where a herd of llamas stands in a perfect circle facing a single stone fountain, as if someone told them it opens at noon.","question":"who taught them to queue?","biome":"forest","terrain":{"sea_level":0.3,"amplitude":0.6,"shape":"crater","pattern":"rings"},"landmark_slots":1,"hero_on_water":false,"creature_budget":1.0,"density":"sparse","motif":{"kind":"all-facing-point","subjects":"creatures"},"asset_keywords":["stone fountain","llamas","flower meadow"]}
singular, register grand, terrain_shape dunes → {"name":"Sarqand","teaser":"a fleet at anchor on a world with no sea","premise":"Eight sailing ships sit hull-down in the dunes of a waterless world, bows all on one heading, sails still rigged for a wind going nowhere.","question":"where did the sea go — or did they ever sail at all?","biome":"desert","terrain":{"sea_level":0,"amplitude":0.8,"shape":"dunes","pattern":"none"},"landmark_slots":3,"hero_on_water":false,"creature_budget":0,"density":"sparse","motif":{"kind":"shared-heading","subjects":"landmarks"},"asset_keywords":["sailing ships","sand dunes","palm trees"]}

Do not reuse the examples. Use the "world_concept" tool.`;

const CONCEPT_TOOL = [{
  name: 'world_concept',
  description: 'Return the planet concept.',
  // Strict: the API guarantees every required field arrives as valid JSON.
  // A non-strict forced call on Haiku 5.5 came back with `question` missing
  // and tool markup inside `premise` (1 in 15 in the Phase 0 spot check).
  // Strict schemas allow no min/max/maxLength, need additionalProperties:
  // false on every object, and here every property is required; ranges are
  // enforced afterwards by checkConcept (lib/llm-output.js).
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      teaser: { type: 'string', description: 'At most 80 characters.' },
      premise: { type: 'string' },
      question: { type: 'string' },
      biome: { type: 'string', enum: ['desert','ocean','forest','ice','volcanic','crystalline','gas-stripped','alien'] },
      terrain: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sea_level: { type: 'number', description: '0 to 0.95' },
          amplitude: { type: 'number', description: '0.4 to 1.4' },
          // Echo of the dealt landform/pattern (Phase 15a).
          shape: { type: 'string', enum: ['rolling','one-mountain','ridge','rift','crater','cratered','terraced','mesas','spires','dunes','archipelago','plates','flat'] },
          pattern: { type: 'string', enum: ['none','patchwork','rows','rings','spots','veins','stripes'] },
        },
        required: ['sea_level', 'amplitude', 'shape', 'pattern'],
      },
      landmark_slots: { type: 'integer', description: '0 to 4' },
      hero_on_water: { type: 'boolean' },
      creature_budget: { type: 'number', description: 'Exactly 0, 0.35 or 1.0' },
      density: { type: 'string', enum: ['sparse','medium','dense'] },
      motif: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['none','uniform-lean','all-facing-point','grid-rows','procession','shared-heading'] },
          subjects: { type: 'string', enum: ['surface','creatures','landmarks'] },
        },
        required: ['kind', 'subjects'],
      },
      // Singular tier only: settle things INTO the terrain (0.4 = hull-down
      // ships, half-buried monuments). 0 everywhere else.
      embed_bias: { type: 'number', description: '0 unless the tier is singular; then 0 to 0.45' },
      asset_keywords: { type: 'array', items: { type: 'string' } },
    },
    required: ['name','teaser','premise','question','biome','terrain','landmark_slots','hero_on_water','creature_budget','density','motif','embed_bias','asset_keywords'],
  },
}];

// Static system prompt for the asset-pick stage. Sent uncached — see the
// note at the /tier2/pick upstream call.
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

SYSTEM.concept = CONCEPT_SYSTEM;
TOOLS.concept = CONCEPT_TOOL;

// Per-tier prompt versions. Bump a tier here when its system prompt, tool
// schema, or model changes enough that old cached responses are wrong
// (concept v2: the concept owns the planet name; v5: Haiku 4.5 → 5.5).
// Tiers absent from the map stay on their historical un-versioned keys.
const PROMPT_VERSION = { concept: 5 };

const CACHE_TTL_S = 60 * 60 * 24 * 30;

export const llm = new Hono();

// Concept call (Phase 14a) — fired per planet at system spawn; the cached
// result is the spine every other tier elaborates.
// Body: { system_seed, planet_index, radius } (any seed/context is ignored).
llm.post('/concept', llmGuard, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'bad_json' }, 400);
  const req = deriveConceptRequest(body);
  if (!req.ok) return c.json({ error: req.error }, 400);
  return handleTier(c, 'concept', req.seed, req.context);
});

// Tier 2 creative direction. /tier2/direct is the canonical name; /tier2
// stays as an alias (same `t2:` cache key, so both share results).
// Body: { seed, context: { radius, tier, concept } }
const tier2 = async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'bad_json' }, 400);
  return handleTier(c, 2, (body.seed | 0) >>> 0, sanitizeTier2Context(body.context));
};
llm.post('/tier2', llmGuard, tier2);
llm.post('/tier2/direct', llmGuard, tier2);

// Tier 3 lore. Body: { seed, context: { name, biome, landmarks, concept, tier, mounted } }
llm.post('/tier3', llmGuard, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'bad_json' }, 400);
  return handleTier(c, 3, (body.seed | 0) >>> 0, sanitizeTier3Context(body.context));
});

// ─── Tier 2 pick — strict-tool asset selection ─────────────────────────
//
// Body: { seed, direction, shortlist: { hero, landmark, surface, creature? }, shortlist_meta }
// Returns: { hero, landmark_a, landmark_b, landmark_c, surface_a, surface_b, [creature_a, creature_b,] rationale }
// All returned IDs are guaranteed to come from the corresponding slot's
// shortlist (enforced by strict-tool enum).
llm.post('/tier2/pick', llmGuard, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'bad_json' }, 400);
  const req = sanitizePickBody(body);
  if (!req.ok) return c.json({ error: req.error }, 400);
  const { seed, shortlist } = req;
  const model = MODELS.pick;

  // Cache key — sorted IDs per slot so order doesn't matter; same shortlist
  // hits the same cache entry regardless of input ordering.
  const sortedKey = stableStringify({
    hero: shortlist.hero.slice().sort(),
    landmark: shortlist.landmark.slice().sort(),
    surface: shortlist.surface.slice().sort(),
    // Spread keeps creature-less requests on their historical cache keys.
    ...(shortlist.creature ? { creature: shortlist.creature.slice().sort() } : {}),
  });
  // The premise is part of the key: picking is premise-first, so the same
  // shortlist under a different premise (e.g. after a concept prompt
  // bump) must not return the old pick.
  const premiseKey = fnv1a(req.direction?.premise || '');
  const cacheKey = `t2pick:${seed}:${model}:${fnv1a(sortedKey)}:${premiseKey}`;

  const hit = await cacheGet(c, cacheKey, 'pick', model);
  if (hit) return hit;
  const blocked = await budgetGate(c);
  if (blocked) return blocked;

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
  // creature shortlist (i.e. Tier 2 emitted inhabitant_hints).
  if (shortlist.creature) {
    tool.input_schema.properties.creature_a = { type: 'string', enum: shortlist.creature };
    tool.input_schema.properties.creature_b = { type: 'string', enum: shortlist.creature };
    tool.input_schema.required.push('creature_a', 'creature_b');
  }

  // Compact user message — shortlist as a structured prose blob so the
  // model can reason about each candidate by name/role rather than just
  // the enum value. shortlist_meta annotates each candidate with pack +
  // family so the model can honor pack cohesion.
  const userMsg = JSON.stringify({
    seed,
    direction: req.direction,
    shortlists: req.shortlistMeta || shortlist,
  });

  return callUpstream(c, {
    route: 'pick',
    model,
    cacheKey,
    request: {
      model,
      max_tokens: MAX_TOKENS.pick,
      // Plain string, no cache_control: the tool definition (per-request
      // enums) precedes the system prompt in the cache prefix, so this
      // could never hit, and on Haiku 5.5 (512-token minimum) it would
      // pay the 1.25x cache-write surcharge on every call for nothing.
      system: PICK_SYSTEM,
      tools: [tool],
      tool_choice: { type: 'tool', name: 'pick_assets' },
      messages: [{ role: 'user', content: userMsg }],
    },
  });
});

// ─── Shared handler for /concept, /tier2(/direct), /tier3 ──────────────

async function handleTier(c, tier, seed, context) {
  const model = MODELS[tier];
  const route = ROUTE_LABEL[tier];
  const ver = PROMPT_VERSION[tier] ? `v${PROMPT_VERSION[tier]}:` : '';
  const cacheKey = `t${tier}:${ver}${seed}:${hashContext(context)}`;

  const hit = await cacheGet(c, cacheKey, route, model);
  if (hit) return hit;
  const blocked = await budgetGate(c);
  if (blocked) return blocked;

  return callUpstream(c, {
    route,
    model,
    cacheKey,
    check: OUTPUT_CHECK[tier],
    request: {
      model,
      max_tokens: MAX_TOKENS[tier],
      system: SYSTEM[tier],
      tools: TOOLS[tier],
      tool_choice: { type: 'tool', name: TOOLS[tier][0].name },
      messages: [{ role: 'user', content: JSON.stringify({ seed, context }) }],
    },
  });
}

// Output checkers per tier (lib/llm-output.js). Pick needs none: its strict
// enum schema already guarantees every id comes from the shortlist.
const OUTPUT_CHECK = { concept: checkConcept, 2: checkTier2, 3: checkTier3 };
// A malformed tool call is retried once, then given up on (never cached).
const MAX_ATTEMPTS = 2;

// KV hit → response (always served: it's free). Miss → null.
async function cacheGet(c, cacheKey, route, model) {
  if (!c.env.LLM_CACHE) return null;
  const cached = await c.env.LLM_CACHE.get(cacheKey, { type: 'json' });
  if (!cached) return null;
  recordCacheHit(c, route, model);
  c.header('x-cache', 'hit');
  return c.json(cached);
}

// Daily spend breaker. Checked only on a cache miss.
async function budgetGate(c) {
  const b = await budgetStatus(c.env);
  if (b.ok) return null;
  c.header('retry-after', String(secondsUntilUtcMidnight()));
  return c.json({ error: 'budget_exhausted', degraded: true }, 503);
}

// Anthropic call with ledger bookkeeping. Upstream error bodies are logged,
// never echoed to the client. `check` (optional) validates + normalizes the
// tool input; a malformed one is retried once and never cached.
async function callUpstream(c, { route, model, cacheKey, request, check = null }) {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: 'no api key configured' }, 500);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let resp;
    try {
      resp = await fetch(c.env.ANTHROPIC_API_URL || DEFAULT_ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': c.env.ANTHROPIC_API_KEY,
        },
        body: JSON.stringify(request),
      });
    } catch (e) {
      console.error(`llm ${route}: upstream fetch failed`, e);
      recordError(c, route, model);
      return c.json({ error: 'upstream_fetch_failed' }, 502);
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error(`llm ${route}: upstream ${resp.status}`, text.slice(0, 500));
      recordError(c, route, model);
      return c.json({ error: 'upstream', status: resp.status }, 502);
    }

    const apiData = await resp.json().catch(() => null);
    if (!apiData) {
      recordError(c, route, model);
      return c.json({ error: 'upstream_bad_json' }, 502);
    }
    // Billed regardless of what came back. Ledger rows use the model we
    // asked for, so a day's rows group cleanly by route.
    recordUsage(c, { route, model, usage: apiData.usage });

    const toolUse = (apiData.content || []).find((p) => p.type === 'tool_use');
    // A truncated (max_tokens) or refused turn can't be trusted even if a
    // partial tool_use block is present: never cache it. Not retried — the
    // same request would refuse or truncate again.
    const stop = apiData.stop_reason ?? null;
    if (!toolUse || stop === 'max_tokens' || stop === 'refusal') {
      console.warn(`llm ${route}: no usable tool_use (stop_reason=${stop})`);
      recordError(c, route, model);
      return c.json({ error: 'no_tool_use', stop_reason: stop }, 502);
    }

    const checked = check ? check(toolUse.input) : { ok: true, value: toolUse.input };
    if (!checked.ok) {
      console.warn(`llm ${route}: malformed output (attempt ${attempt}/${MAX_ATTEMPTS}): ${checked.problem}`);
      recordError(c, route, model);
      continue;
    }
    const output = checked.value;

    if (c.env.LLM_CACHE) {
      c.executionCtx.waitUntil(c.env.LLM_CACHE.put(cacheKey, JSON.stringify(output), {
        expirationTtl: CACHE_TTL_S,
      }));
    }

    c.header('x-cache', 'miss');
    return c.json(output);
  }

  return c.json({ error: 'invalid_output' }, 502);
}

function fnv1a(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

function hashContext(ctx) {
  return fnv1a(stableStringify(ctx));
}

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

