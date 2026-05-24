// Hybrid retrieval: BM25 + dense (MiniLM) + Reciprocal Rank Fusion +
// Maximum Marginal Relevance + recent-asset demotion.
//
// Used by the Tier 2 LLM pipeline (Phase 3) to shortlist asset candidates
// for the strict-tool-use pick call. v1 catalog ships empty; once
// catalog.json is populated, shortlist() returns ranked asset IDs.
//
// Two load triggers, per the plan:
//   - First-time visitor: preload() is invoked by the welcome modal mount;
//     progress feeds the modal's warmup bar; START PLAYING gates on the
//     returned promise.
//   - Returning visitor: preload() is invoked at game-interactive; hits
//     the browser Cache API for the cached model file → ~200ms init,
//     invisible to the player.
//
// All paths are safe to call repeatedly — _embedderPromise is a singleton
// that resolves once. preload() during welcome modal and a stray
// shortlist() call during game-interactive coexist cleanly.

import MiniSearch from 'minisearch';
import catalog from './assets/catalog.json' with { type: 'json' };

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const DTYPE = 'q8';
const DIM = 384;

// localStorage key for the recent-used-asset ring buffer. Tracks the last N
// asset IDs the player saw on their personal galaxy so we can demote them in
// retrieval scoring (don't show all-crystal planets back-to-back).
const RECENT_KEY = 'personalspace:recent-assets:v1';
const RECENT_CAP = 20;

// MMR + RRF defaults. λ=0.7 leans relevance; drop to 0.5 if shortlists feel
// too samey. RRF k=60 is the documented sweet spot; smaller k amplifies
// rank-1, larger averages across retrievers.
const MMR_LAMBDA = 0.7;
const RRF_K = 60;

// Recently-used demotion: multiplicative score penalty. 0.3 is aggressive;
// 0.7 is gentle. Start aggressive; tune in pilot.
const RECENCY_PENALTY = 0.3;

let _embedderPromise = null;
let _bm25 = null;

// ─── Lifecycle ──────────────────────────────────────────────────────────

/**
 * Validate that the committed catalog.json was produced by the same model
 * + dtype we'll use at runtime. Mismatch → silent cosine drift → bad
 * shortlists. We log loudly and fall back to BM25-only retrieval.
 *
 * @returns {boolean} true if catalog is usable for dense retrieval
 */
function checkCatalogSanity() {
  if (catalog.model !== MODEL || catalog.dtype !== DTYPE || catalog.dim !== DIM) {
    console.warn(
      `[AssetRetriever] catalog.json model/dtype/dim mismatch:`,
      { catalog: { model: catalog.model, dtype: catalog.dtype, dim: catalog.dim },
        runtime: { model: MODEL, dtype: DTYPE, dim: DIM } },
      `Falling back to BM25-only retrieval. Re-run \`npm run build:catalog\`.`,
    );
    return false;
  }
  return true;
}

/**
 * Preload the MiniLM embedder. Returns a promise that resolves when the
 * model is ready for inference. Idempotent — subsequent calls return the
 * same promise.
 *
 * @param {{ onProgress?: (frac: number, status: string) => void }} [opts]
 *   onProgress: 0..1 fraction + status string ('download' | 'init' | 'ready')
 * @returns {Promise<void>}
 */
