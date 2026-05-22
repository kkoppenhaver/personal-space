// Thin fetch wrapper for our cookie-authed API. Always sends credentials so
// the session cookie flows; raises a typed error on non-2xx so callers can
// pattern-match. Times out at 3s by default; callers can override.

const DEFAULT_TIMEOUT_MS = 3000;

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export async function api(method, path, { body, timeoutMs = DEFAULT_TIMEOUT_MS, raw, contentType } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const init = {
      method,
      credentials: 'include',
      signal: ctl.signal,
      headers: {},
    };
    if (body !== undefined) {
      if (raw) {
        init.body = body;
        if (contentType) init.headers['content-type'] = contentType;
      } else {
        init.body = JSON.stringify(body);
        init.headers['content-type'] = 'application/json';
      }
    }
    const res = await fetch(path, init);
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
