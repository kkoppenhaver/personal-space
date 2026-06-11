// Dynamic asset search — Poly Pizza proxy (Phase 7).
//
// The bundled catalog is 572 assets; the concept spine routinely invents
// premises the catalog can't render ("votive candles"). This route lets the
// client search Poly Pizza's CC0 library at hero-pick time, keyed by the
// concept's keywords, without shipping the API key to browsers.
//
// Per the Poly Pizza API ToS:
//   - search results are filtered to CC0, and every result carries creator
//     attribution that the client surfaces (logbook credits + /credits page,
//     which names Poly Pizza with a link);
//   - GLBs are NOT re-hosted or proxied — the client loads them straight
//     from Poly Pizza's CDN (the Download URL), so we never re-serve their
//     content;
//   - searches are KV-cached to keep API load polite, and the API comes
//     with no uptime guarantee — the client treats any failure here as
//     "catalog only", never an error.
//
// Gated on the POLY_PIZZA_API_KEY secret: absent → 503, client skips.

import { Hono } from 'hono';

const PP_API = 'https://api.poly.pizza/v1.1';
const SEARCH_TTL = 60 * 60 * 24 * 7;   // 7d — their library churns slowly
const MAX_TRIS = 60000;                 // keep mounts cheap; heroes are singular

export const assets = new Hono();

// GET /assets/search?q=<keywords>&limit=6
// → { query, results: [{ id, name, url, creator, license, tris, thumbnail }] }
assets.get('/assets/search', async (c) => {
  const q = (c.req.query('q') || '').trim().toLowerCase().slice(0, 80);
  if (!q) return c.json({ error: 'q required' }, 400);
  if (!c.env.POLY_PIZZA_API_KEY) return c.json({ error: 'dynamic assets not configured' }, 503);
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '6', 10) || 6, 1), 12);

  const cacheKey = `pp:v1:${limit}:${q}`;
  if (c.env.LLM_CACHE) {
    const cached = await c.env.LLM_CACHE.get(cacheKey, { type: 'json' });
    if (cached) { c.header('x-cache', 'hit'); return c.json(cached); }
  }

  let resp;
  try {
    resp = await fetch(`${PP_API}/search/${encodeURIComponent(q)}?Limit=${limit * 3}`, {
      headers: { 'x-auth-token': c.env.POLY_PIZZA_API_KEY },
    });
  } catch (e) {
    return c.json({ error: 'upstream fetch failed', detail: String(e) }, 502);
  }
  if (!resp.ok) {
    const text = await resp.text();
    return c.json({ error: 'upstream', status: resp.status, detail: text.slice(0, 300) }, 502);
  }

  const data = await resp.json();
  const results = (data.results || data.Results || [])
    // CC0 only for v1 — no per-asset license text needed on top of the
    // creator + Poly Pizza credits we already surface. CC-BY later.
    .filter((r) => String(r.Licence ?? r.License ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').includes('CC0'))
    .filter((r) => (r['Tri Count'] ?? r.TriCount ?? 0) <= MAX_TRIS)
    .slice(0, limit)
    .map((r) => ({
      id: `polypizza:${r.ID ?? r.Id ?? r.id}`,
      name: r.Title ?? r.title ?? 'untitled',
      url: r.Download ?? r.download ?? null,    // direct CDN URL — loaded by the client, never re-hosted
      creator: r.Creator?.Username ?? r.Creator?.username ?? null,
      license: 'CC0',
      tris: r['Tri Count'] ?? r.TriCount ?? null,
      thumbnail: r.Thumbnail ?? null,
    }))
    .filter((r) => r.url);

  const out = { query: q, results };
  if (c.env.LLM_CACHE) {
    c.executionCtx.waitUntil(c.env.LLM_CACHE.put(cacheKey, JSON.stringify(out), { expirationTtl: SEARCH_TTL }));
  }
  c.header('x-cache', 'miss');
  return c.json(out);
});
