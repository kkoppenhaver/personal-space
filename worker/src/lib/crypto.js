// Small crypto helpers shared by auth + session code.
// All hashing/HMAC uses Web Crypto (available in Workers + browsers).

const enc = new TextEncoder();

export function randomBytes(n) {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

export function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const s = atob(str.replaceAll('-', '+').replaceAll('_', '/') + pad);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// UUIDv7 — time-ordered, sortable, 122 bits of entropy after the timestamp.
// https://datatracker.ietf.org/doc/rfc9562/
export function uuidv7() {
  const ts = BigInt(Date.now());
  const rand = randomBytes(10);
  const bytes = new Uint8Array(16);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = (0x70 | (rand[0] & 0x0f));         // version 7
  bytes[7] = rand[1];
  bytes[8] = (0x80 | (rand[2] & 0x3f));         // variant 10
  bytes[9] = rand[3];
  for (let i = 4; i < 10; i++) bytes[10 + (i - 4)] = rand[i];
  const h = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function sha256(input) {
  const buf = typeof input === 'string' ? enc.encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return new Uint8Array(digest);
}

export async function sha256Hex(input) {
  return [...(await sha256(input))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// HMAC-SHA256 returning base64url.
export async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return b64url(new Uint8Array(sig));
}

// Constant-time string compare (length-tolerant via early bail OK here —
// callers only compare same-length b64url HMACs).
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
