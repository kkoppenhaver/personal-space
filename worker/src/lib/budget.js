// Daily spend breaker + usage ledger for the LLM proxy.
//
// Every Anthropic response's `usage` is priced and upserted into D1
// (`llm_usage`, one row per UTC day x route x model), so a day's spend is
// one SQL query. Before any UNCACHED upstream call, routes ask
// budgetStatus(); once the day's total reaches DAILY_BUDGET_USD they answer
// 503 {degraded:true} and the client falls back to its offline generator.
//
// Failure posture matches ratelimit.js: any DB error fails OPEN. The hard
// backstop is the account-level spend limit in the Anthropic Console.

// USD per million tokens.
export const PRICES = {
  'claude-haiku-5-5':  { in: 0.10, out: 0.50, cacheWrite: 0.125, cacheRead: 0.01 },
  'claude-haiku-4-5':  { in: 1,    out: 5,    cacheWrite: 1.25,  cacheRead: 0.10 },
  'claude-sonnet-4-6': { in: 3,    out: 15,   cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-sonnet-5-5': { in: 2,    out: 10,   cacheWrite: 2.50,  cacheRead: 0.10 },
  'claude-opus-5-5':   { in: 4,    out: 20,   cacheWrite: 5,     cacheRead: 0.20 },
};

// Unknown models are priced as the most expensive entry (by output rate,
// then input) so a typo never makes spend look cheaper than it is.
const FALLBACK_PRICE = Object.values(PRICES)
  .reduce((a, b) => (b.out > a.out || (b.out === a.out && b.in > a.in) ? b : a));

export function priceFor(model) {
  const p = PRICES[model];
  if (p) return p;
  console.warn(`budget: no price for model "${model}"; using the most expensive entry`);
  return FALLBACK_PRICE;
}

const tok = (n) => (Number.isFinite(n) && n > 0 ? n : 0);

/** Pure: USD cost of one response's `usage` object. */
export function costUsd(model, usage) {
  const u = usage || {};
  const p = priceFor(model);
  return (
    tok(u.input_tokens) * p.in
    + tok(u.output_tokens) * p.out
    + tok(u.cache_creation_input_tokens) * p.cacheWrite
    + tok(u.cache_read_input_tokens) * p.cacheRead
  ) / 1e6;
}

/** Current UTC day as YYYY-MM-DD. */
export function utcDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

export function budgetLimit(env) {
  const v = parseFloat(env?.DAILY_BUDGET_USD);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// Per-isolate cache of today's spend. Isolates are short-lived and many, so
// this is an approximation; each isolate adds its own spend immediately
// and re-reads the shared total every 30 s. Overshoot is bounded by
// (isolates x 30 s of traffic), which the account limit backstops.
const SPENT_TTL_MS = 30_000;
let spentCache = { day: null, usd: 0, at: 0 };

/** Test hook. */
export function _resetBudgetCache() { spentCache = { day: null, usd: 0, at: 0 }; }

/** → { ok, spentUsd, limitUsd }. limitUsd null = no limit. */
export async function budgetStatus(env) {
  const limitUsd = budgetLimit(env);
  if (limitUsd === null) return { ok: true, spentUsd: null, limitUsd: null };
  const day = utcDay();
  const now = Date.now();
  if (spentCache.day !== day || now - spentCache.at > SPENT_TTL_MS) {
    try {
      const row = await env.DB
        .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM llm_usage WHERE day = ?1')
        .bind(day).first();
      spentCache = { day, usd: Number(row?.spent) || 0, at: now };
    } catch (e) {
      console.error('budget: spend query failed; failing open', e);
      return { ok: true, spentUsd: null, limitUsd };
    }
  }
  return { ok: spentCache.usd < limitUsd, spentUsd: spentCache.usd, limitUsd };
}

/** Seconds until the next UTC midnight (when the breaker resets). */
export function secondsUntilUtcMidnight(now = Date.now()) {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now) / 1000));
}

const UPSERT_SQL = `
  INSERT INTO llm_usage (day, route, model, calls, cache_hits, errors,
                         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
  ON CONFLICT(day, route, model) DO UPDATE SET
    calls              = calls              + excluded.calls,
    cache_hits         = cache_hits         + excluded.cache_hits,
    errors             = errors             + excluded.errors,
    input_tokens       = input_tokens       + excluded.input_tokens,
    output_tokens      = output_tokens      + excluded.output_tokens,
    cache_read_tokens  = cache_read_tokens  + excluded.cache_read_tokens,
    cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
    cost_usd           = cost_usd           + excluded.cost_usd`;

// Fire-and-forget upsert. Never throws into the request.
function upsert(c, route, model, d) {
  try {
    const db = c.env?.DB;
    if (!db) return;
    const p = db.prepare(UPSERT_SQL).bind(
      utcDay(), String(route), String(model),
      d.calls || 0, d.cacheHits || 0, d.errors || 0,
      d.input || 0, d.output || 0, d.cacheRead || 0, d.cacheWrite || 0,
      d.cost || 0,
    ).run().catch((e) => console.error('budget: usage upsert failed', e));
    c.executionCtx.waitUntil(p);
  } catch (e) {
    console.error('budget: usage upsert failed', e);
  }
}

/** Record one billed upstream call. Returns its cost in USD. */
export function recordUsage(c, { route, model, usage }) {
  try {
    const u = usage || {};
    const cost = costUsd(model, u);
    // Count our own spend immediately so this isolate's next budget check
    // sees it without waiting for the 30 s refresh.
    if (spentCache.day === utcDay()) spentCache.usd += cost;
    upsert(c, route, model, {
      calls: 1,
      input: tok(u.input_tokens),
      output: tok(u.output_tokens),
      cacheRead: tok(u.cache_read_input_tokens),
      cacheWrite: tok(u.cache_creation_input_tokens),
      cost,
    });
    return cost;
  } catch (e) {
    console.error('budget: recordUsage failed', e);
    return 0;
  }
}

export function recordCacheHit(c, route, model) {
  upsert(c, route, model, { cacheHits: 1 });
}

export function recordError(c, route, model) {
  upsert(c, route, model, { errors: 1 });
}
