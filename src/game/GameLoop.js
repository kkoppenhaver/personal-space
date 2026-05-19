// Fixed-timestep accumulator. Render at rAF with no interpolation (good enough at 60Hz).
// Order per fixedStep is owned by the caller's onFixedStep callback.

export class GameLoop {
  constructor({ stepHz = 60, onFixedStep, onRender }) {
    this.dt = 1 / stepHz;
    this.maxFrameSlice = 0.25;
    this.acc = 0;
    this.last = 0;
    this.onFixedStep = onFixedStep;
    this.onRender = onRender;
    this.running = false;
    this.paused = false;
    this._frame = this._frame.bind(this);
  }

  setPaused(paused) {
    this.paused = !!paused;
    // Drop any accumulated unsimulated time so resume doesn't fire a burst
    // of catch-up steps. Render keeps ticking either way.
    this.acc = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this._frame);
  }

  stop() { this.running = false; }

  _frame(now) {
    if (!this.running) return;
    const elapsed = Math.min((now - this.last) / 1000, this.maxFrameSlice);
    this.last = now;
    if (!this.paused) {
      this.acc += elapsed;
      let steps = 0;
      while (this.acc >= this.dt && steps < 8) {
        this.onFixedStep(this.dt);
        this.acc -= this.dt;
        steps++;
      }
    }
    this.onRender(elapsed);
    requestAnimationFrame(this._frame);
  }
}
