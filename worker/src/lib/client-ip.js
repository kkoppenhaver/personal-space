// Best-effort client IP for rate-limit keys. In production Cloudflare always
// sets cf-connecting-ip; the fallbacks only matter in local dev.

export function clientIp(c) {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? '0.0.0.0';
}
