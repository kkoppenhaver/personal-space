import * as THREE from 'three';

// On-screen telemetry panel. Mounts in the bottom-left, monospace, fixed-width
// columns so it's easy to read frame-by-frame in a screen recording.
//
// Each frame, update() recomputes derived values (radial vs tangent velocity
// split, tilt-off-level, roll-off-upright, which corrections are firing) and
// rewrites the panel HTML.
//
// The RENDER row reports `renderer.info`. Note it is read *before* this frame's
// draw call, so the counts are one frame stale — invisible in practice, and it
// avoids forcing a second read pass after render. `renderer.info.render` is
// auto-reset per frame; `.programs` / `.memory` are cumulative live counts.
//
// Frame timing MUST come from `tickFrame`, driven by GameLoop's `onRender`.
// `update()` runs on `onFixedStep`, which the accumulator calls 0..8 times per
// rAF to catch up (GameLoop.js:40-44) — so timing deltas measured there are
// pinned to the 60Hz step cadence and read ~16.67ms no matter how slow the
// renderer actually is. That is exactly backwards from what we need.

const RAD = 180 / Math.PI;

// Frame-time smoothing. Raw per-frame deltas jitter too much to read off a
// screen recording, so we show an exponential moving average — plus a 1s
// rolling max, because the EMA hides precisely the hitches that matter
// (system spawn, collider swap, shader compile).
const FRAME_EMA_ALPHA = 0.1;
const WORST_WINDOW_MS = 1000;

export class DebugHUD {
  constructor() {
    this._frameMsEma = 0;
    this._worstMs = 0;
    this._worstResetAt = 0;
    this._renderInfo = null;
    this.el = document.createElement('div');
    this.el.id = 'debug-hud';
    this.el.style.cssText = `
      position: fixed;
      left: 14px;
      top: 60px;
      padding: 8px 10px;
      background: rgba(20,16,12,0.75);
      color: #d6cda8;
      border: 1px solid rgba(244,237,224,0.18);
      border-radius: 6px;
      font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
      pointer-events: none;
      z-index: 10;
      white-space: pre;
      letter-spacing: 0;
      min-width: 280px;
      backdrop-filter: blur(4px);
    `;
    this.el.style.display = 'none';
    this.visible = false;
    document.body.appendChild(this.el);
  }

  toggle() {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? '' : 'none';
  }

  /**
   * Sample real frame cost. Call from GameLoop's `onRender`, which fires exactly
   * once per rAF — see the note at the top of this file for why measuring on the
   * fixed step gives a meaningless flat 60Hz instead.
   *
   * @param {number} elapsedSeconds the rAF delta GameLoop already computed
   * @param {THREE.WebGLRenderer} [renderer]
   */
  tickFrame(elapsedSeconds, renderer) {
    const ms = elapsedSeconds * 1000;
    this._frameMsEma = this._frameMsEma
      ? this._frameMsEma + (ms - this._frameMsEma) * FRAME_EMA_ALPHA
      : ms;

    const now = performance.now();
    if (now - this._worstResetAt > WORST_WINDOW_MS) { this._worstMs = 0; this._worstResetAt = now; }
    if (ms > this._worstMs) this._worstMs = ms;

    // Snapshot rather than hold the renderer: `render.calls`/`.triangles` are
    // auto-reset each frame, and ThumbnailCapture does an extra offscreen
    // render during a claim, which would otherwise show as a doubled count.
    if (renderer?.info) {
      const { render, memory, programs } = renderer.info;
      this._renderInfo = {
        calls: render.calls, triangles: render.triangles,
        programs: programs?.length ?? 0,
        geometries: memory.geometries, textures: memory.textures,
      };
    }
  }

  // Frame cost + renderer.info rows, from whatever `tickFrame` last sampled.
  _renderRows() {
    const ms = this._frameMsEma;
    const fps = ms > 0 ? 1000 / ms : 0;
    let out = `FRAME   ${ms.toFixed(1)}ms ${fps.toFixed(0)}fps  worst1s=${this._worstMs.toFixed(1)}ms\n`;
    const i = this._renderInfo;
    if (!i) return out;
    const trisStr = i.triangles >= 1e6 ? `${(i.triangles / 1e6).toFixed(2)}M`
                  : i.triangles >= 1e3 ? `${(i.triangles / 1e3).toFixed(1)}k`
                  : String(i.triangles);
    return out
      + `RENDER  calls=${i.calls}  tris=${trisStr}\n`
      + `MEM     prog=${i.programs}  geom=${i.geometries}  tex=${i.textures}\n`;
  }

