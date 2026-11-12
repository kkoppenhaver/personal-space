// Response hygiene for the LLM proxy: a tool call is checked before it is
// cached or returned. Pure functions, no Hono import.
//
// Why: a forced tool call can come back malformed. Seen on Haiku 5.5 in the
// Phase 0 spot check (1 in 15): the model closed a string with the wrong tag,
// so `premise` swallowed the next parameter
//   "…told yet.</premise>\n<parameter name=\"question\">what are they…"
// and `question` never arrived. Cached, that planet is broken for 30 days.
//
// Each checker returns { ok: true, value } with a normalized copy (numbers
// clamped, unknown optional values dropped) or { ok: false, problem }. The
// route retries once on a problem and never caches a failure.

import { TERRAIN_SHAPES, GROUND_PATTERNS } from '../../../shared/planet-dice.js';
import { BIOMES, DENSITIES, MOTIF_KINDS, MOTIF_SUBJECTS } from './llm-context.js';

// Tag-shaped text inside a string value: "</premise>", "<parameter name=…>".
// Prose from these prompts never contains tags; "<3" or "a < b" do not match.
const MARKUP_RE = /<\/?[A-Za-z_][\w:.-]*(\s[^<>]{0,120})?\/?>/;

/** Path of the first string that contains tag-like markup, or null. */
export function findMarkup(value, path = '') {
  if (typeof value === 'string') return MARKUP_RE.test(value) ? (path || '(root)') : null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findMarkup(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const hit = findMarkup(v, path ? `${path}.${k}` : k);
      if (hit) return hit;
    }
  }
  return null;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const bad = (problem) => ({ ok: false, problem });

function textList(v, maxItems, maxLen) {
  if (!Array.isArray(v)) return null;
  return v.filter((x) => typeof x === 'string').map((x) => x.trim()).filter((x) => x && x.length <= maxLen).slice(0, maxItems);
}

// creature_budget is one of three levels; snap whatever number came back.
const CREATURE_LEVELS = [0, 0.35, 1];
const snapCreature = (v) => CREATURE_LEVELS.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));

/** /concept output (tool `world_concept`). */
export function checkConcept(out) {
  if (!isObj(out)) return bad('not an object');
  const leak = findMarkup(out);
  if (leak) return bad(`markup in ${leak}`);
  if (!isText(out.name, 40)) return bad('name');
  if (!isText(out.teaser, 200)) return bad('teaser');
  if (!isText(out.premise, 900)) return bad('premise');
  if (!isText(out.question, 300)) return bad('question');
  if (!BIOMES.includes(out.biome)) return bad('biome');
  if (!DENSITIES.includes(out.density)) return bad('density');
  if (typeof out.hero_on_water !== 'boolean') return bad('hero_on_water');
  if (!isNum(out.landmark_slots)) return bad('landmark_slots');
  if (!isNum(out.creature_budget)) return bad('creature_budget');
  if (!isObj(out.terrain) || !isNum(out.terrain.sea_level) || !isNum(out.terrain.amplitude)) return bad('terrain');
  if (!isObj(out.motif) || !MOTIF_KINDS.includes(out.motif.kind) || !MOTIF_SUBJECTS.includes(out.motif.subjects)) return bad('motif');
  const keywords = textList(out.asset_keywords, 8, 80);
  if (!keywords || keywords.length === 0) return bad('asset_keywords');

  const terrain = {
    sea_level: clamp(out.terrain.sea_level, 0, 0.95),
    amplitude: clamp(out.terrain.amplitude, 0.4, 1.4),
  };
  // Echoes of the dealt landform/pattern; the client falls back to the
  // dealt values when they are absent, so drop anything unrecognised.
  if (TERRAIN_SHAPES.includes(out.terrain.shape)) terrain.shape = out.terrain.shape;
  if (GROUND_PATTERNS.includes(out.terrain.pattern)) terrain.pattern = out.terrain.pattern;

  const value = {
    name: out.name.trim(),
    teaser: out.teaser.trim(),
    premise: out.premise.trim(),
    question: out.question.trim(),
    biome: out.biome,
    terrain,
    landmark_slots: clamp(Math.round(out.landmark_slots), 0, 4),
    hero_on_water: out.hero_on_water,
    creature_budget: snapCreature(out.creature_budget),
    density: out.density,
    motif: { kind: out.motif.kind, subjects: out.motif.subjects },
    asset_keywords: keywords,
  };
  if (isNum(out.embed_bias)) value.embed_bias = clamp(out.embed_bias, 0, 0.45);
  return { ok: true, value };
}

