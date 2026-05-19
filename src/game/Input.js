// Keyboard input. Edge-triggered events (flick, reset, logbook) vs held axes (pitch, bank, brake).

export class Input {
  constructor() {
    this.pitch = 0;      // -1 .. 1 (down .. up)
    this.bank = 0;       // -1 .. 1 (left .. right)
    this.flickEdge = false;
    this.brake = false;
    this.throttle = false;   // hold W — extra speed, especially useful in space
    this.resetEdge = false;
    this.logbookEdge = false;
    this._flickHeld = false;
    this._resetHeld = false;
    this._logbookHeld = false;

    window.addEventListener('keydown', (e) => this._onKey(e, true));
    window.addEventListener('keyup', (e) => this._onKey(e, false));
    window.addEventListener('blur', () => this._reset());
  }

  // Call exactly once per fixed step BEFORE reading the edges.
  drain() {
    const ev = {
      pitch: this.pitch,
      bank: this.bank,
      brake: this.brake,
      throttle: this.throttle,
      flickEdge: this.flickEdge,
      resetEdge: this.resetEdge,
      logbookEdge: this.logbookEdge,
    };
    this.flickEdge = false;
    this.resetEdge = false;
    this.logbookEdge = false;
    return ev;
  }

  _reset() {
    this.pitch = 0;
    this.bank = 0;
    this.brake = false;
    this.throttle = false;
    this._flickHeld = false;
    this._resetHeld = false;
    this._logbookHeld = false;
  }

  _onKey(e, down) {
    switch (e.code) {
      // Flight-sim convention: arrow up = nose down (push the stick), arrow down = nose up (pull back).
      case 'ArrowUp':    this.pitch = down ? -1 : (this.pitch === -1 ? 0 : this.pitch); break;
      case 'ArrowDown':  this.pitch = down ? 1 : (this.pitch === 1 ? 0 : this.pitch); break;
      // ArrowLeft banks LEFT (turn left), ArrowRight banks RIGHT (turn right).
      case 'ArrowLeft':  this.bank = down ? 1 : (this.bank === 1 ? 0 : this.bank); break;
      case 'ArrowRight': this.bank = down ? -1 : (this.bank === -1 ? 0 : this.bank); break;
      case 'Space':
        // Held = throttle (extra speed); tap edge also triggers takeoff when
        // grounded. The two interpretations don't conflict — in flight, the
        // edge is harmless and only `throttle` matters.
        e.preventDefault();
        if (down && !this._flickHeld) this.flickEdge = true;
        this._flickHeld = down;
        this.throttle = down;
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        this.brake = down;
        break;
      case 'KeyR':
        if (down && !this._resetHeld) this.resetEdge = true;
        this._resetHeld = down;
        break;
      case 'KeyL':
        if (down && !this._logbookHeld) this.logbookEdge = true;
        this._logbookHeld = down;
        break;
      default: break;
    }
  }
}
