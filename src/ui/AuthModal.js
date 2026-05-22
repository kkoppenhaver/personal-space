// Auth modal — passkey + email-magic-link tabs. Reuses the pause-menu
// modal styling (#auth-modal in index.html). Opened from:
//   - account drawer "Sign in / Sign up"
//   - the 3rd-claim upsell banner

import { startRegistration, startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { apiPost } from '../net/api.js';

export class AuthModal {
  /**
   * @param {{ auth: import('../auth/AuthClient.js').AuthClient,
   *           onChange?: () => void,
   *           toast?: { show: (msg: string, ms?: number, color?: string) => void } }} opts
   */
  constructor({ auth, onChange = () => {}, toast }) {
    this.auth = auth;
    this.onChange = onChange;
    this.toast = toast;
    this.modal = document.getElementById('auth-modal');
    if (!this.modal) return; // dev safety
    this.passkeySupported = browserSupportsWebAuthn();
    this._wire();
  }

  open(mode = 'auto') {
    if (!this.modal) return;
    this._setMode(mode === 'signin' ? 'signin' : this.passkeySupported ? 'signup' : 'email');
    this._setStatus('');
    this.modal.classList.add('show');
  }

  close() { this.modal?.classList.remove('show'); }

  _wire() {
    this.modal.addEventListener('click', (e) => {
      const act = e.target?.dataset?.act;
      if (act === 'close') return this.close();
      if (act === 'passkey-signup') return this._handlePasskeySignup();
      if (act === 'passkey-signin') return this._handlePasskeySignin();
      if (act === 'email-link') return this._handleEmailLink();
      const tab = e.target?.dataset?.tab;
      if (tab) this._setMode(tab);
    });
    // Hide passkey UI if not supported.
    if (!this.passkeySupported) {
      this.modal.querySelectorAll('[data-tab="signup"], [data-tab="signin"]')
        .forEach((el) => el.style.display = 'none');
    }
  }

  _setMode(mode) {
    this.modal.querySelectorAll('[data-pane]').forEach((el) => {
      el.style.display = (el.dataset.pane === mode) ? '' : 'none';
    });
    this.modal.querySelectorAll('[data-tab]').forEach((el) => {
      el.classList.toggle('active', el.dataset.tab === mode);
    });
  }

  _setStatus(msg, kind = 'info') {
    const s = this.modal.querySelector('#auth-status');
    if (!s) return;
    s.textContent = msg || '';
    s.className = msg ? `status status-${kind}` : 'status';
  }

  async _handlePasskeySignup() {
    try {
      this._setStatus('Creating passkey…');
      const options = await apiPost('/api/auth/passkey/register/options', {});
      const attResp = await startRegistration({ optionsJSON: options });
      await apiPost('/api/auth/passkey/register/verify', attResp);
      this._setStatus('Saved.', 'ok');
      await this.auth.refresh();
      this.onChange();
      this.toast?.show('PASSKEY SAVED', 1800, '#6ed28d');
      setTimeout(() => this.close(), 500);
    } catch (e) {
      this._setStatus(`Couldn't save passkey: ${shortErr(e)}`, 'err');
    }
  }

  async _handlePasskeySignin() {
    try {
      this._setStatus('Looking for your passkey…');
      const { challengeId, options } = await apiPost('/api/auth/passkey/login/options', {});
      const assertion = await startAuthentication({ optionsJSON: options });
      const r = await apiPost('/api/auth/passkey/login/verify', { challengeId, response: assertion });
      this._setStatus('Welcome back.', 'ok');
      await this.auth.refresh();
      this.onChange();
      this.toast?.show(`SIGNED IN${r?.user?.email ? ` · ${r.user.email}` : ''}`, 2000, '#6ed28d');
      setTimeout(() => this.close(), 500);
    } catch (e) {
      this._setStatus(`Sign-in failed: ${shortErr(e)}`, 'err');
    }
  }

  async _handleEmailLink() {
    const input = this.modal.querySelector('#auth-email-input');
    const email = (input?.value || '').trim();
    if (!email) { this._setStatus('Enter your email.', 'err'); return; }
    try {
      this._setStatus('Sending link…');
      await apiPost('/api/auth/email/request', { email });
      this._setStatus('Check your inbox — the link expires in 15 minutes.', 'ok');
    } catch (e) {
      this._setStatus(`Couldn't send: ${shortErr(e)}`, 'err');
    }
  }
}

function shortErr(e) {
  const m = (e?.message || String(e)).split('\n')[0];
  return m.length > 80 ? m.slice(0, 80) + '…' : m;
}
