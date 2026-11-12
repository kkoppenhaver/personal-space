// Gate for every paid (or third-party-metered) route: the LLM proxy and
// /assets/search. Applied per route, never as `llm.use('*')` — the llm
// sub-app is mounted at `/`, so a wildcard would also gate /api/auth/*.
//
//   1. Auth: a valid session cookie, or `x-dev-key` matching the
//      DEV_LLM_KEY secret (only when that secret is set and >= 16 chars).
//   2. Rate limit: per principal (LLM_LIMITER) AND per IP (LLM_IP_LIMITER).
//   3. Body cap: 16 KB.
//
// Sets c.var.principal to `u:<user id>` or `dev`. The daily budget check is
// NOT here: a KV cache hit is free and must always be served, so routes
// check the budget only on a cache miss (see budget.js).

import { resolveSession } from './session.js';
import { rateLimit } from './ratelimit.js';
import { timingSafeEqual } from './crypto.js';
import { clientIp } from './client-ip.js';

export const MAX_BODY_BYTES = 16 * 1024;
const DEV_KEY_MIN_LEN = 16;

export async function llmGuard(c, next) {
  // 1. Who is asking.
  let principal = null;
  const devKey = c.env.DEV_LLM_KEY;
  const sentKey = c.req.header('x-dev-key');
  if (sentKey && typeof devKey === 'string' && devKey.length >= DEV_KEY_MIN_LEN
      && timingSafeEqual(sentKey, devKey)) {
    principal = 'dev';
  } else {
    const s = await resolveSession(c);
    if (s) principal = `u:${s.user.id}`;
  }
  if (!principal) return c.json({ error: 'unauthenticated' }, 401);

  // 2. How often.
  const [byPrincipal, byIp] = await Promise.all([
    rateLimit(c.env.LLM_LIMITER, principal),
    rateLimit(c.env.LLM_IP_LIMITER, `ip:${clientIp(c)}`),
  ]);
  if (!byPrincipal.success || !byIp.success) {
    c.header('retry-after', '60');
    return c.json({ error: 'rate_limited' }, 429);
  }

  // 3. How much. Content-Length first (cheap), then the real byte count —
  // a chunked body has no Content-Length. Hono caches the body, so the
  // route's later c.req.json() still works after this read.
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const declared = Number(c.req.header('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return c.json({ error: 'payload_too_large' }, 413);
    }
    const text = await c.req.text().catch(() => '');
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
      return c.json({ error: 'payload_too_large' }, 413);
    }
  }

  c.set('principal', principal);
  await next();
}
