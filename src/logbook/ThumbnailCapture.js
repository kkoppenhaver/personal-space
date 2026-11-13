// Capture a planet thumbnail at claim time.
//
// The naive approach (capture in the same tick as the claim toast) gives an
// ugly framing: the plane is mid-ground-roll, the camera is looking sideways,
// and the planet barely fills the frame. Two-tier strategy instead:
//
//   1. Try to wait for a "settle window": plane is grounded AND |velocity|
//      < 1 m/s for 0.5s. Take the shot then — by then the camera has
//      stabilized and the runway frames nicely.
//   2. If the settle window doesn't resolve within 4 seconds (player took
//      off again, crashed, whatever), grab whatever framing we have. Better
//      a so-so thumbnail than no thumbnail.
//
// Capture goes through an offscreen WebGLRenderTarget so the live canvas
// never blinks. We re-render the scene through a dedicated capture camera
// (live camera's world transform, re-aimed at the planet's hero and
// roll-leveled — see _composeShot) at a fixed thumbnail resolution and
// read pixels back into a 2D canvas, which `toBlob('image/jpeg', 0.7)`
// encodes for upload.
//
// Colour (Phase 1b): the shot goes through the same finishing pipeline as
// the screen (Post.js: contact shading, bloom, tone mapping, colour), so
// the keepsake matches what the player saw. It always uses the composer,
// even on the `low` tier, because materials are not tone-mapped when drawn
// into a render target; on `low` the composer runs with nothing but tone
// mapping, which is what the screen shows on that tier. (Phase 11 drew
// straight into an sRGB render target, which was right while the game had
// no tone mapping.) The composer hands back display values, so the 8-bit
// target has no colour space and nothing converts them twice.

import * as THREE from 'three';
import { createPost } from '../render/Post.js';

const THUMB_SIZE = 512;
const JPEG_QUALITY = 0.7;
const SETTLE_SPEED = 1.0;       // m/s
const SETTLE_HOLD_MS = 500;
const SETTLE_TIMEOUT_MS = 4000;

