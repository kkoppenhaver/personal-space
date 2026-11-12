// Request-body hygiene for the LLM proxy. Pure functions, no Hono import —
// unit-testable in plain node.
//
// /concept: the client's `seed` and `context` are IGNORED. The worker
//   re-derives both from (system_seed, planet_index) with the same shared
//   function the client uses, so the prompt is never client-supplied text.
// /tier2, /tier3, /tier2/pick: their contexts echo earlier LLM output back,
//   so they can't be derived. They are reduced to a strict allowlist with
//   length caps instead, and the prompt + KV cache key are built from the
//   sanitized object.
//
// Two invariants (tested in tests/unit/worker-llm-context.test.js):
//   (a) idempotent: sanitize(sanitize(x)) deep-equals sanitize(x);
//   (b) a well-formed context, shaped exactly like the one src/main.js
//       builds, passes through with identical values — so existing KV cache
//       keys (sorted stringify of the context) don't move. To keep (b),
//       absent fields stay absent and explicit nulls stay null; invalid
//       values are dropped, never replaced.

import {
  conceptContextFor, planetSeedFor, RADIUS_MIN, RADIUS_MAX, TIER_IDS,
} from '../../../shared/planet-dice.js';

// Enums mirrored from the tool schemas in routes/llm.js.
export const BIOMES = ['desert', 'ocean', 'forest', 'ice', 'volcanic', 'crystalline', 'gas-stripped', 'alien'];
export const DENSITIES = ['sparse', 'medium', 'dense'];
export const MOTIF_KINDS = ['none', 'uniform-lean', 'all-facing-point', 'grid-rows', 'procession', 'shared-heading'];
export const MOTIF_SUBJECTS = ['surface', 'creatures', 'landmarks'];
export const TIERS = TIER_IDS; // quiet | notable | singular

export const MAX_PLANET_INDEX = 7;
export const ASSET_ID_RE = /^[A-Za-z0-9_:.\-]{1,120}$/;
export const SHORTLIST_MAX = 24;
const PICK_SLOTS = ['hero', 'landmark', 'surface', 'creature'];

// ── Primitives ──────────────────────────────────────────────────────────

// Non-whitespace control characters (whitespace controls — \t \n \v \f \r —
// are collapsed to a space instead, so "a\nb" doesn't become "ab").
const CONTROL_RE = /[\u0000-\u0008\u000E-\u001F\u007F]/g;

/**
 * Normalize untrusted text: non-strings → null; strip control characters;
 * collapse whitespace runs to one space; trim; cap at maxLen; empty → null.
 */
export function cleanText(value, maxLen) {
  if (typeof value !== 'string') return null;
  let s = value.replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) {
    s = s.slice(0, maxLen);
    // Don't leave half a surrogate pair at the cut.
    if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1);
    s = s.trimEnd();
  }
  return s.length ? s : null;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneOf = (list) => (v) => (list.includes(v) ? v : null);
const text = (maxLen) => (v) => cleanText(v, maxLen);
const intIn = (lo, hi) => (v) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
const numIn = (lo, hi) => (v) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const textList = (maxItems, maxLen) => (v) => {
  if (!Array.isArray(v)) return null;
  return v.map((x) => cleanText(x, maxLen)).filter((x) => x !== null).slice(0, maxItems);
};

/**
 * Copy src[key] through `fn` into out[key]. Absent/undefined → stays
 * absent; explicit null → stays null; invalid (fn returns null) → dropped.
 */
function put(out, src, key, fn) {
  if (!Object.prototype.hasOwnProperty.call(src, key)) return;
  const raw = src[key];
  if (raw === undefined) return;
  if (raw === null) { out[key] = null; return; }
  const v = fn(raw);
  if (v !== null && v !== undefined) out[key] = v;
}

// ── /concept ────────────────────────────────────────────────────────────

/**
 * Body { system_seed, planet_index, radius } → { ok, seed, context } with
 * both derived server-side, or { ok:false, error:'identity_required' }.
 * Any client `seed` / `context` is ignored.
 */
export function deriveConceptRequest(body) {
  const b = isObj(body) ? body : {};
  const sys = b.system_seed;
  const idx = b.planet_index;
  if (!Number.isInteger(sys) || sys < 0 || sys > 0xFFFFFFFF
      || !Number.isInteger(idx) || idx < 0 || idx > MAX_PLANET_INDEX) {
    return { ok: false, error: 'identity_required' };
  }
  return {
    ok: true,
    seed: planetSeedFor(sys, idx),
    context: conceptContextFor({ systemSeed: sys, planetIndex: idx, radius: b.radius }),
  };
}

// ── /tier2/direct ───────────────────────────────────────────────────────

const clampRadius = (v) => (typeof v === 'number' && Number.isFinite(v)
  ? Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, v)) : null);

function sanitizeMotif(m) {
  if (!isObj(m)) return null;
  const out = {};
  put(out, m, 'kind', oneOf(MOTIF_KINDS));
  put(out, m, 'subjects', oneOf(MOTIF_SUBJECTS));
  return Object.keys(out).length ? out : null;
}

