// DOM-overlay HUD. All values formatted in plain text.

export class HUD {
  constructor() {
    this.speed = document.getElementById('stat-speed');
    this.alt   = document.getElementById('stat-alt');
    this.atm   = document.getElementById('stat-atm');
    this.state = document.getElementById('stat-state');
    this.pings = document.getElementById('pings');
    this.landmark = document.getElementById('landmark');
    this._landmarkHideAt = 0;
    this._landmarkTimer();
    this._planetName = null;
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
      div.innerHTML = `<span class="name">${escapeHTML(it.name)}</span>${escapeHTML(it.teaser || '')}`;
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
