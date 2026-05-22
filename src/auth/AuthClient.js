// AuthClient: owns the player's session.
//
// On boot we call /api/me. If we have a session, great. If not, we silently
// create an anonymous user via /api/auth/anonymous. Either way, the page
// loads with a `user` available. The full passkey + email-link UI flows live
// in Phase 5; this class just owns the bootstrap + state.

import { apiGet, apiPost, ApiError } from '../net/api.js';

export class AuthClient extends EventTarget {
  constructor() {
    super();
    this.user = null;
    this.ready = false;
    this.online = true; // assume yes; flip on first failure
  }

  async bootstrap() {
    try {
      const me = await apiGet('/api/auth/me', { timeoutMs: 4000 });
      this.user = me?.user || null;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        this.user = null;
      } else {
        // network down — proceed offline; sync will retry later.
        this.online = false;
        this.ready = true;
        this._emit();
        return;
      }
    }

    if (!this.user) {
      try {
        const r = await apiPost('/api/auth/anonymous', {}, { timeoutMs: 4000 });
        this.user = r?.user || null;
      } catch {
        this.online = false;
      }
    }

    this.ready = true;
    this._emit();
  }

  isSignedIn() { return !!this.user && !this.user.anonymous; }
  isAnonymous() { return !!this.user && this.user.anonymous; }

  async logout() {
    try { await apiPost('/api/auth/logout', {}); } catch {}
    this.user = null;
    this._emit();
    // Mint a fresh anonymous user so the game keeps a session.
    await this.bootstrap();
  }

  async refresh() {
    try {
      const me = await apiGet('/api/auth/me');
      this.user = me?.user || null;
      this.online = true;
      this._emit();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        this.user = null;
        this._emit();
      } else {
        this.online = false;
      }
    }
  }

  _emit() {
    this.dispatchEvent(new Event('change'));
  }
}
