// Browser glue for the quality tiers (Quality.js holds the logic).
//
// The choice comes from, in order: `?quality=auto|high|medium|low` (this
// session only), the pause menu (saved in localStorage), else auto.
// `onTier(tier, settings)` runs at start and whenever the tier changes.

import { TIER_SETTINGS, QUALITY_STORAGE_KEY, parseQuality, initialAuto, stepAuto, resolveTier } from './Quality.js';

function readStored() {
  try { return parseQuality(localStorage.getItem(QUALITY_STORAGE_KEY)); } catch { return null; }
}

/**
 * @param {object} p
 * @param {(tier: string, settings: object) => void} p.onTier
 * @param {() => boolean} [p.isPaused]
 */
export function createQualityControl({ onTier, isPaused = () => false }) {
  const urlChoice = parseQuality(new URLSearchParams(location.search).get('quality'));
  let choice = urlChoice || readStored() || 'auto';
  let auto = initialAuto(performance.now());
  let tier = null;
  let last = performance.now();
  let skipNext = true;
  let wasPaused = false;
  const listeners = new Set();

  const apply = () => {
    const next = resolveTier(choice, auto.tier);
    if (next === tier) return;
    tier = next;
    onTier(tier, TIER_SETTINGS[tier]);
    for (const fn of listeners) fn(api.state);
  };

  // A frame that straddles a hidden tab or a pause is not a measurement.
  document.addEventListener('visibilitychange', () => { skipNext = true; });

  const api = {
    get tier() { return tier; },
    get settings() { return TIER_SETTINGS[tier]; },
    get state() {
      return { choice, tier, auto: auto.tier, settled: choice !== 'auto' || auto.done };
    },

    /** Call once per drawn frame. */
    frame() {
      const now = performance.now();
      const dt = now - last;
      last = now;
      const paused = isPaused();
      const skip = skipNext || paused !== wasPaused;
      skipNext = false;
      wasPaused = paused;
      if (choice !== 'auto' || auto.done) return;
      const visible = document.visibilityState !== 'hidden' && !skip;
      auto = stepAuto(auto, dt, now, { visible, paused });
      apply();
    },

    /** Pick a tier or 'auto'; saved for next time. */
    set(next) {
      const c = parseQuality(next);
      if (!c) return api.state;
      choice = c;
      try { localStorage.setItem(QUALITY_STORAGE_KEY, c); } catch { /* private mode */ }
      if (c === 'auto') { auto = initialAuto(performance.now()); skipNext = true; }
      apply();
      for (const fn of listeners) fn(api.state);
      return api.state;
    },

    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    start() { apply(); },
  };
  return api;
}