const PALETTE_KEYS = ['water', 'low', 'mid', 'high', 'snow', 'sky'];

// slotId as a non-negative integer (tolerates "3"), or null.
function slotIdOf(item) {
  if (!isObj(item)) return null;
  const n = typeof item.slotId === 'string' && item.slotId.trim() !== '' ? Number(item.slotId) : item.slotId;
  return Number.isInteger(n) && n >= 0 && n <= 63 ? n : null;
}
const HINT_LISTS = ['hero_landmark_hints', 'surface_feature_hints', 'landmark_anchor_hints', 'inhabitant_hints'];

/** /tier2/direct output (tool `world_describe`). */
export function checkTier2(out) {
  if (!isObj(out)) return bad('not an object');
  const leak = findMarkup(out);
  if (leak) return bad(`markup in ${leak}`);
  if (!isText(out.name, 60)) return bad('name');
  if (!BIOMES.includes(out.biome)) return bad('biome');
  if (!isText(out.atmosphere, 600)) return bad('atmosphere');
  if (!isObj(out.palette) || !PALETTE_KEYS.every((k) => isText(out.palette[k], 30))) return bad('palette');
  if (!Array.isArray(out.landmarks) || out.landmarks.length === 0) return bad('landmarks');
  // Per-item leniency: one odd landmark is skipped, not a reason to throw
  // away (and pay again for) the whole response.
  const landmarks = [];
  for (const lm of out.landmarks.slice(0, 12)) {
    const slotId = slotIdOf(lm);
    if (slotId === null || !isText(lm.name, 80)) continue;
    landmarks.push({ slotId, kind: isText(lm.kind, 20) ? lm.kind : 'peak', name: lm.name.trim() });
  }
  if (landmarks.length === 0) return bad('landmarks[]');

  const value = {
    name: out.name.trim(),
    biome: out.biome,
    palette: Object.fromEntries(PALETTE_KEYS.map((k) => [k, out.palette[k].trim()])),
    atmosphere: out.atmosphere.trim(),
    landmarks,
  };
  // Optional creative-direction fields: keep what is well-formed.
  if (isText(out.theme, 200)) value.theme = out.theme.trim();
  if (DENSITIES.includes(out.density)) value.density = out.density;
  for (const k of HINT_LISTS) {
    const list = textList(out[k], 8, 200);
    if (list && list.length) value[k] = list;
  }
  if (isText(out.thumbnail_framing_hint, 200)) value.thumbnail_framing_hint = out.thumbnail_framing_hint.trim();
  return { ok: true, value };
}

/** /tier3 output (tool `world_lore`). */
export function checkTier3(out) {
  if (!isObj(out)) return bad('not an object');
  const leak = findMarkup(out);
  if (leak) return bad(`markup in ${leak}`);
  if (!isText(out.surfaceLore, 4000)) return bad('surfaceLore');
  if (!Array.isArray(out.landmarkLore)) return bad('landmarkLore');
  const landmarkLore = [];
  for (const l of out.landmarkLore.slice(0, 12)) {
    const slotId = slotIdOf(l);
    if (slotId === null || !isText(l.blurb, 1200)) continue;   // skip the odd one
    landmarkLore.push({ slotId, blurb: l.blurb.trim() });
  }
  return { ok: true, value: { surfaceLore: out.surfaceLore.trim(), landmarkLore } };
}
