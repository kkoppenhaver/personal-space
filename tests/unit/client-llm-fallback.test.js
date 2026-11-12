import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LLMClient } from '../../src/llm/LLMClient.js';

const LS_KEY = 'paper-airplane:llmcache:v6';

function memoryStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

// fetch stub: a queue of responders; records every request.
function stubFetch(responders) {
  const requests = [];
  const fn = async (url, init = {}) => {
    requests.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const r = responders.shift();
    if (!r) throw new Error('unexpected fetch');
    if (r instanceof Error) throw r;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    };
  };
  fn.requests = requests;
  return fn;
}

const IDENTITY = { system_seed: 7, planet_index: 2, radius: 112.6 };
const CONTEXT = { radius: 113, tier: 'quiet', sparks: ['a', 'b', 'c', 'd'] };
const REAL = { name: 'Real', teaser: 'a real teaser', premise: 'p', question: 'q' };

let savedFetch, savedLS;
beforeEach(() => {
  savedFetch = globalThis.fetch;
  savedLS = globalThis.localStorage;
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  globalThis.localStorage = savedLS;
});

describe('LLMClient fallbacks never persist', () => {
  it('a failed concept call returns a fallback and writes nothing; the next session retries and persists', async () => {
    const ls = memoryStorage();
    globalThis.localStorage = ls;

    // Session 1: worker says 503 degraded.
    globalThis.fetch = stubFetch([{ status: 503, body: { degraded: true } }]);
    const a = new LLMClient({ workerURL: 'https://w.example' });
    const fb = await a.concept(42, CONTEXT, IDENTITY);
    expect(fb.teaser).toBeTruthy();
    expect(fb._fallback).toBe(true);
    expect(JSON.stringify(fb)).not.toContain('_fallback');
    expect(ls.getItem(LS_KEY)).toBeNull();
    expect(a.peekConcept(42)).toBeNull();
    // Same session: served from the session map, no refetch loop.
    expect(await a.concept(42, CONTEXT, IDENTITY)).toBe(fb);
    expect(globalThis.fetch.requests).toHaveLength(1);
    expect(a.netCalls.concept).toBe(1);

    // Session 2 (new page load): retries the real call and persists it.
    globalThis.fetch = stubFetch([{ status: 200, body: REAL }]);
    const b = new LLMClient({ workerURL: 'https://w.example' });
    expect(b.peekConcept(42)).toBeNull();
    const real = await b.concept(42, CONTEXT, IDENTITY);
    expect(real).toEqual(REAL);
    expect(real._fallback).toBeUndefined();
    expect(JSON.parse(ls.getItem(LS_KEY))['concept:42']).toEqual(REAL);
    expect(b.peekConcept(42)).toEqual(REAL);
    expect(b.netCalls.concept).toBe(1);

    // Session 3: real concept is free.
    globalThis.fetch = stubFetch([]);
    const c = new LLMClient({ workerURL: 'https://w.example' });
    expect(c.peekConcept(42)).toEqual(REAL);
    expect(await c.concept(42, CONTEXT, IDENTITY)).toEqual(REAL);
    expect(c.netCalls.concept).toBe(0);
  });

  it('sends cookies, the dev key, and the identity body', async () => {
    globalThis.localStorage = memoryStorage({ 'paper-airplane:devkey': 'sekrit' });
    const f = stubFetch([{ status: 200, body: REAL }]);
    globalThis.fetch = f;
    const llm = new LLMClient({ workerURL: 'https://w.example/' });
    await llm.concept(42, CONTEXT, IDENTITY);
    const [req] = f.requests;
    expect(req.url).toBe('https://w.example/concept');
    expect(req.init.credentials).toBe('include');
    expect(req.init.headers['x-dev-key']).toBe('sekrit');
    expect(req.body).toEqual({ seed: 42, context: CONTEXT, system_seed: 7, planet_index: 2, radius: 113 });
  });

  it('omits x-dev-key when unset and survives a throwing localStorage', async () => {
    globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    const f = stubFetch([{ status: 200, body: REAL }]);
    globalThis.fetch = f;
    const llm = new LLMClient({ workerURL: 'https://w.example' });
    await llm.concept(1, CONTEXT, IDENTITY);
    expect(f.requests[0].init.headers['x-dev-key']).toBeUndefined();
    expect(f.requests[0].init.credentials).toBe('include');
  });

  it('network errors and 401/429 fall back without persisting (tier 3)', async () => {
    const ls = memoryStorage();
    globalThis.localStorage = ls;
    globalThis.fetch = stubFetch([{ status: 401, body: {} }, { status: 429, body: {} }, new TypeError('offline')]);
    const llm = new LLMClient({ workerURL: 'https://w.example' });
    for (const seed of [1, 2, 3]) {
      const out = await llm.land(seed, {});
      expect(out._fallback).toBe(true);
    }
    expect(llm.netCalls.tier3).toBe(3);
    expect(ls.getItem(LS_KEY)).toBeNull();
  });

  it('approach(): a fallback direct is session-only; a real one persists', async () => {
    const ls = memoryStorage();
    globalThis.localStorage = ls;
    globalThis.fetch = stubFetch([{ status: 502, body: {} }]);
    const a = new LLMClient({ workerURL: 'https://w.example' });
    a._pickAssets = async () => null;   // keep retrieval out of this test
    const fb = await a.approach(5, { radius: 100 });
    expect(fb._fallback).toBe(true);
    expect(ls.getItem(LS_KEY)).toBeNull();
    expect(await a.approach(5, { radius: 100 })).toBe(fb);
    expect(a.netCalls.tier2).toBe(1);

    const direct = { name: 'X', biome: 'desert', palette: {} };
    globalThis.fetch = stubFetch([{ status: 200, body: direct }]);
    const b = new LLMClient({ workerURL: 'https://w.example' });
    b._pickAssets = async () => ({ hero: 'h' });
    const merged = await b.approach(5, { radius: 100 });
    expect(merged).toEqual({ ...direct, selected_assets: { hero: 'h' } });
    expect(JSON.parse(ls.getItem(LS_KEY))['2:5']).toEqual(merged);
  });

  it('offline mode (no worker) makes no requests and persists nothing', async () => {
    const ls = memoryStorage();
    globalThis.localStorage = ls;
    globalThis.fetch = stubFetch([]);
    const llm = new LLMClient({ workerURL: '' });
    const c = await llm.concept(9, CONTEXT, IDENTITY);
    expect(c._fallback).toBe(true);
    expect(c.name).toBeTruthy();
    expect(ls.getItem(LS_KEY)).toBeNull();
    expect(Object.values(llm.netCalls).every((n) => n === 0)).toBe(true);
  });

  it('scrubs placeholder entries persisted by older builds, keeps real ones', async () => {
    const { placeholderConcept } = await import('../../src/llm/Placeholder.js');
    const legacy = placeholderConcept(3, { tier: 'quiet' });
    const ls = memoryStorage({ [LS_KEY]: JSON.stringify({ 'concept:3': legacy, 'concept:4': REAL }) });
    globalThis.localStorage = ls;
    const llm = new LLMClient({ workerURL: 'https://w.example' });
    expect(llm.peekConcept(3)).toBeNull();
    expect(llm.peekConcept(4)).toEqual(REAL);
    expect(Object.keys(JSON.parse(ls.getItem(LS_KEY)))).toEqual(['concept:4']);
  });
});
