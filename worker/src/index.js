// Cloudflare Worker — Anthropic API proxy for Personal Space.
// Routes:
//   POST /tier1  → claude-haiku-4-5     → { teaser }
//   POST /tier2  → claude-sonnet-4-6    → full planet meta
//   POST /tier3  → claude-sonnet-4-6    → surface lore + landmark blurbs
//
// Determinism: each request is cached in Workers KV (binding LLM_CACHE) keyed
// by (tier, seed, normalizedContext) so revisits return identical output.
//
// Auth: CORS-style origin allowlist via env.ALLOWED_ORIGINS (comma-separated).

const MODELS = {
  1: 'claude-haiku-4-5',
  2: 'claude-sonnet-4-6',
  3: 'claude-sonnet-4-6',
};

const MAX_TOKENS = { 1: 200, 2: 700, 3: 900 };

const SYSTEM = {
  1: `You are the herald of a procedurally generated cosmos. Output a single evocative 80-char teaser for an unseen world. Concrete, specific, no clichés like "mysterious" or "alien". No proper nouns. Use the "world_teaser" tool to return your answer.`,
  2: `You name a new world. Produce a coined proper noun (1-2 words, not English), a biome, a 6-color hex palette, a one-sentence atmosphere description, and 5-6 named landmarks. Use the "world_describe" tool.`,
  3: `You write the surface lore for an explored world. 3-5 sentences, naturalist's journal style, specific and physical. Plus 1-2 sentence blurbs per landmark. Avoid fantasy clichés. Use the "world_lore" tool.`,
};

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
    description: 'Return the full world description.',
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
      },
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const tierMatch = url.pathname.match(/^\/tier([123])$/);
    if (!tierMatch) return json({ error: 'not found' }, 404, cors);
    if (request.method !== 'POST') return json({ error: 'method' }, 405, cors);

    const tier = parseInt(tierMatch[1], 10);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400, cors); }
    const seed = (body.seed | 0) >>> 0;
    const context = body.context || {};

    const cacheKey = `t${tier}:${seed}:${hashContext(context)}`;

    // Read cache
    if (env.LLM_CACHE) {
      const cached = await env.LLM_CACHE.get(cacheKey, { type: 'json' });
      if (cached) {
        return json(cached, 200, { ...cors, 'x-cache': 'hit' });
      }
    }

    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: 'no api key configured' }, 500, cors);
    }

    const userMsg = JSON.stringify({ seed, context });

    let resp;
    try {
      resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': env.ANTHROPIC_API_KEY,
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
      return json({ error: 'upstream fetch failed', detail: String(e) }, 502, cors);
    }

    if (!resp.ok) {
      const text = await resp.text();
      return json({ error: 'upstream', status: resp.status, detail: text.slice(0, 500) }, 502, cors);
    }

    const apiData = await resp.json();
    const toolUse = (apiData.content || []).find(c => c.type === 'tool_use');
    if (!toolUse) return json({ error: 'no tool_use', raw: apiData }, 502, cors);
    const output = toolUse.input;

    // Write cache (30-day TTL)
    if (env.LLM_CACHE) {
      ctx.waitUntil(env.LLM_CACHE.put(cacheKey, JSON.stringify(output), {
        expirationTtl: 60 * 60 * 24 * 30,
      }));
    }

    return json(output, 200, { ...cors, 'x-cache': 'miss' });
  },
};

function corsHeaders(req, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.get('Origin') || '';
  const ok = allowed.includes(origin) || allowed.includes('*');
  return {
    'access-control-allow-origin': ok ? origin : (allowed[0] || '*'),
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'vary': 'Origin',
  };
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

// Stable hash of context object for cache keys. JSON.stringify with sorted keys.
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
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