export class ThumbnailCapture {
  /**
   * @param {object} ctx
   * @param {THREE.WebGLRenderer} ctx.renderer
   * @param {THREE.Scene} ctx.scene
   * @param {THREE.Camera} ctx.camera  the live camera
   * @param {object} ctx.look          the game's look (Looks.js)
   * @param {() => object} [ctx.getQuality]  the current tier's settings (Quality.js)
   * @param {(cam: THREE.Camera) => void} [ctx.beforeCapture]  e.g. fit the
   *   sun's shadow box to the capture camera
   */
  constructor({ renderer, scene, camera, look, getQuality = () => null, beforeCapture = null }) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.look = look;
    this.getQuality = getQuality;
    this.beforeCapture = beforeCapture;
    this._post = null;
    this._renderTarget = null;
    this._readbackCanvas = null;
    this._pending = []; // { plane, deadline, settledFor, resolve }
  }

  /**
   * Begin watching the plane for a settle window. Resolves with a Blob (JPEG)
   * or null if the capture fails. Never rejects.
   * (Retained for callers that still want a "settle, then shoot" flow.)
   */
  capture({ plane }) {
    return new Promise((resolve) => {
      this._pending.push({
        plane,
        deadline: performance.now() + SETTLE_TIMEOUT_MS,
        settledSince: 0,
        resolve,
      });
    });
  }

  /**
   * Immediate snapshot. Returns the JPEG blob (or null on failure).
   * Used by the coverage-based claim: the plane is still flying through
   * atmosphere when this fires, so the camera position is authentic —
   * but the *aim* is mid-flight luck. Pass the claimed planet to compose
   * the shot: aim at the hero (the premise's subject) when it's on the
   * player-facing side, and level the horizon either way.
   */
  async snapshotNow({ planet = null } = {}) {
    try {
      return await this._snapshot(planet);
    } catch (e) {
      console.warn('thumbnail snapshotNow failed:', e);
      return null;
    }
  }

  /** Call once per fixed step. Advances pending captures + resolves them. */
  tick() {
    if (this._pending.length === 0) return;
    const now = performance.now();
    const stillPending = [];
    for (const job of this._pending) {
      const plane = job.plane;
      const speed = plane.velocity().length();
      const settled = plane.state === 'grounded' && speed < SETTLE_SPEED;
      if (settled) {
        if (!job.settledSince) job.settledSince = now;
        if (now - job.settledSince >= SETTLE_HOLD_MS) {
          this._shoot(job);
          continue;
        }
      } else {
        job.settledSince = 0;
      }
      if (now >= job.deadline) {
        this._shoot(job); // fallback: take whatever we have
        continue;
      }
      stillPending.push(job);
    }
    this._pending = stillPending;
  }

  async _shoot(job) {
    try {
      const blob = await this._snapshot();
      job.resolve(blob);
    } catch (e) {
      console.warn('thumbnail capture failed:', e);
      job.resolve(null);
    }
  }

  /**
   * Re-aim the capture camera (already carrying the live camera's world
   * transform) for the keepsake shot. The camera never *moves* — the
   * thumbnail stays "what I saw from the cockpit" — it only turns:
   *
   *   - up becomes planet-radial so the horizon is level, never banked;
   *   - if the hero GLB is above the geometric horizon (small slack for
   *     its height — heroes sit on spires/high ground), aim at it: the
   *     hero is the premise's subject and belongs in the artifact;
   *   - otherwise keep the current view direction, just leveled.
   */
  _composeShot(cam, planet) {
    const up = cam.position.clone().sub(planet.center).normalize();
    let target = null;
    const heroPos = planet.heroWorldPosition?.();
    if (heroPos) {
      const d = Math.max(cam.position.distanceTo(planet.center), planet.radius * 1.001);
      const heroDir = heroPos.clone().sub(planet.center).normalize();
      if (heroDir.dot(up) > planet.radius / d - 0.08) target = heroPos;
    }
    if (!target) {
      target = cam.getWorldDirection(new THREE.Vector3()).add(cam.position);
    }
    cam.up.copy(up);
    cam.lookAt(target);
  }

  async _snapshot(planet = null) {
    if (!this._renderTarget) {
      // Display values from the composer, stored as-is (see the header).
      this._renderTarget = new THREE.WebGLRenderTarget(THUMB_SIZE, THUMB_SIZE, {
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        depthBuffer: false,
        colorSpace: THREE.NoColorSpace,
      });
      this._readbackCanvas = document.createElement('canvas');
      this._readbackCanvas.width = THUMB_SIZE;
      this._readbackCanvas.height = THUMB_SIZE;
    }

    // Dedicated capture camera: the live camera is never touched (no
    // aspect juggling, no aim change the player would see). World
    // transform comes from matrixWorld so a rig-parented camera works.
    if (!this._captureCamera) this._captureCamera = this.camera.clone();
    const cam = this._captureCamera;
    cam.fov = this.camera.fov;
    cam.near = this.camera.near;
    cam.far = this.camera.far;
    cam.aspect = 1;
    this.camera.updateMatrixWorld();
    this.camera.matrixWorld.decompose(cam.position, cam.quaternion, cam.scale);
    if (planet) this._composeShot(cam, planet);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    if (!this._post) {
      this._post = createPost(this.renderer, this.scene, cam);
      this._post.setLook(this.look);
      this._post.setSize(THUMB_SIZE, THUMB_SIZE);
    }
    // Same stages as the screen's tier; `low` has no composer on screen,
    // only tone mapping, so the capture drops the rest too.
    const q = this.getQuality() || { composer: true, ao: true, bloom: true, msaa: 4 };
    this._post.setQuality(q.composer
      ? { ao: q.ao, bloom: q.bloom, msaa: q.msaa, page: true }
      : { ao: false, bloom: false, msaa: 4, page: false });
    this.beforeCapture?.(cam);
    this._post.renderToTarget(this._renderTarget);

    // Read pixels out of the GPU.
    const pixels = new Uint8Array(THUMB_SIZE * THUMB_SIZE * 4);
    this.renderer.readRenderTargetPixels(
      this._renderTarget, 0, 0, THUMB_SIZE, THUMB_SIZE, pixels,
    );

    // WebGL is bottom-up; flip into the 2D canvas top-down so the JPEG
    // looks right-side up.
    const ctx = this._readbackCanvas.getContext('2d');
    const img = ctx.createImageData(THUMB_SIZE, THUMB_SIZE);
    const row = THUMB_SIZE * 4;
    for (let y = 0; y < THUMB_SIZE; y++) {
      const srcStart = (THUMB_SIZE - 1 - y) * row;
      img.data.set(pixels.subarray(srcStart, srcStart + row), y * row);
    }
    ctx.putImageData(img, 0, 0);

    return new Promise((resolve) => {
      this._readbackCanvas.toBlob((b) => resolve(b), 'image/jpeg', JPEG_QUALITY);
    });
  }

  dispose() {
    this._post?.dispose();
    this._post = null;
    this._renderTarget?.dispose();
    this._renderTarget = null;
    this._readbackCanvas = null;
    this._captureCamera = null;
  }
}
