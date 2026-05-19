// Tiered LLM scheduler. Calls a Cloudflare Worker proxy.
// If workerURL is empty or fetch fails, returns deterministic Placeholder output.

import { placeholderTier1, placeholderTier2, placeholderTier3 } from './Placeholder.js';

const LS_CACHE_KEY = 'paper-airplane:llmcache:v1';

export class LLMClient {
  constructor({ workerURL = '' } = {}) {
    this.workerURL = workerURL.replace(/\/$/, '');
    this.inflight = new Map();      // `${tier}:${seed}` -> Promise
    this.cache = loadCache();
  }

  async ping(seed, context = {}) {
    return this._call(1, seed, context, placeholderTier1);
  }

  async approach(seed, context = {}) {
    return this._call(2, seed, context, placeholderTier2);
  }

  async land(seed, context = {}) {
    return this._call(3, seed, context, placeholderTier3);
  }

  async _call(tier, seed, context, fallback) {
    const key = `${tier}:${seed >>> 0}`;
    if (this.cache[key]) return this.cache[key];
    if (this.inflight.has(key)) return this.inflight.get(key);

    const p = (async () => {
      // No worker configured → straight to fallback (deterministic, instant).
      if (!this.workerURL) {
        const out = fallback(seed);
        this._memo(key, out);
        return out;
      }
      try {
        const ctl = new AbortController();
        const timeoutId = setTimeout(() => ctl.abort(), tier === 1 ? 8000 : 12000);
        const resp = await fetch(`${this.workerURL}/tier${tier}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ seed: seed >>> 0, context }),
          signal: ctl.signal,
        });
        clearTimeout(timeoutId);
        if (!resp.ok) throw new Error(`worker ${resp.status}`);
        const json = await resp.json();
        this._memo(key, json);
        return json;
      } catch (err) {
        console.warn(`[LLM] tier ${tier} fallback:`, err.message);
        const out = fallback(seed);
        this._memo(key, out);
        return out;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, p);
    return p;
  }

  _memo(key, value) {
    this.cache[key] = value;
    saveCache(this.cache);
  }
}

function loadCache() {
  try {
    const raw = localStorage.getItem(LS_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}

function saveCache(cache) {
  try { localStorage.setItem(LS_CACHE_KEY, JSON.stringify(cache)); } catch (e) {}
}
