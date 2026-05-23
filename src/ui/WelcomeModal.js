// First-run welcome modal. Shown once per browser (localStorage gate) on
// the first session that boots all the way through. Three purposes:
//   1. Onboard the brand — your galaxy is yours, fly low to claim, planets
//      you don't claim are gone for good.
//   2. Warmup window — background-load the MiniLM embedding model (~22 MB,
//      first visit only; cached after) plus catalog embeddings and decoder
//      WASM in parallel. The START PLAYING button stays disabled until
//      warmup resolves; a thin amber bar fills under the third beat as
//      progress arrives. No MB count, no percentage — ambient progress.
//   3. Headroom for Tier 1 / Tier 2 LLM pings so HUD chips already show
//      real planet names by the time the player drops into the cockpit.

const STORAGE_KEY = 'personalspace:welcome-seen:v1';

export class WelcomeModal {
  /**
   * @param {{ onDismiss?: () => void,
   *           warmupPromise?: Promise<unknown> | null }} opts
   *   warmupPromise: optional Promise that gates the START PLAYING button.
   *   While unresolved, the button is disabled and the warmup bar is
   *   visible. On resolve OR reject the button enables — degraded-mode
   *   retrieval has its own fallback, so we don't want to block forever
   *   on a flaky network.
   */
  constructor({ onDismiss = () => {}, warmupPromise = null } = {}) {
    this.onDismiss = onDismiss;
    this.modal = document.getElementById('welcome-modal');
    this.isOpen = false;
    if (!this.modal) return;
    this.btn = this.modal.querySelector('[data-act="start"]');
    this.bar = this.modal.querySelector('.warmup-bar');
    this.fill = this.modal.querySelector('.warmup-fill');
    if (this.btn) this.btn.addEventListener('click', () => this.close());

    if (warmupPromise) {
      this._setReady(false);
      const enable = () => this._setReady(true);
      warmupPromise.then(enable, enable);
    } else {
      this._setReady(true);
    }
  }

  /**
   * 0..1 fraction; called by the warmup orchestrator as MiniLM downloads.
   * Updates the progress bar width. No numeric label — ambient progress.
   */
  setProgress(frac) {
    if (!this.fill) return;
    const pct = Math.max(0, Math.min(1, frac)) * 100;
    this.fill.style.width = pct.toFixed(1) + '%';
  }

  _setReady(ready) {
    if (!this.btn) return;
    this.btn.disabled = !ready;
    this.btn.classList.toggle('pending', !ready);
    if (this.bar) this.bar.classList.toggle('show', !ready);
    if (ready && this.fill) this.fill.style.width = '100%';
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
