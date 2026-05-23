// Tiered LLM scheduler. Calls a Cloudflare Worker proxy.
// If workerURL is empty or fetch fails, returns deterministic Placeholder output.
//
// Tier 2 is a *two-call chain* as of Phase 3 of the planet-visuals work:
//   1. /tier2/direct → creative direction (biome, theme, density, style hints, ...)
//   2. AssetRetriever.shortlist(hints) → top-K candidate IDs per slot
//   3. /tier2/pick → Haiku 4.5 strict-tool enum pick from the shortlists
// The combined output is what callers see from approach() — a single object
// merging the direct call's world description with the pick's selected
// asset IDs. With an empty catalog (Phase 3 baseline) the pick stage is
// skipped and approach() returns just the direct-call output.

import { placeholderTier1, placeholderTier2, placeholderTier3 } from './Placeholder.js';
import { shortlist as retrieverShortlist } from '../world/AssetRetriever.js';

const LS_CACHE_KEY = 'paper-airplane:llmcache:v1';

// Per the plan: no more than 2 concurrent Tier 2 chains so a mid-flight
// swerve doesn't stack billable calls. Older speculative calls aren't
// cancelled (already billed) — they just complete in the background and
// cache for later. New calls beyond the cap wait for a slot.
const TIER2_MAX_INFLIGHT = 2;
// Retrieval confidence floor: if BM25/dense top-1 across all slots is
// weak, skip the pick call entirely and serve the direct-call output
// without selected asset IDs.
const RETRIEVAL_MIN_TOP_SCORE = 0.05;
// Per-slot shortlist size handed to the pick call.
const SHORTLIST_K = { hero: 8, landmark: 10, surface: 15 };

export class LLMClient {
  constructor({ workerURL = '' } = {}) {
    this.workerURL = workerURL.replace(/\/$/, '');
    this.inflight = new Map();      // `${tier}:${seed}` -> Promise
    this.cache = loadCache();
    this._tier2Slots = 0;           // running count of in-flight Tier 2 chains
    this._tier2Waiters = [];        // queue of `() => void` to release slots
  }

  async ping(seed, context = {}) {
    return this._call(1, seed, context, placeholderTier1);
  }

