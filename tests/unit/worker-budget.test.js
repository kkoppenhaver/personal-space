import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PRICES,
  costUsd,
  budgetStatus,
  budgetLimit,
  recordUsage,
  recordCacheHit,
  recordError,
  secondsUntilUtcMidnight,
  utcDay,
  _resetBudgetCache,
} from '../../worker/src/lib/budget.js';

const M = 1_000_000;
const usage = (i, o, cw = 0, cr = 0) => ({
  input_tokens: i, output_tokens: o, cache_creation_input_tokens: cw, cache_read_input_tokens: cr,
});

describe('costUsd', () => {
  it('prices each model per million tokens, including cache tokens', () => {
    const cases = {
      'claude-haiku-5-5':  [0.10, 0.50, 0.125, 0.01],
      'claude-haiku-4-5':  [1, 5, 1.25, 0.10],
      'claude-sonnet-4-6': [3, 15, 3.75, 0.30],
      'claude-sonnet-5-5': [2, 10, 2.50, 0.10],
      'claude-opus-5-5':   [4, 20, 5, 0.20],
    };
    expect(Object.keys(PRICES).sort()).toEqual(Object.keys(cases).sort());
    for (const [model, [pin, pout, pcw, pcr]] of Object.entries(cases)) {
      expect(costUsd(model, usage(M, 0))).toBeCloseTo(pin, 10);
      expect(costUsd(model, usage(0, M))).toBeCloseTo(pout, 10);
      expect(costUsd(model, usage(0, 0, M, 0))).toBeCloseTo(pcw, 10);
      expect(costUsd(model, usage(0, 0, 0, M))).toBeCloseTo(pcr, 10);
    }
  });

  it('sums a realistic mixed response', () => {
    // Sonnet 4.6 Tier 2: 2,400 in, 850 out, 1,000 cache write, 3,000 cache read.
    const expected = (2400 * 3 + 850 * 15 + 1000 * 3.75 + 3000 * 0.30) / M;
    expect(costUsd('claude-sonnet-4-6', usage(2400, 850, 1000, 3000))).toBeCloseTo(expected, 12);
    // Haiku 5.5 concept: 1,900 in, 420 out.
    expect(costUsd('claude-haiku-5-5', usage(1900, 420))).toBeCloseTo((1900 * 0.10 + 420 * 0.50) / M, 12);
  });

  it('treats missing, null, negative, or non-numeric fields as zero', () => {
    expect(costUsd('claude-haiku-5-5', {})).toBe(0);
    expect(costUsd('claude-haiku-5-5', undefined)).toBe(0);
    expect(costUsd('claude-haiku-5-5', null)).toBe(0);
    expect(costUsd('claude-haiku-5-5', { input_tokens: 1000 })).toBeCloseTo(1000 * 0.10 / M, 12);
    expect(costUsd('claude-haiku-5-5', { input_tokens: -5, output_tokens: 'lots', cache_read_input_tokens: null })).toBe(0);
  });

  it('prices an unknown model as the most expensive entry and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const u = usage(M, M, M, M);
    const priciest = Math.max(...Object.keys(PRICES).map((m) => costUsd(m, u)));
    expect(costUsd('claude-mystery-9', u)).toBeCloseTo(priciest, 10);
    expect(costUsd('claude-mystery-9', u)).toBeCloseTo(costUsd('claude-opus-5-5', u), 10);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ── budgetStatus / record* with a fake D1 ───────────────────────────────

function fakeEnv({ spent = 0, limit = '3.70', fail = false } = {}) {
  const runs = [];
  let queries = 0;
  const DB = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              queries++;
              if (fail) throw new Error('D1 down');
              return { spent };
            },
            run() {
              runs.push({ sql, args });
              return fail ? Promise.reject(new Error('D1 down')) : Promise.resolve({});
            },
          };
        },
      };
    },
  };
  return { env: { DB, DAILY_BUDGET_USD: limit }, runs, queries: () => queries };
}

function fakeCtx(env) {
  const waited = [];
  return { c: { env, executionCtx: { waitUntil: (p) => waited.push(p) } }, waited };
}

