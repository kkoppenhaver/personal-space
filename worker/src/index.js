// Personal Space Worker — entry point.
// Hosts the LLM proxy (/tier1/2/3) and the accounts + cloud-logbook API
// (/api/*). See docs/plans/2026-05-20-001-feat-logbook-cloud-memoir-plan.md.

import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { llm } from './routes/llm.js';
import { auth } from './routes/auth.js';

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

app.notFound((c) => c.json({ error: 'not_found' }, 404));
app.onError((err, c) => {
  console.error('Unhandled:', err);
  return c.json({ error: 'internal' }, 500);
});

export default app;
