import { describe, it, expect } from 'vitest';
import { findMarkup, checkConcept, checkTier2, checkTier3 } from '../../worker/src/lib/llm-output.js';

const GOOD_CONCEPT = {
  name: 'Ilmora',
  teaser: 'a quilt of small islands, each one with a single lit window',
  premise: 'A green archipelago where every island keeps one lamp burning in the afternoon.',
  question: 'who are they expecting?',
  biome: 'forest',
  terrain: { sea_level: 0.62, amplitude: 0.8, shape: 'archipelago', pattern: 'patchwork' },
  landmark_slots: 2,
  hero_on_water: false,
  creature_budget: 0.35,
  density: 'sparse',
  motif: { kind: 'none', subjects: 'surface' },
  embed_bias: 0,
  asset_keywords: ['cottage', 'lamp post', 'sheep'],
};

// The malformed call Haiku 5.5 actually returned in the Phase 0 spot check:
// `premise` swallowed the next parameter's markup and `question` is missing.
const LEAKED_CONCEPT = (() => {
  const { question, ...rest } = GOOD_CONCEPT;
  return { ...rest, premise: `${GOOD_CONCEPT.premise}</premise>\n<parameter name="question">${question}` };
})();

describe('findMarkup', () => {
  it('finds tag-shaped text anywhere in a nested value', () => {
    expect(findMarkup(LEAKED_CONCEPT)).toBe('premise');
    expect(findMarkup({ a: [{ b: 'fine' }, { b: 'x <parameter name="q"> y' }] })).toBe('a[1].b');
    expect(findMarkup('closing </invoke> tag')).toBe('(root)');
  });

  it('leaves ordinary prose alone', () => {
    for (const s of ['I <3 this place', 'if a < b and c > d', 'wind speed > 40', 'the door — I didn\'t knock.', '5 < 6']) {
      expect(findMarkup(s)).toBeNull();
    }
    expect(findMarkup(GOOD_CONCEPT)).toBeNull();
  });
});

describe('checkConcept', () => {
  it('passes a well-formed concept through unchanged', () => {
    const r = checkConcept(GOOD_CONCEPT);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual(GOOD_CONCEPT);
  });

  it('rejects the real malformed call (markup + missing question)', () => {
    const r = checkConcept(LEAKED_CONCEPT);
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/markup in premise/);
  });

  it('rejects each missing or wrong-typed required field', () => {
    for (const key of ['name', 'teaser', 'premise', 'question', 'biome', 'density', 'hero_on_water', 'landmark_slots', 'creature_budget', 'terrain', 'motif', 'asset_keywords']) {
      const { [key]: _drop, ...rest } = GOOD_CONCEPT;
      expect(checkConcept(rest).ok, key).toBe(false);
    }
    expect(checkConcept({ ...GOOD_CONCEPT, biome: 'swamp' }).ok).toBe(false);
    expect(checkConcept({ ...GOOD_CONCEPT, motif: { kind: 'spiral', subjects: 'surface' } }).ok).toBe(false);
    expect(checkConcept({ ...GOOD_CONCEPT, asset_keywords: [] }).ok).toBe(false);
    expect(checkConcept({ ...GOOD_CONCEPT, name: 'x'.repeat(41) }).ok).toBe(false);
    expect(checkConcept(null).ok).toBe(false);
    expect(checkConcept('nope').ok).toBe(false);
  });

  it('clamps numbers, snaps creature_budget, and drops unknown landform echoes', () => {
    const r = checkConcept({
      ...GOOD_CONCEPT,
      terrain: { sea_level: 1.4, amplitude: 0.1, shape: 'volcano', pattern: 'plaid' },
      landmark_slots: 9,
      creature_budget: 0.3,
      embed_bias: 0.9,
      asset_keywords: ['  cottage  ', 7, '', 'sheep'],
    });
    expect(r.ok).toBe(true);
    expect(r.value.terrain).toEqual({ sea_level: 0.95, amplitude: 0.4 });
    expect(r.value.landmark_slots).toBe(4);
    expect(r.value.creature_budget).toBe(0.35);
    expect(r.value.embed_bias).toBe(0.45);
    expect(r.value.asset_keywords).toEqual(['cottage', 'sheep']);
  });

  it('tolerates a long teaser (the 80-char limit is a prompt rule, not a reason to pay twice)', () => {
    expect(checkConcept({ ...GOOD_CONCEPT, teaser: 't'.repeat(120) }).ok).toBe(true);
    expect(checkConcept({ ...GOOD_CONCEPT, teaser: 't'.repeat(201) }).ok).toBe(false);
  });

  it('is idempotent', () => {
    const once = checkConcept(GOOD_CONCEPT).value;
    expect(checkConcept(once).value).toEqual(once);
  });
});

