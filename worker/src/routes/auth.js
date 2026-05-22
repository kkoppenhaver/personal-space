// Auth endpoints: anonymous-user creation, passkey registration/login (via
// SimpleWebAuthn), email magic-link issue+verify, /me, logout.

import { Hono } from 'hono';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import {
  createSession,
  destroySession,
  resolveSession,
  createAnonymousUser,
} from '../lib/session.js';
import {
  b64url, b64urlDecode, randomBytes, sha256Hex, uuidv7,
} from '../lib/crypto.js';
import { rateLimit } from '../lib/ratelimit.js';

export const auth = new Hono();

const CHALLENGE_TTL_S = 300;
const EMAIL_TOKEN_TTL_S = 15 * 60;

// ─── Anonymous ─────────────────────────────────────────────────────────────

auth.post('/anonymous', async (c) => {
  const limited = await rateLimit(c.env.AUTH_LIMITER, `anon:${clientIp(c)}`);
  if (!limited.success) return c.json({ error: 'rate_limited' }, 429);

  // If the caller already has a session, return it instead of minting a new one.
  const existing = await resolveSession(c);
  if (existing) return c.json({ user: existing.user });

  const user = await createAnonymousUser(c);
  await createSession(c, user.id);
  return c.json({ user });
});

// ─── /me + logout ─────────────────────────────────────────────────────────

auth.get('/me', async (c) => {
  const s = await resolveSession(c);
  if (!s) return c.json({ user: null }, 401);
  return c.json({ user: s.user });
});

auth.post('/logout', async (c) => {
  const s = await resolveSession(c);
  if (s) await destroySession(c, s.sessionId);
  return c.json({ ok: true });
});

// ─── Passkey registration ────────────────────────────────────────────────

auth.post('/passkey/register/options', async (c) => {
  const s = await resolveSession(c);
  if (!s) return c.json({ error: 'unauthenticated' }, 401);

  const existing = await c.env.DB
    .prepare(`SELECT id, transports FROM passkeys WHERE user_id = ?1`)
    .bind(s.user.id).all();

  // user_id_bytes is what SimpleWebAuthn ties to the credential; reuse the
  // UUID's raw 16 bytes so the same user is always identified.
  const userIDBytes = uuidToBytes(s.user.id);

  const opts = await generateRegistrationOptions({
    rpName: c.env.WEBAUTHN_RP_NAME,
    rpID: c.env.WEBAUTHN_RP_ID,
    userName: s.user.email ?? `traveler-${s.user.id.slice(0, 8)}`,
    userDisplayName: s.user.email ?? 'Anonymous traveler',
    userID: userIDBytes,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
    excludeCredentials: (existing.results || []).map((r) => ({
      id: r.id,
      transports: r.transports ? JSON.parse(r.transports) : undefined,
    })),
  });

  await putChallenge(c, s.sessionId, 'register', opts.challenge);
  return c.json(opts);
});

auth.post('/passkey/register/verify', async (c) => {
  const s = await resolveSession(c);
  if (!s) return c.json({ error: 'unauthenticated' }, 401);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'bad_json' }, 400);

  const expectedChallenge = await takeChallenge(c, s.sessionId, 'register');
  if (!expectedChallenge) return c.json({ error: 'challenge_expired' }, 400);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin: webauthnOrigins(c),
      expectedRPID: c.env.WEBAUTHN_RP_ID,
    });
  } catch (e) {
    return c.json({ error: 'verification_failed', detail: String(e) }, 400);
  }

  if (!verification.verified || !verification.registrationInfo) {
    return c.json({ error: 'not_verified' }, 400);
  }

  const info = verification.registrationInfo;
  const cred = info.credential;
  const now = Date.now();

  await c.env.DB.prepare(`
    INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    ON CONFLICT(id) DO UPDATE SET counter = excluded.counter, last_used_at = excluded.created_at
  `).bind(
    cred.id,
    s.user.id,
    cred.publicKey,
    cred.counter ?? 0,
    cred.transports ? JSON.stringify(cred.transports) : null,
    info.credentialDeviceType ?? null,
    info.credentialBackedUp ? 1 : 0,
    now,
  ).run();

  return c.json({ ok: true });
});

// ─── Passkey login ───────────────────────────────────────────────────────

auth.post('/passkey/login/options', async (c) => {
  const limited = await rateLimit(c.env.AUTH_LIMITER, `pk:${clientIp(c)}`);
  if (!limited.success) return c.json({ error: 'rate_limited' }, 429);

  // Discoverable credentials — empty allowCredentials lets the browser pick.
  const opts = await generateAuthenticationOptions({
    rpID: c.env.WEBAUTHN_RP_ID,
    userVerification: 'preferred',
  });

  // Stash by a transient challenge id so the verify endpoint can find it
  // without requiring a session (passkey login is for signed-out users too).
  const challengeId = b64url(randomBytes(16));
  await c.env.AUTH_CHALLENGES.put(`pk-login:${challengeId}`, opts.challenge, {
    expirationTtl: CHALLENGE_TTL_S,
  });

  return c.json({ challengeId, options: opts });
});

