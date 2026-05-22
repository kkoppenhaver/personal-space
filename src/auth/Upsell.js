// Tiny upsell controller: nudge anonymous players to save their logbook
// after the third claim of the session. One nudge ever — 7-day snooze on
// dismissal; never re-prompted once the user signs up.

const SNOOZE_KEY = 'paper-airplane:upsell-snoozed-until';
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
const TRIGGER_AFTER_CLAIMS = 3;

export class Upsell {
  /**
   * @param {{ auth, onOpenAuth: () => void }} opts
   */
  constructor({ auth, onOpenAuth }) {
    this.auth = auth;
    this.onOpenAuth = onOpenAuth;
    this.claimsThisSession = 0;
    this.shown = false;
  }

  /** Called once per claim event from main.js. */
  noteClaim() {
    this.claimsThisSession++;
    if (this.claimsThisSession < TRIGGER_AFTER_CLAIMS) return;
    if (!this.auth.isAnonymous()) return;
    if (this.shown) return;
    if (this._snoozed()) return;
    this.shown = true;
    this._fire();
  }

  _fire() {
    const banner = document.createElement('div');
    banner.id = 'upsell-banner';
    banner.innerHTML = `
      <span>Save your logbook to keep these worlds across devices.</span>
      <button data-act="signup">Sign up</button>
      <button data-act="snooze">Not now</button>
    `;
    banner.addEventListener('click', (e) => {
      const act = e.target?.dataset?.act;
      if (!act) return;
      if (act === 'signup') {
        document.body.removeChild(banner);
        this.onOpenAuth();
      } else if (act === 'snooze') {
        try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS)); } catch {}
        document.body.removeChild(banner);
      }
    });
    document.body.appendChild(banner);
  }

  _snoozed() {
    try {
      const v = parseInt(localStorage.getItem(SNOOZE_KEY) || '0', 10);
      return v > Date.now();
    } catch { return false; }
  }
}