export function preload({ onProgress } = {}) {
  if (_embedderPromise) return _embedderPromise.then(() => {});

  _embedderPromise = (async () => {
    if (!checkCatalogSanity()) {
      // Catalog mismatch — don't bother loading the dense model. BM25
      // alone will still serve shortlists from the catalog.
      onProgress?.(1, 'ready');
      return null;
    }

    onProgress?.(0, 'download');
    const { pipeline, env } = await import('@huggingface/transformers');
    // Default useBrowserCache=true backs by Cache API; first-time visitors
    // download ~22 MB, returning visitors hit cache.
    env.allowLocalModels = false;

    // The MiniLM model is split across several files (config.json,
    // tokenizer.json, onnx/model_quantized.onnx, …). progress_callback
    // fires per-file with `loaded`/`total` bytes. If we forward each
    // file's % directly the bar jumps to 100% on each completed file
    // then snaps back when the next one starts. Sum bytes across all
    // known files for a single monotonic 0→1 fraction instead.
    const fileBytes = new Map(); // file → { loaded, total }
    const emitTotal = () => {
      let loaded = 0;
      let total = 0;
      for (const v of fileBytes.values()) {
        loaded += v.loaded;
        total += v.total;
      }
      if (total > 0) onProgress?.(Math.min(1, loaded / total), 'download');
    };

    const embedder = await pipeline('feature-extraction', MODEL, {
      dtype: DTYPE,
      progress_callback: (p) => {
        if (!p.file) return;
        if (p.status === 'progress' && typeof p.loaded === 'number' && typeof p.total === 'number') {
          fileBytes.set(p.file, { loaded: p.loaded, total: p.total });
          emitTotal();
        } else if (p.status === 'done') {
          // Snap this file to 100% on completion so the aggregate climbs
          // even when the last `progress` event lagged behind the final
          // bytes. Skipped if we never saw a progress event (cached file
          // — no bytes downloaded).
          const e = fileBytes.get(p.file);
          if (e) { e.loaded = e.total; emitTotal(); }
        }
      },
    });

    onProgress?.(1, 'ready');
    return embedder;
  })();

  return _embedderPromise.then(() => {});
}

/**
 * Is the embedder ready right now (no awaiting)? Useful for the fast-player
 * fallback path in Tier 2.
 */
export function isReady() {
  return _embedderPromise !== null && _bm25 !== null;
}

// ─── BM25 lazy build ────────────────────────────────────────────────────

function bm25() {
  if (_bm25) return _bm25;
  _bm25 = new MiniSearch({
    fields: ['name', 'tags', 'biome_affinity', 'theme_affinity'],
    storeFields: ['id', 'role'],
    extractField: (doc, f) =>
      Array.isArray(doc[f]) ? doc[f].join(' ') : (doc[f] ?? ''),
    processTerm: (term) =>
      term.toLowerCase().replace(/[_-]/g, ' ').split(/\s+/).filter(Boolean),
    searchOptions: {
      boost: { tags: 3, biome_affinity: 2, theme_affinity: 1.5, name: 1 },
      fuzzy: 0.2,
      prefix: true,
      combineWith: 'OR',
    },
  });
  _bm25.addAll(catalog.assets || []);
  return _bm25;
}

// ─── Shortlisting ───────────────────────────────────────────────────────

/**
 * Return the top-K asset IDs for a slot given a free-form query.
 *
 * @param {object} args
 * @param {string|string[]} args.query - LLM-emitted style hint(s)
 * @param {'hero'|'landmark'|'surface'|'decor'} args.role - slot filter
 * @param {number} [args.k=8] - max IDs to return
 * @param {string[]} [args.recentIds] - asset IDs to demote (recently used)
 * @param {string[]} [args.biomeAffinity] - filter to assets matching biome
 * @returns {Promise<{ id: string, score: number, sources: string[] }[]>}
 */
