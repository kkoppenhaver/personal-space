// Single source of truth for renderer construction and scene lighting.
//
// Why this exists: the game (main.js), the placement lab (dev/PlacementLab.js)
// and the contact sheet (dev/ContactSheet.js) each hand-rolled their own
// renderer + light rig, and they had drifted apart. PlacementLab's comment
// claimed to "match the game's lighting posture" while actually running at 65%
// of the game's total light intensity and omitting the HemisphereLight
// entirely — the game's single largest source. Any lighting or tone-mapping
// judgement made in that bench was being made against the wrong image.
//
// Measured drift at the time of extraction:
//
//            key   fill  hemi  ambient  total
//   game     0.75  0.45  0.95  0.25     2.40
//   lab      0.75  0.45  —     0.35     1.55
//   sheet    1.60  —     1.10  —        2.70   (deliberately a studio rig)
//
// The 'game' preset below reproduces main.js's values exactly, so this
// extraction is a no-op for the game and a correction for the benches.

import * as THREE from 'three';

/**
 * Light presets.
 *
 * `game` — the shipped look. Tuned for "no truly dark side": even when a planet
 * sits between the player and the sun, the surface stays readable. Note this
 * makes non-directional light (hemi + ambient = 1.20) roughly equal to
 * directional (key + fill = 1.20), which is why form reads flat. Rebalancing
 * that is a deliberate later step, not part of this extraction.
 *
 * `studio` — the contact sheet's asset-audit lighting. Brighter and flatter on
 * purpose: the sheet exists to judge an asset's own colour and silhouette, not
 * to reproduce in-world mood. Intentionally NOT the same as `game`.
 */
export const RIG_PRESETS = {
  game: {
    key:    { color: 0xfff2d6, intensity: 0.75, position: [220, 180, 120] },
    fill:   { color: 0xcbd9ff, intensity: 0.45, position: [-220, -120, -150] },
    hemi:   { sky: 0xc4dcff, ground: 0x6b573d, intensity: 0.95 },
    ambient:{ color: 0xffffff, intensity: 0.25 },
  },
  studio: {
    key:    { color: 0xfff2d6, intensity: 1.6, position: [3, 5, 2] },
    fill:   null,
    hemi:   { sky: 0xeef2ff, ground: 0x3a3326, intensity: 1.1 },
    ambient: null,
  },
};

/**
 * Build a WebGLRenderer with the project's standard options.
 *
 * `preserveDrawingBuffer` is deliberately on. ThumbnailCapture renders through
 * an offscreen target and does not need it, but `__GAME.testThumbnail()`'s
 * ground-truth pane reads the live canvas via `canvas.toBlob` — and that bench
 * is how capture-vs-canvas parity gets verified. Removing the flag would delete
 * the only tool that proves the capture path is correct.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{ clearColor?: number, preserveDrawingBuffer?: boolean,
 *           powerPreference?: string, pixelRatioCap?: number }} [opts]
 */
export function createRenderer(canvas, opts = {}) {
  const {
    clearColor = 0x05060a,
    preserveDrawingBuffer = true,
    powerPreference = 'high-performance',
    pixelRatioCap = 2,
  } = opts;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference,
    preserveDrawingBuffer,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, pixelRatioCap));
  renderer.setClearColor(clearColor);
  return renderer;
}

/**
 * Apply output settings (tone mapping, exposure, colour space).
 *
 * Today this is deliberately a no-op that pins the current behaviour —
 * `NoToneMapping` at exposure 1, which is what every existing palette and every
 * LLM-authored colour was tuned against. It exists now so the switch lands in
 * exactly one place, and so the benches pick it up for free rather than drifting
 * again.
 *
 * Reads `?tonemap=` and `?exposure=` for A/B without a rebuild.
 */
export function applyRenderSettings(renderer, opts = {}) {
  const params = typeof location !== 'undefined'
    ? new URLSearchParams(location.search)
    : new URLSearchParams();

  const MODES = {
    none: THREE.NoToneMapping,
    linear: THREE.LinearToneMapping,
    reinhard: THREE.ReinhardToneMapping,
    cineon: THREE.CineonToneMapping,
    aces: THREE.ACESFilmicToneMapping,
    agx: THREE.AgXToneMapping,
    neutral: THREE.NeutralToneMapping,
  };

  const mode = params.get('tonemap') ?? opts.toneMapping ?? 'none';
  renderer.toneMapping = MODES[mode] ?? THREE.NoToneMapping;
  renderer.toneMappingExposure = Number(params.get('exposure') ?? opts.exposure ?? 1);
  // SRGBColorSpace is three's default since r152; set it explicitly so the
  // intent is visible rather than inherited.
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}

/**
 * The scene's light rig. Owns its lights so callers never hold references.
 *
 * `update(ctx)` is currently inert in the 'legacy' posture — the key light
 * keeps main.js's fixed world direction. Sun tracking lands with the tone
 * mapping change, because moving the light and changing output luminance at
 * the same time is the only way to tune either one.
 */
export class LightRig {
  /**
   * @param {THREE.Scene} scene
   * @param {{ preset?: keyof typeof RIG_PRESETS }} [opts]
   */
  constructor(scene, opts = {}) {
    const preset = RIG_PRESETS[opts.preset ?? 'game'] ?? RIG_PRESETS.game;
    this.scene = scene;
    this.preset = preset;
    this.lights = [];

    if (preset.key) {
      this.key = new THREE.DirectionalLight(preset.key.color, preset.key.intensity);
      this.key.position.set(...preset.key.position);
      scene.add(this.key);
      this.lights.push(this.key);
    }
    if (preset.fill) {
      this.fill = new THREE.DirectionalLight(preset.fill.color, preset.fill.intensity);
      this.fill.position.set(...preset.fill.position);
      scene.add(this.fill);
      this.lights.push(this.fill);
    }
    if (preset.hemi) {
      this.hemi = new THREE.HemisphereLight(preset.hemi.sky, preset.hemi.ground, preset.hemi.intensity);
      scene.add(this.hemi);
      this.lights.push(this.hemi);
    }
    if (preset.ambient) {
      this.ambient = new THREE.AmbientLight(preset.ambient.color, preset.ambient.intensity);
      scene.add(this.ambient);
      this.lights.push(this.ambient);
    }
  }

  /**
   * Per-frame update. Takes a plain context rather than a Galaxy/Planet
   * reference so this module never imports world code (and so the benches can
   * drive it with a synthetic context).
   *
   * @param {{ sunPos?: THREE.Vector3, planetCenter?: THREE.Vector3,
   *           sunColor?: THREE.Color, palette?: object }} _ctx
   * @param {number} _dt
   */
  update(_ctx, _dt) {
    // Inert by design — see the class comment. The rig is extracted first so
    // the behaviour change can be reviewed on its own.
  }

  dispose() {
    for (const l of this.lights) {
      this.scene.remove(l);
      l.dispose?.();
    }
    this.lights.length = 0;
  }
}