const GOOD_TIER2 = {
  name: 'Ilmora',
  biome: 'forest',
  palette: { water: '#224466', low: '#335522', mid: '#557733', high: '#998866', snow: '#ffffff', sky: '#aaccff' },
  atmosphere: 'Still air and lamp oil.',
  landmarks: [{ slotId: 0, kind: 'peak', name: 'Lamp Hill' }, { slotId: 1, kind: 'coast', name: 'The Porch' }],
  theme: 'inhabited silence',
  density: 'sparse',
  hero_landmark_hints: ['a small cottage with one lit window'],
  surface_feature_hints: ['vegetable rows', 'lamp posts'],
  landmark_anchor_hints: ['a jetty'],
  thumbnail_framing_hint: 'low, toward the lit window',
};

describe('checkTier2', () => {
  it('passes a well-formed description through unchanged', () => {
    const r = checkTier2(GOOD_TIER2);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual(GOOD_TIER2);
  });

  it('rejects markup, a missing palette colour, and an empty landmark list', () => {
    expect(checkTier2({ ...GOOD_TIER2, atmosphere: 'calm</atmosphere><parameter name="x">' }).ok).toBe(false);
    const { sky, ...palette } = GOOD_TIER2.palette;
    expect(checkTier2({ ...GOOD_TIER2, palette }).ok).toBe(false);
    expect(checkTier2({ ...GOOD_TIER2, landmarks: [] }).ok).toBe(false);
    expect(checkTier2({ ...GOOD_TIER2, biome: 'swamp' }).ok).toBe(false);
  });

  it('skips one odd landmark instead of failing, and drops malformed optional fields', () => {
    const r = checkTier2({
      ...GOOD_TIER2,
      landmarks: [{ slotId: '2', kind: 'spire', name: 'Tall One' }, { slotId: 'x', name: 'Bad' }, { kind: 'peak' }],
      density: 'packed',
      inhabitant_hints: 'sheep',
    });
    expect(r.ok).toBe(true);
    expect(r.value.landmarks).toEqual([{ slotId: 2, kind: 'spire', name: 'Tall One' }]);
    expect('density' in r.value).toBe(false);
    expect('inhabitant_hints' in r.value).toBe(false);
  });
});

describe('checkTier3', () => {
  const GOOD = { surfaceLore: 'Kettles. All of them cold. I didn\'t knock.', landmarkLore: [{ slotId: 0, blurb: 'A hill.' }] };

  it('passes well-formed lore through unchanged', () => {
    expect(checkTier3(GOOD)).toEqual({ ok: true, value: GOOD });
  });

  it('rejects markup and missing lore; skips a malformed blurb', () => {
    expect(checkTier3({ ...GOOD, surfaceLore: 'x</surfaceLore>\n<parameter name="landmarkLore">[]' }).ok).toBe(false);
    expect(checkTier3({ landmarkLore: [] }).ok).toBe(false);
    expect(checkTier3({ surfaceLore: 'fine' }).ok).toBe(false);
    const r = checkTier3({ surfaceLore: 'fine', landmarkLore: [{ slotId: 1, blurb: 'ok' }, { blurb: 'no slot' }] });
    expect(r.value.landmarkLore).toEqual([{ slotId: 1, blurb: 'ok' }]);
  });
});