auth.post('/passkey/login/verify', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.challengeId || !body?.response) return c.json({ error: 'bad_json' }, 400);

  const expectedChallenge = await c.env.AUTH_CHALLENGES.get(`pk-login:${body.challengeId}`);
  if (!expectedChallenge) return c.json({ error: 'challenge_expired' }, 400);
  await c.env.AUTH_CHALLENGES.delete(`pk-login:${body.challengeId}`);

  const credentialID = body.response.id;
  const row = await c.env.DB
    .prepare(`SELECT p.id, p.user_id, p.public_key, p.counter, p.transports
              FROM passkeys p WHERE p.id = ?1`)
    .bind(credentialID).first();
  if (!row) return c.json({ error: 'unknown_credential' }, 400);

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge,
      expectedOrigin: webauthnOrigins(c),
      expectedRPID: c.env.WEBAUTHN_RP_ID,
      credential: {
        id: row.id,
        publicKey: bufToUint8(row.public_key),
        counter: row.counter,
        transports: row.transports ? JSON.parse(row.transports) : undefined,
      },
    });
  } catch (e) {
    return c.json({ error: 'verification_failed', detail: String(e) }, 400);
  }

  if (!verification.verified) return c.json({ error: 'not_verified' }, 400);

  await c.env.DB.prepare(
    `UPDATE passkeys SET counter = ?1, last_used_at = ?2 WHERE id = ?3`,
  ).bind(verification.authenticationInfo.newCounter, Date.now(), row.id).run();

  // If the requester already had a session (e.g. an anonymous one) we merge it
  // into the credential's owner. Otherwise we create a fresh session.
  const current = await resolveSession(c);
  if (current && current.user.id !== row.user_id) {
    await mergeUsers(c, current.user.id, row.user_id);
    await destroySession(c, current.sessionId);
  }

  await createSession(c, row.user_id);

  const user = await c.env.DB
    .prepare(`SELECT id, email, anonymous, created_at, claim_count FROM users WHERE id = ?1`)
    .bind(row.user_id).first();

  return c.json({ user: { ...user, anonymous: user.anonymous === 1 } });
});

// ─── Email magic link ────────────────────────────────────────────────────

auth.post('/email/request', async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = String(body?.email ?? '').trim().toLowerCase();
  if (!isValidEmail(email)) return c.json({ error: 'invalid_email' }, 400);

  const ipLimited = await rateLimit(c.env.AUTH_LIMITER, `email-ip:${clientIp(c)}`);
  const emailLimited = await rateLimit(c.env.EMAIL_LIMITER, `email:${email}`);
  if (!ipLimited.success || !emailLimited.success) return c.json({ ok: true }); // act normal

  // Look up or attach to current user (anonymous upgrade) or any existing email user.
  const current = await resolveSession(c);
  const existing = await c.env.DB
    .prepare(`SELECT id, anonymous FROM users WHERE email = ?1`).bind(email).first();
  const userId = existing?.id ?? current?.user.id ?? null;
  const purpose = existing ? 'login' : 'verify';

  const rawToken = b64url(randomBytes(32));
  const tokenHash = await sha256Hex(rawToken);
  const now = Date.now();
  const expiresAt = now + EMAIL_TOKEN_TTL_S * 1000;

  await c.env.DB.prepare(
    `INSERT INTO email_tokens (token_hash, email, user_id, purpose, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(tokenHash, email, userId, purpose, now, expiresAt).run();

  const link = `${c.env.PUBLIC_GAME_URL}/?auth=${encodeURIComponent(rawToken)}`;
  c.executionCtx.waitUntil(sendMagicLink(c, email, link));

  return c.json({ ok: true });
});

auth.get('/email/verify', async (c) => {
  const token = c.req.query('token');
  const result = await consumeEmailToken(c, token);
  if (result.ok) {
    return c.redirect(`${c.env.PUBLIC_GAME_URL}/?signin=ok`, 302);
  }
  return c.redirect(`${c.env.PUBLIC_GAME_URL}/?signin=${result.error}`, 302);
});

// POST variant so the SPA can verify in-page without leaving the canvas.
auth.post('/email/verify', async (c) => {
  const body = await c.req.json().catch(() => null);
  const result = await consumeEmailToken(c, body?.token);
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ user: result.user });
});

async function consumeEmailToken(c, token) {
  if (!token || typeof token !== 'string') return { ok: false, error: 'missing_token' };
  const hash = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    `SELECT token_hash, email, user_id, expires_at, used_at FROM email_tokens WHERE token_hash = ?1`,
  ).bind(hash).first();
  if (!row) return { ok: false, error: 'invalid_token' };
  if (row.used_at) return { ok: false, error: 'token_used' };
  if (row.expires_at < Date.now()) return { ok: false, error: 'token_expired' };

  // Resolve target user: existing row, or upgrade current anonymous, or new.
  let targetUserId = row.user_id;
  const current = await resolveSession(c);

  if (!targetUserId) {
    // Token was issued without an existing user_id. Adopt the current
    // anonymous session if there is one; otherwise mint a new user.
    if (current?.user.anonymous) {
      targetUserId = current.user.id;
      await c.env.DB.prepare(
        `UPDATE users SET email = ?1, anonymous = 0, last_seen_at = ?2 WHERE id = ?3`,
      ).bind(row.email, Date.now(), targetUserId).run();
    } else {
      targetUserId = uuidv7();
      const now = Date.now();
      await c.env.DB.prepare(
        `INSERT INTO users (id, email, anonymous, created_at, last_seen_at) VALUES (?1, ?2, 0, ?3, ?3)`,
      ).bind(targetUserId, row.email, now).run();
    }
  } else {
    await c.env.DB.prepare(
      `UPDATE users SET last_seen_at = ?1, anonymous = 0 WHERE id = ?2`,
    ).bind(Date.now(), targetUserId).run();
  }

  // Cross-device anonymous → known-user merge.
  if (current && current.user.id !== targetUserId && current.user.anonymous) {
    await mergeUsers(c, current.user.id, targetUserId);
    await destroySession(c, current.sessionId);
  }

  await c.env.DB.prepare(`UPDATE email_tokens SET used_at = ?1 WHERE token_hash = ?2`)
    .bind(Date.now(), hash).run();

  await createSession(c, targetUserId);

  const user = await c.env.DB
    .prepare(`SELECT id, email, anonymous, created_at, claim_count FROM users WHERE id = ?1`)
    .bind(targetUserId).first();

  return { ok: true, user: { ...user, anonymous: user.anonymous === 1 } };
}

async function sendMagicLink(c, email, link) {
  if (!c.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set; magic link not sent:', link);
    return;
  }
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${c.env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: c.env.RESEND_FROM,
      to: [email],
      subject: 'Sign in to Personal Space',
      html: `<p>Welcome back, traveler.</p>
             <p><a href="${link}">Tap here to sign in</a>. This link expires in 15 minutes.</p>
             <p style="color:#888;font-size:12px">If you didn't request this, ignore the email.</p>`,
      text: `Sign in to Personal Space: ${link}\n\n(Expires in 15 minutes. Ignore if you didn't request it.)`,
    }),
  }).catch((e) => console.warn('resend send failed', e));
}

