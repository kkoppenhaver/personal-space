// Thin fetch wrapper for our cookie-authed API. Always sends credentials so
// the session cookie flows; raises a typed error on non-2xx so callers can
// pattern-match. Times out at 3s by default; callers can override.

// In dev (localhost / 127.0.0.1) we leave this empty so Vite's proxy can
// forward /api and /tier* to wrangler dev on the same origin. In prod the
// game runs on personalspace.fun but the Worker is on api.personalspace.fun,
// so we have to send the cross-origin request explicitly. Override at build
// time via VITE_API_BASE if you need to point at a different worker.
export const API_BASE = (() => {
  if (import.meta.env?.VITE_API_BASE) return import.meta.env.VITE_API_BASE.replace(/\/$/, '');
  if (typeof location === 'undefined') return '';
  const h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '') return '';
  return 'https://api.personalspace.fun';
})();

const DEFAULT_TIMEOUT_MS = 3000;

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export async function api(method, path, { body, timeoutMs = DEFAULT_TIMEOUT_MS, raw, contentType, keepalive } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const init = {
      method,
      credentials: 'include',
      signal: ctl.signal,
      headers: {},
    };
    if (keepalive) init.keepalive = true;
    if (body !== undefined) {
      if (raw) {
        init.body = body;
        if (contentType) init.headers['content-type'] = contentType;
      } else {
        init.body = JSON.stringify(body);
        init.headers['content-type'] = 'application/json';
      }
    }
    const url = /^https?:/i.test(path) ? path : `${API_BASE}${path}`;
    const res = await fetch(url, init);
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    const data = isJson ? await res.json().catch(() => null) : null;
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  } finally {
    clearTimeout(t);
  }
}

export const apiGet = (p, o) => api('GET', p, o);
export const apiPost = (p, body, o) => api('POST', p, { body, ...o });
export const apiPatch = (p, body, o) => api('PATCH', p, { body, ...o });
export const apiPut = (p, body, o) => api('PUT', p, { body, ...o });
export const apiDelete = (p, o) => api('DELETE', p, o);
