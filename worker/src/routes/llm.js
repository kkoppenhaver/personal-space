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
  pick: 'claude-haiku-4-5',   // strict enum → hallucination impossible; Haiku is sufficient
};
const MAX_TOKENS = { 1: 200, 2: 900, 3: 900, pick: 300 };

const SYSTEM = {
  1: `You are the herald of a procedurally generated cosmos. Output a single evocative 80-char teaser for an unseen world. Concrete, specific, no clichés like "mysterious" or "alien". No proper nouns. Use the "world_teaser" tool to return your answer.`,
  2: `You direct the look of a new world for an explorer who will see it once and never again. Produce:
- a coined proper noun (1-2 words, not English)
- a biome
- a 6-color hex palette
- a one-sentence atmosphere description
- 5-6 named landmarks with slotId + kind
- a SHORT theme (2-4 words, e.g. "abandoned observatory", "cat sanctuary", "crystal cathedral", "overgrown ruin")
- a density (sparse | medium | dense — sparse is the default; lush themes can pick dense)
- 1-2 hero landmark hints (free-form prose, ~10 words each, describing what dominates the silhouette from approach)
- 3-5 surface feature hints (small descriptive phrases for the things scattered across the ground)
- 3-5 landmark anchor hints (one phrase per landmark slot — what kind of thing lives there)
- a thumbnail framing hint (one phrase suggesting the photogenic angle)
The hints are read by a retrieval system that maps them to 3D models. Be concrete and specific — "twisted obsidian spire" beats "cool tower". Use the "world_describe" tool.`,
  3: `You write the surface lore for an explored world. 3-5 sentences, naturalist's journal style, specific and physical. Plus 1-2 sentence blurbs per landmark. Avoid fantasy clichés. Use the "world_lore" tool.`,
};

// Static system prompt for the asset-pick stage. Cached via prompt-caching
// (we mark this string with cache_control when constructing the request).
const PICK_SYSTEM = `You are picking 3D assets from a retrieval-produced shortlist for a single planet.
The shortlist for each slot is ranked by surface similarity to creative direction prose — NOT by taste. Picking rank-1 every time means the retriever is doing your job.
Apply art direction:
- Avoid theme collisions: if hero is crystal-themed, secondary picks should add contrast (organic / mechanical / atmospheric) unless creative direction explicitly calls for monothematic.
- Prefer assets that share a stylistic family with the hero pick (same pack, similar silhouette weight).
- Use the rationale field to reference which creative-direction phrase each pick serves AND what distinguishes the chosen candidate from others in that slot's shortlist.
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

  // Compact user message — shortlist as a structured prose blob so the
  // model can reason about each candidate by name/role rather than just
  // the enum value.
  const userMsg = JSON.stringify({
    seed,
    direction: body.direction || null,    // optional creative-direction recap
    shortlists: shortlist,
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

async function handleTier(c, tier) {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'bad json' }, 400);

  const seed = (body.seed | 0) >>> 0;
  const context = body.context || {};
  const cacheKey = `t${tier}:${seed}:${hashContext(context)}`;

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