export async function shortlist({ query, role, k = 8, recentIds, biomeAffinity }) {
  if (!catalog.assets || catalog.assets.length === 0) return [];

  const q = Array.isArray(query) ? query.join(' ') : (query || '');
  if (!q.trim()) return [];

  const recent = new Set(recentIds || readRecent());

  // Pre-filter by role + biome affinity if requested.
  const allowed = new Set(
    catalog.assets
      .filter((a) => !role || a.role === role)
      .filter((a) => !biomeAffinity || (a.biome_affinity || []).includes(biomeAffinity))
      .map((a) => a.id)
  );
  if (allowed.size === 0) return [];

  // ── BM25 retrieval ────────────────────────────────────────────────
  const sparseHits = bm25()
    .search(q, { filter: (r) => allowed.has(r.id) })
    .slice(0, k * 3);
  const sparseRanks = new Map(sparseHits.map((h, i) => [h.id, i]));

  // ── Dense retrieval (if embedder loaded + catalog dense-ready) ────
  let denseRanks = new Map();
  let queryVec = null;
  let denseAvailable = false;
  if (_embedderPromise) {
    const embedder = await _embedderPromise;
    if (embedder) {
      const out = await embedder(q, { pooling: 'mean', normalize: true });
      queryVec = Array.from(out.data);
      const denseHits = denseSearch(queryVec, allowed, k * 3);
      denseRanks = new Map(denseHits.map((h, i) => [h.id, i]));
      denseAvailable = true;
    }
  }

  // ── Reciprocal Rank Fusion ────────────────────────────────────────
  const fused = new Map(); // id → { score, sources }
  for (const [id, rank] of sparseRanks) {
    const s = 1 / (RRF_K + rank + 1);
    push(fused, id, s, 'bm25');
  }
  for (const [id, rank] of denseRanks) {
    const s = 1 / (RRF_K + rank + 1);
    push(fused, id, s, 'mini');
  }

  // ── Recency demotion ──────────────────────────────────────────────
  for (const [id, entry] of fused) {
    if (recent.has(id)) entry.score *= RECENCY_PENALTY;
  }

  // ── Sort by score then apply MMR (only if dense vectors available)
  let candidates = Array.from(fused, ([id, e]) => ({ id, score: e.score, sources: e.sources }))
    .sort((a, b) => b.score - a.score);

  if (denseAvailable && queryVec && candidates.length > k) {
    candidates = mmr(candidates, queryVec, k);
  } else {
    candidates = candidates.slice(0, k);
  }

  return candidates;
}

function push(map, id, score, source) {
  const e = map.get(id);
  if (e) { e.score += score; e.sources.push(source); }
  else { map.set(id, { score, sources: [source] }); }
}

// ─── Dense search ───────────────────────────────────────────────────────

function denseSearch(queryVec, allowedIds, k) {
  const hits = [];
  for (const a of catalog.assets) {
    if (!allowedIds.has(a.id)) continue;
    if (!a.embedding) continue;
    hits.push({ id: a.id, score: cosine(queryVec, a.embedding) });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, k);
}

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s; // vectors are pre-normalized → dot = cosine
}

// ─── MMR (Maximum Marginal Relevance) ──────────────────────────────────

function mmr(candidates, queryVec, k) {
  const embeddings = new Map(catalog.assets.map((a) => [a.id, a.embedding]));
  const picked = [];
  const pool = candidates.slice();
  while (picked.length < k && pool.length) {
    let best = -Infinity;
    let bestIdx = 0;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      const cVec = embeddings.get(c.id);
      if (!cVec) continue;
      const rel = c.score; // already RRF-fused
      let div = 0;
      for (const p of picked) {
        const pVec = embeddings.get(p.id);
        if (!pVec) continue;
        div = Math.max(div, cosine(cVec, pVec));
      }
      const mmrScore = MMR_LAMBDA * rel - (1 - MMR_LAMBDA) * div;
      if (mmrScore > best) { best = mmrScore; bestIdx = i; }
    }
    picked.push(pool.splice(bestIdx, 1)[0]);
  }
  return picked;
}

// ─── Recent-asset ring buffer ──────────────────────────────────────────

function readRecent() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.slice(0, RECENT_CAP) : [];
  } catch { return []; }
}

/**
 * Push asset IDs onto the recently-used ring buffer so the next shortlist
 * call demotes them. Call this whenever a planet's selected assets are
 * committed (after Tier 2 pick resolves and the planet renders).
 *
 * @param {string[]} ids
 */
export function markUsed(ids) {
  if (!ids || !ids.length) return;
  const prev = readRecent();
  const next = [...ids, ...prev.filter((x) => !ids.includes(x))].slice(0, RECENT_CAP);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch {}
}