// ─── Helpers ─────────────────────────────────────────────────────────────

async function putChallenge(c, sessionId, kind, challenge) {
  await c.env.AUTH_CHALLENGES.put(`${kind}:${sessionId}`, challenge, {
    expirationTtl: CHALLENGE_TTL_S,
  });
}

async function takeChallenge(c, sessionId, kind) {
  const key = `${kind}:${sessionId}`;
  const v = await c.env.AUTH_CHALLENGES.get(key);
  if (v) await c.env.AUTH_CHALLENGES.delete(key);
  return v;
}

async function mergeUsers(c, fromId, toId) {
  // Move entries, dedupe-skip on conflict; transfer passkeys; delete the
  // source user (CASCADE handles sessions/etc).
  await c.env.DB.batch([
    c.env.DB.prepare(`
      INSERT OR IGNORE INTO entries
        (id, user_id, galaxy_seed, cell_x, cell_y, cell_z, planet_index, planet_seed,
         planet_name, biome, palette, landmarks, lore, lore_status, thumbnail_key,
         stat_time_to_land_ms, stat_top_speed, stat_crashes, stat_distance_m,
         legacy, claimed_at, updated_at)
      SELECT id, ?2, galaxy_seed, cell_x, cell_y, cell_z, planet_index, planet_seed,
             planet_name, biome, palette, landmarks, lore, lore_status, thumbnail_key,
             stat_time_to_land_ms, stat_top_speed, stat_crashes, stat_distance_m,
             legacy, claimed_at, updated_at
      FROM entries WHERE user_id = ?1
    `).bind(fromId, toId),
    c.env.DB.prepare(`UPDATE passkeys SET user_id = ?2 WHERE user_id = ?1`).bind(fromId, toId),
    c.env.DB.prepare(`UPDATE users SET claim_count = claim_count +
        (SELECT COALESCE(SUM(1),0) FROM entries WHERE user_id = ?1) WHERE id = ?2`)
      .bind(fromId, toId),
    c.env.DB.prepare(`DELETE FROM users WHERE id = ?1`).bind(fromId),
  ]);
}

function clientIp(c) {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0] ?? '0.0.0.0';
}

function webauthnOrigins(c) {
  return (c.env.WEBAUTHN_ORIGINS || c.env.PUBLIC_GAME_URL || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
}

function uuidToBytes(uuid) {
  const hex = uuid.replaceAll('-', '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bufToUint8(buf) {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  if (Array.isArray(buf)) return new Uint8Array(buf);
  // D1 returns BLOBs as ArrayBuffer in most runtimes.
  return new Uint8Array(buf);
}
