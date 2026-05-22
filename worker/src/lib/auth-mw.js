// Hono middleware that requires a valid session. Attaches `c.set('user', ...)`
// and `c.set('sessionId', ...)` on success.

import { resolveSession } from './session.js';

export async function requireSession(c, next) {
  const s = await resolveSession(c);
  if (!s) return c.json({ error: 'unauthenticated' }, 401);
  c.set('user', s.user);
  c.set('sessionId', s.sessionId);
  await next();
}
