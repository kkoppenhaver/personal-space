// Prompt + schema definitions for each tier. The Worker enforces shape via Anthropic tool mode.

export const TIER1_PROMPT = `You are the herald of a procedurally generated cosmos.

Given a planet seed and minimal context, write a SINGLE evocative teaser describing the world as a paper-airplane pilot would first hear of it. It should feel like a poetic rumor — concrete, specific, strange but plausible.

Rules:
- Maximum 80 characters
- No proper nouns — this is a first impression, not a name
- No "the planet of" preambles — just the image (e.g. "vertical oceans, low and silver")
- Lowercase or sentence case, no exclamation marks
- Be specific. Avoid "mysterious," "strange," "alien"

Return JSON: { "teaser": "..." }`;

export const TIER2_PROMPT = `You name a new world.

Given a planet seed and approach context, return a structured description with:
- A coined proper noun NAME (1-2 words; not English; feels like it could belong to an old map)
- A biome from: desert, ocean, forest, ice, volcanic, crystalline, gas-stripped, alien
- A color palette (6 hex values: water, low, mid, high, snow, sky)
- A one-sentence atmosphere description
- 5-6 LANDMARK NAMES for hero terrain slots. Be specific, evocative, varied. Mix kinds: peaks, basins, coasts, spires.

Return JSON matching the tool schema exactly.`;

export const TIER3_PROMPT = `You write surface lore.

Given a planet name and approach metadata, return 3-5 sentences of ground-level lore — what does this place feel like to stand on, what does the air taste of, what moves, what's silent. Plus one short blurb per landmark (1-2 sentences each).

No clichés. No "ancient civilization" or "mysterious energy." Be specific and physical. Imagine a naturalist's first journal entry, not a fantasy novel.

Return JSON matching the tool schema exactly.`;

// Tool input_schema definitions (JSON Schema) used by the Worker
export const TIER1_SCHEMA = {
  type: 'object',
  properties: { teaser: { type: 'string', maxLength: 80 } },
  required: ['teaser'],
};

export const TIER2_SCHEMA = {
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
};

export const TIER3_SCHEMA = {
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
};
