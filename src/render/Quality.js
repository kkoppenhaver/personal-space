// Quality tiers (roadmap Phase 1b). Pure logic, no DOM or renderer:
// unit-tested in tests/unit/quality.test.js. main.js applies the result.
//
//   high    everything: GTAO, bloom, 2048 shadows, 4× MSAA, up to 2× pixels
//   medium  no GTAO, 1024 shadows, 2× MSAA, up to 1.5× pixels
//   low     no composer at all: tone mapping straight on the renderer,
//           no shadows, the canvas's own antialiasing, 1× pixels
//
// The player can pick a tier (pause menu, persisted) or leave it on auto.
// Auto starts at high, waits for the scene to settle, measures frame time,
// and steps down when it is too slow. It never steps back up, and it stops
// deciding once a tier holds, so it cannot oscillate.

export const TIERS = ['high', 'medium', 'low'];

export const TIER_SETTINGS = {
  high:   { composer: true,  ao: true,  bloom: true, shadows: true,  shadowMapSize: 2048, msaa: 4, pixelRatioCap: 2 },
  medium: { composer: true,  ao: false, bloom: true, shadows: true,  shadowMapSize: 1024, msaa: 2, pixelRatioCap: 1.5 },
  low:    { composer: false, ao: false, bloom: false, shadows: false, shadowMapSize: 1024, msaa: 0, pixelRatioCap: 1 },
};

export const QUALITY_STORAGE_KEY = 'personalspace:quality:v1';

export const AUTO = {
  /** Ignore frames for this long after boot or a tier change (shader compiles, asset mounts). */
  settleMs: 2500,
  /** … and at least this many frames. */
  settleFrames: 8,
  /** Frames to measure once settled. */
  sampleFrames: 90,
  /** Median frame time above this is too slow (≈ 36 fps). */
  slowMs: 28,
  /** A run of frames this slow decides at once, without waiting to settle or sample. */
  hopelessMs: 250,
  hopelessRun: 3,
  /** Hopeless frames this slow skip a tier: medium would not save them either. */
  skipMs: 1000,
  /**
   * A gap this long between frames is a stall (a blocking dialog, a laptop
   * waking), not a slow frame. Hidden tabs and pauses are reported by the
   * caller; software rendering can genuinely take seconds a frame.
   */
  gapMs: 30000,
};

/** A stored or URL value → a tier name, 'auto', or null if unknown. */
export function parseQuality(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  return s === 'auto' || TIERS.includes(s) ? s : null;
}

export function lowerTier(tier, steps = 1) {
  const i = TIERS.indexOf(tier);
  return TIERS[Math.min(TIERS.length - 1, Math.max(0, i) + steps)];
}

/** Fresh auto state. */
export function initialAuto(nowMs, tier = 'high') {
  return { tier, since: nowMs, frames: 0, samples: [], run: [], done: tier === 'low' };
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Feed one frame to the auto tier. Returns the next state (the input is
 * not modified); `state.tier` is the tier to use, `state.done` says the
 * decision is final.
 *
 * @param {ReturnType<typeof initialAuto>} state
 * @param {number} frameMs   time since the previous frame
 * @param {number} nowMs
 * @param {{ visible?: boolean, paused?: boolean }} [ctx]
 *   frames while the tab is hidden or the game paused are not measured
 *   (a paused game still draws, but under a menu: not representative)
 */
export function stepAuto(state, frameMs, nowMs, { visible = true, paused = false } = {}) {
  if (state.done) return state;
  // Hidden tab, pause, or a gap that can only be one: start the
  // measurement over rather than read it as a slow frame.
  if (!visible || paused || frameMs >= AUTO.gapMs) {
    return { ...state, since: nowMs, frames: 0, samples: [], run: [] };
  }
  const frames = state.frames + 1;

  // Hopeless: a run of very slow frames (software rendering, a weak GPU on
  // a big screen). Skip the first two frames after a change (one-off
  // compile stalls), then do not wait for the settle window.
  const run = frames > 2 && frameMs >= AUTO.hopelessMs ? [...state.run, frameMs] : [];
  if (run.length >= AUTO.hopelessRun) {
    const steps = median(run) >= AUTO.skipMs ? 2 : 1;
    const tier = lowerTier(state.tier, steps);
    return { ...initialAuto(nowMs, tier) };
  }

  const settled = frames > AUTO.settleFrames && nowMs - state.since >= AUTO.settleMs;
  if (!settled) return { ...state, frames, run };

  const samples = [...state.samples, frameMs];
  if (samples.length < AUTO.sampleFrames) return { ...state, frames, run, samples };

  if (median(samples) > AUTO.slowMs) {
    return initialAuto(nowMs, lowerTier(state.tier));
  }
  return { ...state, frames, run, samples: [], done: true };
}

/**
 * The tier to render with.
 * @param {string|null} choice   'auto' | tier | null (null = auto)
 * @param {string} autoTier      the auto state's tier
 */
export function resolveTier(choice, autoTier) {
  const c = parseQuality(choice);
  return c && c !== 'auto' ? c : autoTier;
}
