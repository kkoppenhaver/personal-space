import * as THREE from 'three';

// Screen-edge navigation indicators. For each tracked target (a planet, a
// system, etc.), shows either an on-screen marker (label + distance) or an
// edge arrow pointing toward off-screen targets.
//
// Usage:
//   const nav = new PlanetNav(canvas);
//   nav.track('home', { object: planet.group, label: 'AHEAD', getDistance: () => ... });
//   nav.update(camera, plane);

const NDC = new THREE.Vector3();
const POS = new THREE.Vector3();

export class PlanetNav {
  constructor(canvas) {
    this.canvas = canvas;
    this.targets = new Map(); // id → { object, label, color, getDistance }
    this.container = document.createElement('div');
    this.container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:5;';
    document.body.appendChild(this.container);
    this.markers = new Map(); // id → DOM element
  }

  track(id, { object, label = '', color = '#ff6f3c', getDistance = null, visible = null }) {
    this.targets.set(id, { object, label, color, getDistance, visible });
    const el = document.createElement('div');
    el.className = 'planet-nav-marker';
    el.style.cssText = `
      position:absolute;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      color: ${color};
      text-shadow: 0 0 8px rgba(0,0,0,0.65);
      letter-spacing: 0.1em;
      transform: translate(-50%, -50%);
      white-space: nowrap;
      transition: opacity 0.2s;
    `;
    el.innerHTML = `
      <div class="ring" style="
        width: 18px; height: 18px; border: 1.5px solid ${color};
        border-radius: 50%; box-sizing: border-box; margin: 0 auto 4px;"></div>
      <div class="label" style="font-weight: bold; text-align: center;">${escapeHTML(label)}</div>
      <div class="dist" style="opacity:0.7; text-align:center;"></div>
    `;
    this.container.appendChild(el);
    this.markers.set(id, el);
  }

  untrack(id) {
    const el = this.markers.get(id);
    if (el) el.remove();
    this.markers.delete(id);
    this.targets.delete(id);
  }

  setLabel(id, label) {
    const el = this.markers.get(id);
    const t = this.targets.get(id);
    if (!el || !t) return;
    t.label = label;
    const lbl = el.querySelector('.label');
    if (lbl) lbl.textContent = label;
  }

  update(camera, plane) {
    const w = this.canvas.clientWidth || innerWidth;
    const h = this.canvas.clientHeight || innerHeight;

    for (const [id, target] of this.targets) {
      const el = this.markers.get(id);
      if (!el) continue;
      // Per-target visibility gate (e.g. only show pad indicator in atmosphere).
      if (target.visible && !target.visible()) { el.style.display = 'none'; continue; }
      el.style.display = '';
      target.object.getWorldPosition(POS);

      // Project to NDC
      NDC.copy(POS).project(camera);
      // z > 1 means behind camera in NDC (after homogeneous divide); also check raw direction
      const cameraToTarget = POS.clone().sub(camera.position);
      const camFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      const behind = cameraToTarget.dot(camFwd) < 0;

      // Pixel coords (top-left origin)
      let px = (NDC.x * 0.5 + 0.5) * w;
      let py = (-NDC.y * 0.5 + 0.5) * h;
      const onScreen = !behind && NDC.x >= -1 && NDC.x <= 1 && NDC.y >= -1 && NDC.y <= 1;

      const dist = target.getDistance ? target.getDistance() : cameraToTarget.length();
      const distEl = el.querySelector('.dist');
      if (distEl) distEl.textContent = formatDist(dist);

      if (onScreen) {
        // Clamp slightly so the ring stays on canvas
        px = Math.max(20, Math.min(w - 20, px));
        py = Math.max(28, Math.min(h - 36, py));
        el.style.left = `${px}px`;
        el.style.top = `${py}px`;
        el.style.opacity = '0.85';
      } else {
        // Clamp to nearest edge with safe inset; the arrow ring sits there.
        // Map (NDC.x, NDC.y) onto a rectangle of inset 36 px from each edge.
        const inset = 36;
        const cx = w / 2, cy = h / 2;
        // If behind camera, invert NDC X/Y so it points toward target's hemisphere.
        let dx, dy;
        if (behind) {
          dx = -NDC.x;
          dy = NDC.y;
        } else {
          dx = NDC.x;
          dy = -NDC.y;
        }
        // Scale (dx, dy) to fit the rectangle.
        const halfW = w / 2 - inset;
        const halfH = h / 2 - inset;
        const sx = Math.abs(dx) > 1e-3 ? halfW / Math.abs(dx) : Infinity;
        const sy = Math.abs(dy) > 1e-3 ? halfH / Math.abs(dy) : Infinity;
        const s = Math.min(sx, sy);
        px = cx + dx * s;
        py = cy + dy * s;
        el.style.left = `${px}px`;
        el.style.top = `${py}px`;
        el.style.opacity = '0.65';
      }
    }
  }
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function formatDist(d) {
  if (d > 1000) return `${(d / 1000).toFixed(1)} km`;
  return `${Math.round(d)} m`;
}
