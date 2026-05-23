// Cookie-backed sessions. The cookie value is `${sessionId}.${hmac}` where
// the HMAC is over the session id with env.SESSION_SECRET. We never store
// anything user-controlled in the cookie value; the session row in D1 is the
// source of truth. The HMAC just makes forged session ids cheap to reject
// without a DB hit.

import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import { b64url, hmac, randomBytes, timingSafeEqual, uuidv7 } from './crypto.js';

export const SESSION_COOKIE = 'ps_session';
export const SESSION_TTL_S = 60 * 60 * 24 * 30; // 30 days

export async function createSession(c, userId) {
  const id = b64url(randomBytes(32));
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_S * 1000;

  await c.env.DB
    .prepare(`INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent)
              VALUES (?1, ?2, ?3, ?4, ?3, ?5)`)
    .bind(id, userId, now, expiresAt, c.req.header('user-agent')?.slice(0, 255) ?? null)
    .run();

  const sig = await hmac(c.env.SESSION_SECRET, id);
  setCookie(c, SESSION_COOKIE, `${id}.${sig}`, {
    httpOnly: true,
    secure: !isLocalRequest(c),
    sameSite: 'Lax',
    path: '/',
    domain: cookieDomain(c),
    maxAge: SESSION_TTL_S,
  });

  return id;
}

export async function resolveSession(c) {
  const raw = getCookie(c, SESSION_COOKIE);
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;
  const id = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = await hmac(c.env.SESSION_SECRET, id);
  if (!timingSafeEqual(sig, expected)) return null;

  const row = await c.env.DB
    .prepare(`SELECT s.id AS session_id, s.expires_at,
                     u.id, u.email, u.anonymous, u.created_at, u.claim_count, u.last_position
              FROM sessions s JOIN users u ON u.id = s.user_id
              WHERE s.id = ?1`)
    .bind(id)
    .first();
  if (!row) return null;
  if (row.expires_at < Date.now()) return null;

  // Touch last_seen on a best-effort basis (every request). Cheap on D1.
  c.executionCtx.waitUntil(c.env.DB
    .prepare(`UPDATE sessions SET last_seen_at = ?1 WHERE id = ?2`)
    .bind(Date.now(), id).run().catch(() => {}));

  let lastPosition = null;
  if (row.last_position) {
    try { lastPosition = JSON.parse(row.last_position); } catch {}
  }

  return {
    sessionId: row.session_id,
    user: {
      id: row.id,
      email: row.email,
      anonymous: row.anonymous === 1,
      created_at: row.created_at,
      claim_count: row.claim_count ?? 0,
      last_position: lastPosition,
    },
  };
}

export async function destroySession(c, sessionId) {
  await c.env.DB.prepare(`DELETE FROM sessions WHERE id = ?1`).bind(sessionId).run();
  deleteCookie(c, SESSION_COOKIE, { path: '/', domain: cookieDomain(c) });
}

export async function createAnonymousUser(c) {
  const id = uuidv7();
  const now = Date.now();
  await c.env.DB
    .prepare(`INSERT INTO users (id, anonymous, created_at, last_seen_at)
              VALUES (?1, 1, ?2, ?2)`)
    .bind(id, now)
    .run();
  return { id, email: null, anonymous: true, created_at: now, claim_count: 0 };
}

// In local dev the request is HTTP (Vite proxy → wrangler dev), so Secure
// cookies would never be sent. Detect and relax.
function isLocalRequest(c) {
  try {
    const u = new URL(c.req.url);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function cookieDomain(c) {
  // Local dev: don't set a Domain — leave it scoped to the dev host.
  if (isLocalRequest(c)) return undefined;
  return c.env.SESSION_COOKIE_DOMAIN || undefined;
}