  update(plane, planet, atmosphere, input, flight) {
    if (!this.visible) return;
    const pos = plane.position();
    const v = plane.velocity();
    const fwd = plane.forward();
    const up = plane.up();
    const right = plane.right();
    const av = plane.body.angvel();

    const rel = pos.clone().sub(planet.center);
    const r = rel.length();
    const radialUp = rel.clone().divideScalar(r || 1);

    // Velocity decomposition
    const vRadial = v.dot(radialUp);                                   // + = climbing
    const vTangent = v.clone().sub(radialUp.clone().multiplyScalar(vRadial));
    const vTanMag = vTangent.length();

    const rho = atmosphere.density(pos);
    const atm = Math.min(1, Math.max(0, rho));

    // Attitude angles (degrees)
    // Pitch off level: angle between fwd and its horizontal projection.
    const dotFwdUp = fwd.dot(radialUp);
    const pitchOffLevel = Math.asin(Math.max(-1, Math.min(1, dotFwdUp))) * RAD;
    // Roll off upright: angle between planeUp and radialUp.
    const dotUpUp = up.dot(radialUp);
    const rollOffUpright = Math.acos(Math.max(-1, Math.min(1, dotUpUp))) * RAD;

    // Smoothed input
    const sp = flight.smoothedPitch ?? 0;
    const sb = flight.smoothedBank ?? 0;
    const pitchEff = Math.abs(sp) < 0.01 ? 0 : sp;
    const bankEff = Math.abs(sb) < 0.01 ? 0 : sb;

    // Which corrections are firing
    const orbital = pitchEff === 0 && atm > 0.001;
    const autoLevel = pitchEff === 0 && atm > 0.001;
    const autoRoll = bankEff === 0 && atm > 0.001;
    const altLock = pitchEff === 0 && rho > 0.001;

    const f3 = (n) => (n >= 0 ? ' ' : '') + n.toFixed(3);
    const f2 = (n) => (n >= 0 ? ' ' : '') + n.toFixed(2);
    const f1 = (n) => (n >= 0 ? ' ' : '') + n.toFixed(1);
    const flag = (b) => b ? 'YES' : 'no ';

    this.el.textContent =
`${this._renderRows()}STATE   ${plane.state.padEnd(10)} rho=${rho.toFixed(2)} atm=${atm.toFixed(2)}
POS     ${f1(pos.x)} ${f1(pos.y)} ${f1(pos.z)}   r=${r.toFixed(1)}
VEL     ${f2(v.x)} ${f2(v.y)} ${f2(v.z)}   |v|=${v.length().toFixed(2)}
        radial=${f2(vRadial)}  tangent=${vTanMag.toFixed(2)}
FWD     ${f3(fwd.x)} ${f3(fwd.y)} ${f3(fwd.z)}
UP      ${f3(up.x)} ${f3(up.y)} ${f3(up.z)}
RIGHT   ${f3(right.x)} ${f3(right.y)} ${f3(right.z)}
ANGVEL  ${f2(av.x)} ${f2(av.y)} ${f2(av.z)}   |ω|=${Math.hypot(av.x,av.y,av.z).toFixed(2)}
TILT    pitch=${f1(pitchOffLevel)}°  roll=${f1(rollOffUpright)}°
INPUT   p=${f2(input.pitch)}→${f2(sp)}  b=${f2(input.bank)}→${f2(sb)}  brake=${flag(input.brake)}  thr=${flag(input.throttle)}
CORR    orbit=${flag(orbital)}  level=${flag(autoLevel)}  roll=${flag(autoRoll)}  altLock=${flag(altLock)}
THROTTLE boost=${flight.throttleBoost?.toFixed(2) ?? '0.00'}`;
  }
}
