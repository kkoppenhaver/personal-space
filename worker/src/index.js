// Personal Space Worker — entry point.
// Hosts the LLM proxy (/tier1/2/3) and the accounts + cloud-logbook API
// (/api/*). See docs/plans/2026-05-20-001-feat-logbook-cloud-memoir-plan.md.

import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { llm } from './routes/llm.js';
import { auth } from './routes/auth.js';
import { logbook } from './routes/logbook.js';
import { account } from './routes/account.js';

const app = new Hono();

app.use('*', async (c, next) => {
  const allowed = (c.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return cors({
    origin: (origin) => (allowed.includes(origin) ? origin : null),
    credentials: true,
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['content-type'],
    maxAge: 600,
  })(c, next);
});

// LLM proxy mounted at root for backward compatibility (/tier1, /tier2, /tier3).
app.route('/', llm);

// Accounts + logbook API under /api/*.
app.route('/api/auth', auth);
app.route('/api/logbook', logbook);
app.route('/api/account', account);

app.notFound((c) => c.json({ error: 'not_found' }, 404));
app.onError((err, c) => {
  console.error('Unhandled:', err);
  return c.json({ error: 'internal' }, 500);
});

// scheduled handler — Worker cron triggers from wrangler.toml [triggers].
async function scheduled(event, env, ctx) {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  try {
    const res = await env.DB
      .prepare(`DELETE FROM users WHERE anonymous = 1 AND claim_count = 0 AND created_at < ?1`)
      .bind(cutoff).run();
    console.log(`anon_gc deleted=${res.meta?.changes ?? 0} cutoff=${new Date(cutoff).toISOString()}`);
  } catch (e) {
    console.error('anon_gc failed:', e);
  }
  // Also purge stale expired sessions so the table doesn't grow unbounded.
  try {
    await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?1`).bind(Date.now()).run();
  } catch {}
}

export default {
  fetch: app.fetch.bind(app),
  scheduled,
};
