// Shared family-derivation + scale-override tables used by both the
// initial importer (`tools/import-assets.js`) and the in-place
// augmenter (`tools/augment-catalog.js`).
//
// Families drive the dual-axis color system (see src/world/ColorSystem.js).
// Keep the keys here in sync with FAMILY_BASE there.

export const FAMILY_PATTERNS = [
  // ── Crystal / mineral ──────────────────────────────────────────────
  { pattern: /crystal/i,                                            family: 'crystal' },
  // ── Bone / undead ──────────────────────────────────────────────────
  { pattern: /^bone(s)?(_|$)|skull|grave(stone)?|crypt|tomb/i,      family: 'bone' },
  // ── Sand / desert surface ──────────────────────────────────────────
  { pattern: /^sand|dune|cactus|^crater(large)?$|^meteor/i,         family: 'sand' },
  // ── Flora (broad — trees, plants, bushes, flowers, mushrooms) ──────
  { pattern: /tree|palm|pine|spruce|oak|birch|maple|willow|bush|grass|flower|mushroom|fungal|plant|petals|leaf|vines?/i,
    family: 'flora' },
  { pattern: /^stump_|^log_|^crops?_/i,                             family: 'wood' },
  // ── Rocks / stones ─────────────────────────────────────────────────
  { pattern: /^rock|^stone|cliff|boulder/i,                         family: 'rock' },
  // ── Metal / mechanical ─────────────────────────────────────────────
  { pattern: /antenna|satellite|turret|machine|pipe|cable|monorail|solarpanel|beacon|spacetruck|lander|windturbine|rocket|craft|ship|ufo|hangar|station|^cargo(_|$)|^lights?$|lightpost/i,
    family: 'metal' },
  // ── Houses / habitats ──────────────────────────────────────────────
  { pattern: /^house(_|$)|habitat|dome|shelter/i,                   family: 'structure' },
  // ── Wooden / structural with timber feel ───────────────────────────
  { pattern: /watermill|fence|cart|boat|lighthouse/i,               family: 'wood' },
  // ── Stone landmarks / structures (fall-through for masonry) ────────
  { pattern: /tower|wall|pillar|column|arch|gate|fountain|well|statue|obelisk|monolith|spire|terrain|chimney|spaceship|alien$|structure/i,
    family: 'structure' },
  // ── Lava / molten ──────────────────────────────────────────────────
  { pattern: /lava|magma|toxic|venom|spike/i,                       family: 'rock' },
  // ── Sci-fi / cosmic catch-alls ─────────────────────────────────────
  { pattern: /^planet_|pumpkin|bones?$/i,                           family: 'rock' },
];

export function resolveFamily(name) {
  for (const rule of FAMILY_PATTERNS) {
    if (rule.pattern.test(name)) return rule.family;
  }
  return 'default';
}

// Per-asset scale overrides for hand-tuned outliers. Catalog assets
// generally look right under their kit's scale_range, but a few are
// authored at a wildly different unit scale.
export const SCALE_OVERRIDES = {
  'kenney:fantasy-town:watermill':       [3, 5],
  'quaternius:nature:Tree_Massive_1':    [12, 18],
  'quaternius:nature:Tree_Massive_2':    [12, 18],
  'kenney:space:hangar_large':           [10, 14],
};