function sanitizeTier2Concept(c) {
  if (!isObj(c)) return null;
  const out = {};
  put(out, c, 'name', text(40));
  put(out, c, 'teaser', text(160));
  put(out, c, 'premise', text(600));
  put(out, c, 'question', text(240));
  put(out, c, 'biome', oneOf(BIOMES));
  put(out, c, 'density', oneOf(DENSITIES));
  put(out, c, 'landmark_slots', intIn(0, 4));
  put(out, c, 'creature_budget', numIn(0, 1));
  put(out, c, 'motif', sanitizeMotif);
  put(out, c, 'asset_keywords', textList(8, 60));
  return out;
}

/** Tier 2 context { radius, tier, concept } (see _conceptContextOf in src/main.js). */
export function sanitizeTier2Context(ctx) {
  const src = isObj(ctx) ? ctx : {};
  const out = {};
  put(out, src, 'radius', clampRadius);
  put(out, src, 'tier', oneOf(TIERS));
  put(out, src, 'concept', sanitizeTier2Concept);
  // A non-object concept (string, array, …) is dropped above; normalize the
  // "no concept" case to null so the prompt sees the legacy shape.
  if (!('concept' in out)) out.concept = null;
  return out;
}

// ── /tier3 ──────────────────────────────────────────────────────────────

function sanitizeLandmarks(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const lm of list) {
    if (out.length >= 8) break;
    if (!isObj(lm)) continue;
    const e = {};
    put(e, lm, 'slotId', (v) => (Number.isInteger(v) && v >= 0 && v <= 63 ? v : null));
    put(e, lm, 'kind', text(20));
    put(e, lm, 'name', text(60));
    if (Object.keys(e).length) out.push(e);
  }
  return out;
}

function sanitizeTier3Concept(c) {
  if (!isObj(c)) return null;
  const out = {};
  put(out, c, 'teaser', text(160));
  put(out, c, 'premise', text(600));
  put(out, c, 'question', text(240));
  return out;
}

/** Tier 3 context { name, biome, landmarks, concept, tier, mounted } (see _tier3ContextOf). */
export function sanitizeTier3Context(ctx) {
  const src = isObj(ctx) ? ctx : {};
  const out = {};
  put(out, src, 'name', text(40));
  put(out, src, 'biome', text(40));
  put(out, src, 'landmarks', sanitizeLandmarks);
  put(out, src, 'concept', sanitizeTier3Concept);
  put(out, src, 'tier', oneOf(TIERS));
  put(out, src, 'mounted', textList(12, 80));
  return out;
}

// ── /tier2/pick ─────────────────────────────────────────────────────────

/** Valid ids only, de-duplicated (first occurrence wins), capped. */
function cleanIdList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const id of list) {
    if (out.length >= SHORTLIST_MAX) break;
    if (typeof id !== 'string' || !ASSET_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function sanitizeDirection(d) {
  if (!isObj(d)) return null;
  const out = {};
  put(out, d, 'theme', text(200));
  put(out, d, 'biome', text(40));
  put(out, d, 'density', oneOf(DENSITIES));
  put(out, d, 'anchor_pack', text(60));
  put(out, d, 'premise', text(600));
  return out;
}

function sanitizeMetaList(list, allowed) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const m of list) {
    if (out.length >= SHORTLIST_MAX) break;
    if (!isObj(m) || typeof m.id !== 'string' || !allowed.has(m.id) || seen.has(m.id)) continue;
    seen.add(m.id);
    const e = { id: m.id };
    put(e, m, 'pack', text(40));
    put(e, m, 'family', text(40));
    put(e, m, 'name', text(80));
    put(e, m, 'note', text(240));
    out.push(e);
  }
  return out;
}

/**
 * Body { seed, direction, shortlist, shortlist_meta } →
 * { ok:true, seed, direction, shortlist, shortlistMeta } or { ok:false, error }.
 * hero / landmark / surface must each keep at least one valid id; creature
 * is optional. Invalid ids are dropped; meta entries for ids not in the
 * matching shortlist are dropped.
 */
export function sanitizePickBody(body) {
  if (!isObj(body)) return { ok: false, error: 'bad_json' };
  if (typeof body.seed !== 'number' || !Number.isFinite(body.seed)) return { ok: false, error: 'seed_required' };
  const seed = (body.seed | 0) >>> 0;

  const sl = isObj(body.shortlist) ? body.shortlist : {};
  const shortlist = {};
  for (const slot of PICK_SLOTS) {
    const ids = cleanIdList(sl[slot]);
    if (ids.length) shortlist[slot] = ids;
  }
  if (!shortlist.hero || !shortlist.landmark || !shortlist.surface) {
    return { ok: false, error: 'incomplete_shortlist' };
  }

  let shortlistMeta = null;
  if (isObj(body.shortlist_meta)) {
    shortlistMeta = {};
    for (const slot of PICK_SLOTS) {
      if (!shortlist[slot]) continue;
      const meta = sanitizeMetaList(body.shortlist_meta[slot], new Set(shortlist[slot]));
      // A slot whose meta was missing or entirely invalid still shows the
      // model its candidates, as bare ids.
      shortlistMeta[slot] = meta.length ? meta : shortlist[slot].map((id) => ({ id }));
    }
  }

  return {
    ok: true,
    seed,
    direction: sanitizeDirection(body.direction),
    shortlist,
    shortlistMeta,
  };
}
