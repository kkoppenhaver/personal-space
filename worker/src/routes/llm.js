// LLM proxy — port of the original vanilla /tier1/2/3 handlers.
// Behavior is unchanged: same Anthropic call, same KV caching by
// (tier, seed, hashContext).

import { Hono } from 'hono';

const MODELS = { 1: 'claude-haiku-4-5', 2: 'claude-sonnet-4-6', 3: 'claude-sonnet-4-6' };
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

export const llm = new Hono();

for (const tier of [1, 2, 3]) {
  llm.post(`/tier${tier}`, async (c) => {
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
  });
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
