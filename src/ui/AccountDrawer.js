// Account drawer — shows current sign-in status and offers passkey enroll,
// export, delete, and sign-out. Mirrors the logbook drawer; opens via a
// small button next to the logbook toggle.

export class AccountDrawer {
  /**
   * @param {{ auth, onOpenAuth: () => void, toast?: { show: (msg, ms?, color?) => void } }} opts
   */
  constructor({ auth, onOpenAuth, toast }) {
    this.auth = auth;
    this.onOpenAuth = onOpenAuth;
    this.toast = toast;
    this.panel = document.getElementById('account');
    this.list = document.getElementById('account-body');
    this.btn = document.getElementById('account-toggle');
    if (this.btn) this.btn.addEventListener('click', () => this.toggle());
    if (this.list) this.list.addEventListener('click', (e) => this._onClick(e));
    this.auth.addEventListener('change', () => this.render());
    this.render();
  }

  toggle() { this.panel?.classList.toggle('open'); }

  render() {
    if (!this.list) return;
    const u = this.auth.user;
    if (!u) {
      this.list.innerHTML = `<p class="muted">Loading…</p>`;
      return;
    }
    this.list.innerHTML = u.anonymous ? this._anonymousHTML() : this._knownHTML(u);
    if (this.btn) this.btn.textContent = u.anonymous ? 'ACCOUNT · ANON' : `ACCOUNT · ${shortEmail(u.email)}`;
  }

  _anonymousHTML() {
    return `
      <p class="muted">
        You're playing as a temporary traveler. Worlds you claim stay only
        on this browser unless you sign up.
      </p>
      <button data-act="signup">SIGN UP / SIGN IN</button>
      <p class="muted small">No password. We use passkeys (your device's fingerprint or PIN) or a one-time email link.</p>
      <hr>
      <button data-act="export">DOWNLOAD MY DATA</button>
      <button data-act="forget" class="danger">FORGET THIS BROWSER</button>
    `;
  }

  _knownHTML(u) {
    return `
      <p>Signed in as <b>${esc(u.email || '—')}</b>.</p>
      <button data-act="add-passkey">ADD ANOTHER PASSKEY</button>
      <hr>
      <button data-act="export">DOWNLOAD MY DATA</button>
      <button data-act="signout">SIGN OUT</button>
      <button data-act="delete" class="danger">DELETE ACCOUNT</button>
    `;
  }

  async _onClick(ev) {
    const act = ev.target?.dataset?.act;
    if (!act) return;
    switch (act) {
      case 'signup':
      case 'add-passkey':
        return this.onOpenAuth();
      case 'export':
        return this._download();
      case 'signout': {
        await this.auth.logout();
        this.toast?.show('SIGNED OUT', 1500);
        return;
      }
      case 'forget':
        if (!confirm('Forget this browser? Your local logbook will be cleared. Cloud data (if any) stays.')) return;
        try { localStorage.clear(); } catch {}
        try {
          const dbs = await indexedDB.databases?.();
          for (const db of dbs || []) if (db.name) indexedDB.deleteDatabase(db.name);
        } catch {}
        location.reload();
        return;
      case 'delete':
        if (!confirm('This permanently deletes your account, all logbook entries, and thumbnails. Continue?')) return;
        try {
          const r = await fetch('/api/account/delete', { method: 'POST', credentials: 'include' });
          if (!r.ok) throw new Error('delete failed');
          this.toast?.show('ACCOUNT DELETED', 2000, '#d26e72');
          location.reload();
        } catch (e) {
          this.toast?.show('DELETE FAILED', 1500, '#d26e72');
        }
        return;
    }
  }

  async _download() {
    try {
      const r = await fetch('/api/account/export', { credentials: 'include' });
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `personalspace-${this.auth.user?.id || 'export'}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      this.toast?.show('EXPORT FAILED', 1500, '#d26e72');
    }
  }
}

function shortEmail(s) {
  if (!s) return 'YOU';
  const at = s.indexOf('@');
  return at > 1 ? s.slice(0, Math.min(at, 12)) : s.slice(0, 12);
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
