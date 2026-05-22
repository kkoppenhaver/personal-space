import * as THREE from 'three';

// On-screen telemetry panel. Mounts in the bottom-left, monospace, fixed-width
// columns so it's easy to read frame-by-frame in a screen recording.
//
// Each frame, update() recomputes derived values (radial vs tangent velocity
// split, tilt-off-level, roll-off-upright, which corrections are firing) and
// rewrites the panel HTML.

const RAD = 180 / Math.PI;

export class DebugHUD {
  constructor() {
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
`STATE   ${plane.state.padEnd(10)} rho=${rho.toFixed(2)} atm=${atm.toFixed(2)}
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
