// Account-scoped endpoints: data export (GDPR-style) + account deletion.

import { Hono } from 'hono';
import { requireSession } from '../lib/auth-mw.js';
import { destroySession } from '../lib/session.js';

export const account = new Hono();

account.use('*', requireSession);

account.get('/export', async (c) => {
  const user = c.get('user');

  const userRow = await c.env.DB
    .prepare(`SELECT id, email, anonymous, created_at, last_seen_at, claim_count
              FROM users WHERE id = ?1`)
    .bind(user.id).first();

  const entries = await c.env.DB
    .prepare(`SELECT * FROM entries WHERE user_id = ?1 ORDER BY claimed_at`)
    .bind(user.id).all();

  const passkeys = await c.env.DB
    .prepare(`SELECT id, transports, device_type, backed_up, created_at, last_used_at
              FROM passkeys WHERE user_id = ?1`)
    .bind(user.id).all();

  const payload = {
    exported_at: new Date().toISOString(),
    user: {
      ...userRow,
      anonymous: userRow.anonymous === 1,
    },
    entries: entries.results ?? [],
    passkeys: (passkeys.results ?? []).map((p) => ({
      ...p,
      transports: p.transports ? JSON.parse(p.transports) : null,
      backed_up: p.backed_up === 1,
    })),
  };

  c.header('content-disposition', `attachment; filename="personalspace-${user.id}.json"`);
  return c.json(payload);
});

// Persist player's last-known galaxy-space position so they can resume where
// they left off. Body: { pos: [x,y,z], fwd: [x,y,z] }. Server stamps ts.
// Reasonable client cadence: throttled to ≥10s + on cell change + on unload.
account.post('/position', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => null);
  if (!body || !isVec3(body.pos) || !isVec3(body.fwd)) {
    return c.json({ error: 'invalid' }, 400);
  }
  const blob = JSON.stringify({ pos: body.pos, fwd: body.fwd, ts: Date.now() });
  await c.env.DB
    .prepare(`UPDATE users SET last_position = ?1 WHERE id = ?2`)
    .bind(blob, user.id).run();
  return c.json({ ok: true });
});

function isVec3(v) {
  return Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n));
}

account.post('/delete', async (c) => {
  const user = c.get('user');
  const sessionId = c.get('sessionId');

  // Collect R2 keys before the CASCADE drops the rows so we can clean up.
  const thumbs = await c.env.DB
    .prepare(`SELECT thumbnail_key FROM entries WHERE user_id = ?1 AND thumbnail_key IS NOT NULL`)
    .bind(user.id).all();

  // Drop the user — CASCADE clears sessions, passkeys, entries.
  await c.env.DB.prepare(`DELETE FROM users WHERE id = ?1`).bind(user.id).run();

  // Best-effort R2 cleanup.
  c.executionCtx.waitUntil(Promise.all(
    (thumbs.results ?? []).map((r) => c.env.THUMBS.delete(r.thumbnail_key).catch(() => {})),
  ));

  await destroySession(c, sessionId).catch(() => {});

  return c.json({ ok: true });
});
