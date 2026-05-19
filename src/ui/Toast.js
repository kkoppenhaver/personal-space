// Transient banner text + a quick fullscreen flash for atmosphere crossings.

export class Toast {
  constructor() {
    this.el = document.getElementById('toast');
    this.flashEl = document.getElementById('flash');
    this._hideAt = 0;
    this._raf();
  }

  show(text, durationMs = 1500, color = null) {
    if (!this.el) return;
    this.el.textContent = text;
    this.el.style.color = color || '';
    this.el.classList.add('show');
    this._hideAt = performance.now() + durationMs;
  }

  flash() {
    if (!this.flashEl) return;
    this.flashEl.classList.add('show');
    setTimeout(() => this.flashEl.classList.remove('show'), 220);
  }

  _raf() {
    if (this.el && this._hideAt && performance.now() > this._hideAt) {
      this.el.classList.remove('show');
      this._hideAt = 0;
    }
    requestAnimationFrame(() => this._raf());
  }
}
