// First-run welcome modal. Shown once per browser (localStorage gate) on
// the first session that boots all the way through. Two purposes:
//   1. Onboard the brand — your galaxy is yours, fly low to claim, planets
//      you don't claim are gone for good.
//   2. Buy a few seconds for Tier 1 / Tier 2 LLM pings to resolve so the
//      HUD chips already show real planet names by the time the player
//      drops into the cockpit.

const STORAGE_KEY = 'personalspace:welcome-seen:v1';

export class WelcomeModal {
  constructor({ onDismiss = () => {} } = {}) {
    this.onDismiss = onDismiss;
    this.modal = document.getElementById('welcome-modal');
    this.isOpen = false;
    if (!this.modal) return;
    const btn = this.modal.querySelector('[data-act="start"]');
    if (btn) btn.addEventListener('click', () => this.close());
  }

  // True if the modal should be shown for this browser. Honors a
  // `?welcome=1` URL override so we can preview copy without clearing
  // localStorage.
  shouldShow() {
    if (!this.modal) return false;
    try {
      const url = new URL(location.href);
      if (url.searchParams.get('welcome') === '1') return true;
      return !localStorage.getItem(STORAGE_KEY);
    } catch { return false; }
  }

  open() {
    if (!this.modal) return;
    this.modal.classList.add('show');
    this.isOpen = true;
  }

  close() {
    if (!this.modal) return;
    this.modal.classList.remove('show');
    this.isOpen = false;
    try { localStorage.setItem(STORAGE_KEY, String(Date.now())); } catch {}
    this.onDismiss();
  }
}