describe('budgetStatus', () => {
  beforeEach(() => _resetBudgetCache());

  it('parses the limit; unset / NaN / <= 0 means no limit', () => {
    expect(budgetLimit({ DAILY_BUDGET_USD: '3.70' })).toBeCloseTo(3.7);
    for (const v of [undefined, '', 'abc', '0', '-1']) expect(budgetLimit({ DAILY_BUDGET_USD: v })).toBeNull();
  });

  it('is ok below the limit and not ok at or above it', async () => {
    expect((await budgetStatus(fakeEnv({ spent: 1.2 }).env)).ok).toBe(true);
    _resetBudgetCache();
    const s = await budgetStatus(fakeEnv({ spent: 3.7 }).env);
    expect(s).toEqual({ ok: false, spentUsd: 3.7, limitUsd: 3.7 });
  });

  it('skips the query entirely when there is no limit', async () => {
    const f = fakeEnv({ limit: '' });
    expect(await budgetStatus(f.env)).toEqual({ ok: true, spentUsd: null, limitUsd: null });
    expect(f.queries()).toBe(0);
  });

  it('caches the day total per isolate', async () => {
    const f = fakeEnv({ spent: 1 });
    await budgetStatus(f.env);
    await budgetStatus(f.env);
    expect(f.queries()).toBe(1);
  });

  it('fails open on a DB error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await budgetStatus(fakeEnv({ fail: true }).env);
    expect(s.ok).toBe(true);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("adds this isolate's own spend immediately", async () => {
    const f = fakeEnv({ spent: 3.69 });
    expect((await budgetStatus(f.env)).ok).toBe(true);
    const { c } = fakeCtx(f.env);
    // 0.02 USD of Sonnet 4.6 output.
    recordUsage(c, { route: 'tier2', model: 'claude-sonnet-4-6', usage: usage(0, Math.round(0.02 / 15 * M)) });
    expect((await budgetStatus(f.env)).ok).toBe(false);
    expect(f.queries()).toBe(1);
  });
});

describe('record*', () => {
  beforeEach(() => _resetBudgetCache());

  it('upserts usage via waitUntil with the right deltas', () => {
    const f = fakeEnv();
    const { c, waited } = fakeCtx(f.env);
    const cost = recordUsage(c, { route: 'concept', model: 'claude-haiku-5-5', usage: usage(1900, 420, 10, 20) });
    expect(waited).toHaveLength(1);
    expect(f.runs).toHaveLength(1);
    const { sql, args } = f.runs[0];
    expect(sql).toMatch(/INSERT INTO llm_usage/);
    expect(sql).toMatch(/ON CONFLICT\(day, route, model\) DO UPDATE/);
    expect(args).toEqual([utcDay(), 'concept', 'claude-haiku-5-5', 1, 0, 0, 1900, 420, 20, 10, cost]);
    expect(cost).toBeCloseTo(costUsd('claude-haiku-5-5', usage(1900, 420, 10, 20)), 12);
  });

  it('records cache hits and errors as counters only', () => {
    const f = fakeEnv();
    const { c } = fakeCtx(f.env);
    recordCacheHit(c, 'tier3', 'claude-sonnet-4-6');
    recordError(c, 'pick', 'claude-haiku-5-5');
    expect(f.runs[0].args.slice(1)).toEqual(['tier3', 'claude-sonnet-4-6', 0, 1, 0, 0, 0, 0, 0, 0]);
    expect(f.runs[1].args.slice(1)).toEqual(['pick', 'claude-haiku-5-5', 0, 0, 1, 0, 0, 0, 0, 0]);
  });

  it('never throws into the request', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fakeEnv({ fail: true });
    const { c, waited } = fakeCtx(f.env);
    expect(() => recordUsage(c, { route: 'tier2', model: 'claude-sonnet-4-6', usage: usage(1, 1) })).not.toThrow();
    await Promise.all(waited); // rejection is swallowed
    expect(() => recordError({ env: {}, executionCtx: null }, 'tier2', 'x')).not.toThrow();
    expect(() => recordCacheHit({ env: { DB: { prepare() { throw new Error('boom'); } } } }, 'tier2', 'x')).not.toThrow();
    err.mockRestore();
  });
});

describe('secondsUntilUtcMidnight', () => {
  it('counts down to the next UTC midnight', () => {
    expect(secondsUntilUtcMidnight(Date.UTC(2026, 10, 12, 23, 59, 0))).toBe(60);
    expect(secondsUntilUtcMidnight(Date.UTC(2026, 10, 12, 0, 0, 0))).toBe(86400);
    expect(utcDay(Date.UTC(2026, 10, 12, 23, 59, 59))).toBe('2026-11-12');
  });
});
