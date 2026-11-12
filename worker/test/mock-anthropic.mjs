// Zero-spend stand-in for the Anthropic Messages API, for local end-to-end
// tests of the worker. Returns a canned tool_use block for whichever tool
// the request forces, plus a plausible `usage` object.
//
//   node test/mock-anthropic.mjs            # listens on 127.0.0.1:8799
//   PORT=9000 node test/mock-anthropic.mjs
//   npx wrangler dev --port 8797 \
//     --var ANTHROPIC_API_URL:http://127.0.0.1:8799/v1/messages \
//     --var ANTHROPIC_API_KEY:test
//
// Failure knobs (env vars; the worker doesn't forward client headers):
//   MOCK_MODE=no_tool   → reply with a text block, stop_reason "refusal"
//   MOCK_MODE=error     → reply 529 overloaded
//   MOCK_LOG_BODIES=1   → also print each request's system type + user message

import http from 'node:http';

const PORT = Number(process.env.PORT || 8799);
const MODE = process.env.MOCK_MODE || 'ok';
let calls = 0;

function cannedInput(tool) {
  const props = tool?.input_schema?.properties || {};
  switch (tool?.name) {
    case 'world_concept':
      return {
        name: 'Bramlet', teaser: 'a mock world where every kettle points north',
        premise: 'A small grassy world where hundreds of copper kettles sit in rows, spouts all facing north.',
        question: 'who left them to boil?', biome: 'forest',
        terrain: { sea_level: 0.3, amplitude: 0.8 }, landmark_slots: 2, hero_on_water: false,
        creature_budget: 0, density: 'sparse', motif: { kind: 'shared-heading', subjects: 'surface' },
        asset_keywords: ['copper kettles', 'pine trees'],
      };
    case 'world_describe':
      return {
        name: 'Bramlet', biome: 'forest',
        palette: { water: '#224466', low: '#335522', mid: '#557733', high: '#998866', snow: '#ffffff', sky: '#aaccff' },
        atmosphere: 'Still air smelling faintly of tea.',
        landmarks: [{ slotId: 0, kind: 'peak', name: 'Spout Hill' }],
        theme: 'kettle orchard', density: 'sparse',
      };
    case 'world_lore':
      return { surfaceLore: 'Kettles. All of them cold. I didn\'t knock.', landmarkLore: [{ slotId: 0, blurb: 'A hill.' }] };
    case 'pick_assets': {
      const out = { rationale: 'mock pick: first enum value per slot' };
      for (const [k, v] of Object.entries(props)) if (Array.isArray(v.enum)) out[k] = v.enum[0];
      return out;
    }
    default:
      return {};
  }
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    calls++;
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch {}
    const toolName = body.tool_choice?.name || body.tools?.[0]?.name;
    const tool = (body.tools || []).find((t) => t.name === toolName);
    console.log(`[mock] #${calls} ${req.method} ${req.url} model=${body.model} tool=${toolName} key=${req.headers['x-api-key'] ? 'set' : 'missing'}`);
    if (process.env.MOCK_LOG_BODIES) {
      const sys = Array.isArray(body.system) ? 'array(cache_control?)' : typeof body.system;
      console.log(`[mock]    max_tokens=${body.max_tokens} system=${sys} tool_choice=${JSON.stringify(body.tool_choice)}`);
      console.log(`[mock]    user=${body.messages?.[0]?.content}`);
      if (tool?.input_schema?.properties?.hero) console.log(`[mock]    enums=${JSON.stringify(Object.fromEntries(Object.entries(tool.input_schema.properties).filter(([, v]) => v.enum).map(([k, v]) => [k, v.enum])))}`);
    }

    if (MODE === 'error') {
      res.writeHead(529, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'mock overloaded' } }));
      return;
    }

    const usage = {
      input_tokens: 1200 + Math.round(raw.length / 4),
      output_tokens: 250,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    const content = MODE === 'no_tool'
      ? [{ type: 'text', text: 'I can\'t help with that.' }]
      : [{ type: 'tool_use', id: `toolu_mock_${calls}`, name: toolName, input: cannedInput(tool) }];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: `msg_mock_${calls}`, type: 'message', role: 'assistant', model: body.model,
      content, stop_reason: MODE === 'no_tool' ? 'refusal' : 'tool_use', stop_sequence: null, usage,
    }));
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`[mock] anthropic mock on http://127.0.0.1:${PORT} (mode=${MODE})`));
