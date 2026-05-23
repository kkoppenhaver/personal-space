// DOM-overlay HUD. All values formatted in plain text.

export class HUD {
  constructor() {
    this.speed = document.getElementById('stat-speed');
    this.alt   = document.getElementById('stat-alt');
    this.atm   = document.getElementById('stat-atm');
    this.state = document.getElementById('stat-state');
    this.pings = document.getElementById('pings');
    this.landmark = document.getElementById('landmark');
    this.claimBar = document.getElementById('claim-bar');
    this.claimFill = document.getElementById('claim-bar-fill');
    this.claimLabel = document.getElementById('claim-bar-label');
    this._landmarkHideAt = 0;
    this._landmarkTimer();
    this._planetName = null;
    this._claimVisible = false;
  }

  /**
   * Drive the in-atmosphere claim progress bar.
   * @param {string|null} name Planet name. null hides the bar.
   * @param {number} pct 0..1 fraction of surface surveyed.
   */
  setClaimProgress(name, pct) {
    if (!this.claimBar || !this.claimFill || !this.claimLabel) return;
    const shouldShow = !!name && pct > 0;
    if (shouldShow) {
      this.claimFill.style.width = `${Math.min(100, pct * 100).toFixed(1)}%`;
      this.claimLabel.textContent = `${name.toUpperCase()} · SURVEYING ${Math.round(pct * 100)}%`;
      if (!this._claimVisible) {
        this.claimBar.classList.add('show');
        this._claimVisible = true;
      }
    } else if (this._claimVisible) {
      this.claimBar.classList.remove('show');
      this._claimVisible = false;
    }
  }

  setSpeed(v) { if (this.speed) this.speed.textContent = `${v.toFixed(1)} m/s`; }
  setAltitude(v) { if (this.alt) this.alt.textContent = `${Math.round(v)} m`; }
  setAtmos(rho) { if (this.atm) this.atm.textContent = `ρ ${rho.toFixed(2)}`; }
  setState(s) {
    if (!this.state) return;
    this.state.textContent = (s || '').toUpperCase();
  }

  setPings(items) {
    if (!this.pings) return;
    this.pings.innerHTML = '';
    for (const it of items) {
      const div = document.createElement('div');
      div.className = 'ping';
      const nameHtml = it.name
        ? `<span class="name">${escapeHTML(it.name)}</span>`
        : `<span class="name pending">DISCOVERING…</span>`;
      div.innerHTML = `${nameHtml}${escapeHTML(it.teaser || '')}`;
      this.pings.appendChild(div);
    }
  }

  setPlanetName(name) {
    this._planetName = name;
    // tuck the planet name into the state row as a quick subtitle
    if (this.state) {
      const cur = this.state.textContent;
      const baseState = cur?.split(' · ')[0] || '';
      this.state.textContent = name ? `${baseState} · ${name.toUpperCase()}` : baseState;
    }
  }

  setLandmark(text) {
    if (!this.landmark) return;
    this.landmark.textContent = text;
    this.landmark.classList.add('show');
    this._landmarkHideAt = performance.now() + 5500;
  }

  _landmarkTimer() {
    if (this.landmark && this._landmarkHideAt && performance.now() > this._landmarkHideAt) {
      this.landmark.classList.remove('show');
      this._landmarkHideAt = 0;
    }
    requestAnimationFrame(() => this._landmarkTimer());
  }
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