  async approach(seed, context = {}) {
    const key = `2:${seed >>> 0}`;
    if (this.cache[key]) return this.cache[key];
    if (this.inflight.has(key)) return this.inflight.get(key);

    const p = (async () => {
      await this._acquireTier2Slot();
      try {
        const direct = await this._call(2, seed, context, placeholderTier2, { suffix: '/direct', skipMemo: true });
        if (!direct) return null;

        // Pick stage: only meaningful if the catalog can produce a useful
        // shortlist. Empty catalog → skip; degraded mode → skip.
        let picks = null;
        try {
          picks = await this._pickAssets(seed, direct);
        } catch (err) {
          console.warn('[LLM] tier2 pick failed; continuing without asset IDs:', err.message);
        }

        const merged = picks ? { ...direct, selected_assets: picks } : direct;
        this._memo(key, merged);
        return merged;
      } finally {
        this._releaseTier2Slot();
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, p);
    return p;
  }

  async land(seed, context = {}) {
    return this._call(3, seed, context, placeholderTier3);
  }

  // ── Tier 2 in-flight cap ──────────────────────────────────────────

  _acquireTier2Slot() {
    if (this._tier2Slots < TIER2_MAX_INFLIGHT) {
      this._tier2Slots++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this._tier2Waiters.push(resolve));
  }

  _releaseTier2Slot() {
    if (this._tier2Waiters.length) {
      const next = this._tier2Waiters.shift();
      next();
    } else {
      this._tier2Slots = Math.max(0, this._tier2Slots - 1);
    }
  }

  // ── Tier 2 pick: retrieve shortlist + strict-tool pick ──────────────

  async _pickAssets(seed, direct) {
    // Build per-slot queries from the direct call's hints.
    const heroQuery = (direct.hero_landmark_hints || []).join(' ');
    const landmarkQuery = (direct.landmark_anchor_hints || []).join(' ');
    const surfaceQuery = (direct.surface_feature_hints || []).join(' ');

    if (!heroQuery && !landmarkQuery && !surfaceQuery) {
      // Direct call returned no hints (placeholder fallback or older
      // schema) — nothing to retrieve against.
      return null;
    }

    const [hero, landmark, surface] = await Promise.all([
      retrieverShortlist({ query: heroQuery, role: 'hero', k: SHORTLIST_K.hero, biomeAffinity: direct.biome }),
      retrieverShortlist({ query: landmarkQuery, role: 'landmark', k: SHORTLIST_K.landmark, biomeAffinity: direct.biome }),
      retrieverShortlist({ query: surfaceQuery, role: 'surface', k: SHORTLIST_K.surface, biomeAffinity: direct.biome }),
    ]);

    // Threshold guard: if every shortlist is empty OR top scores are too
    // weak, skip the pick call. Saves an LLM call on garbage shortlists
    // and prevents incoherent picks.
    const bestScore = Math.max(
      hero[0]?.score ?? 0,
      landmark[0]?.score ?? 0,
      surface[0]?.score ?? 0,
    );
    if (!hero.length || !landmark.length || !surface.length || bestScore < RETRIEVAL_MIN_TOP_SCORE) {
      console.info('[LLM] tier2 pick skipped (low-confidence retrieval)', {
        seed, bestScore, sizes: [hero.length, landmark.length, surface.length],
      });
      return null;
    }

    // Need ≥3 landmarks + ≥2 surface for the pick schema's slot count.
    // Pad with top-N duplicates if the shortlist is small (won't happen
    // with k=10/15 once catalog is real-size, but defensive).
    while (landmark.length < 3) landmark.push(landmark[0]);
    while (surface.length < 2) surface.push(surface[0]);

    if (!this.workerURL) {
      // No worker — pick top-1 per slot deterministically.
      return degradedPick(hero, landmark, surface);
    }

    try {
      const ctl = new AbortController();
      const timeoutId = setTimeout(() => ctl.abort(), 8000);
      const resp = await fetch(`${this.workerURL}/tier2/pick`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: ctl.signal,
        body: JSON.stringify({
          seed: seed >>> 0,
          direction: { theme: direct.theme, biome: direct.biome, density: direct.density },
          shortlist: {
            hero: hero.map((h) => h.id),
            landmark: landmark.map((l) => l.id),
            surface: surface.map((s) => s.id),
          },
        }),
      });
      clearTimeout(timeoutId);
      if (!resp.ok) throw new Error(`worker ${resp.status}`);
      return await resp.json();
    } catch (err) {
      console.warn('[LLM] tier2 pick fetch failed; degraded pick:', err.message);
      return degradedPick(hero, landmark, surface);
    }
  }

  // ── Generic single-tier call ──────────────────────────────────────

  async _call(tier, seed, context, fallback, { suffix = '', skipMemo = false } = {}) {
    const key = `${tier}:${seed >>> 0}`;
    if (!skipMemo && this.cache[key]) return this.cache[key];
    if (!skipMemo && this.inflight.has(key)) return this.inflight.get(key);

    const p = (async () => {
      if (!this.workerURL) {
        const out = fallback(seed);
        if (!skipMemo) this._memo(key, out);
        return out;
      }
      try {
        const ctl = new AbortController();
        const timeoutId = setTimeout(() => ctl.abort(), tier === 1 ? 8000 : 12000);
        const resp = await fetch(`${this.workerURL}/tier${tier}${suffix}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ seed: seed >>> 0, context }),
          signal: ctl.signal,
        });
        clearTimeout(timeoutId);
        if (!resp.ok) throw new Error(`worker ${resp.status}`);
        const json = await resp.json();
        if (!skipMemo) this._memo(key, json);
        return json;
      } catch (err) {
        console.warn(`[LLM] tier ${tier}${suffix} fallback:`, err.message);
        const out = fallback(seed);
        if (!skipMemo) this._memo(key, out);
        return out;
      } finally {
        if (!skipMemo) this.inflight.delete(key);
      }
    })();

    if (!skipMemo) this.inflight.set(key, p);
    return p;
  }

  _memo(key, value) {
    this.cache[key] = value;
    saveCache(this.cache);
  }
}

// Deterministic top-1 fallback for when /tier2/pick can't run (no worker,
// pick fetch failed, etc). Still returns valid asset IDs from the
// shortlist so callers can mount visuals — just without LLM taste.
function degradedPick(hero, landmark, surface) {
  return {
    hero: hero[0].id,
    landmark_a: landmark[0]?.id,
    landmark_b: landmark[1]?.id ?? landmark[0]?.id,
    landmark_c: landmark[2]?.id ?? landmark[0]?.id,
    surface_a: surface[0]?.id,
    surface_b: surface[1]?.id ?? surface[0]?.id,
    rationale: 'degraded: top-1 per slot from retrieval (no LLM taste applied)',
    degraded: true,
  };
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
