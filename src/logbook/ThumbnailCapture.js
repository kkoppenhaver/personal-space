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
// never blinks. We re-render the scene with the actual game camera at a
// fixed thumbnail resolution and read pixels back into a 2D canvas, which
// `toBlob('image/jpeg', 0.7)` encodes for upload.

import * as THREE from 'three';

const THUMB_SIZE = 512;
const JPEG_QUALITY = 0.7;
const SETTLE_SPEED = 1.0;       // m/s
const SETTLE_HOLD_MS = 500;
const SETTLE_TIMEOUT_MS = 4000;

export class ThumbnailCapture {
  /**
   * @param {{ renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera }} ctx
   */
  constructor({ renderer, scene, camera }) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
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
   * atmosphere when this fires, and the camera framing is already good
   * because the player just spent ~30 seconds looking at the planet.
   */
  async snapshotNow() {
    try {
      return await this._snapshot();
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

  async _snapshot() {
    if (!this._renderTarget) {
      this._renderTarget = new THREE.WebGLRenderTarget(THUMB_SIZE, THUMB_SIZE, {
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        depthBuffer: true,
      });
      this._readbackCanvas = document.createElement('canvas');
      this._readbackCanvas.width = THUMB_SIZE;
      this._readbackCanvas.height = THUMB_SIZE;
    }

    const prevTarget = this.renderer.getRenderTarget();
    const prevAspect = this.camera.aspect;
    this.camera.aspect = 1;
    this.camera.updateProjectionMatrix();

    this.renderer.setRenderTarget(this._renderTarget);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prevTarget);

    this.camera.aspect = prevAspect;
    this.camera.updateProjectionMatrix();

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
    this._renderTarget?.dispose();
    this._renderTarget = null;
    this._readbackCanvas = null;
  }
}
