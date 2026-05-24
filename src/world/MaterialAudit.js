// Dev-only audit: verify the dual-axis MaterialSet (Phase 10) actually
// caught every visible mesh on a mounted planet. A "leak" is any mesh whose
// material wasn't sourced from the planet's matSet — i.e. a GLB shipped a
// material type the override missed, or an asset slipped through with its
// authored PBR intact when it shouldn't have.
//
// Exposed via __GAME.auditMaterials(). Not a runtime check — purely a tool
// for spotting catalog assets that need a `matSlot` author tag.
//
// Exemptions (NOT leaks):
//   - meshes under a Phase-10 debug-overlay group (__debugPlacement)
//   - meshes with matSlot 'hero' (intentional PBR opt-out)
//   - meshes with matSlot 'terrain' (uses matSet.terrain directly, not cloned)
//   - meshes under a procedural-fallback group (userData.procedural)
//   - Line / Sprite materials (always debug/helper geometry)

const EXEMPT_MATERIAL_TYPES = new Set([
  'LineBasicMaterial', 'LineDashedMaterial', 'SpriteMaterial', 'PointsMaterial',
]);
const EXEMPT_SLOTS = new Set(['hero', 'terrain']);

function hasAncestorMatching(obj, pred) {
  for (let o = obj; o; o = o.parent) {
    if (pred(o)) return true;
  }
  return false;
}

function pathOf(o) {
  const parts = [];
  for (let x = o; x && parts.length < 6; x = x.parent) {
    let label = x.name || x.type;
    if (x.userData?.role) label = `${x.userData.role}[${x.userData.slotId ?? '?'}]`;
    parts.unshift(label);
  }
  return parts.join(' / ');
}

/**
 * Audit a single planet. Returns { planetSeed, ok, leaks } where `leaks` is
 * an array of { path, type, color } describing each non-matSet material.
 *
 * @param {import('./Planet.js').Planet} planet
 */
export function auditPlanet(planet) {
  const leaks = [];
  let ok = 0;
  planet.group?.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    if (hasAncestorMatching(o, (a) => a.name === '__debugPlacement')) return;
    if (hasAncestorMatching(o, (a) => a.userData?.procedural === true)) return;
    if (o.userData?.testAsset) return;                       // __GAME.testAsset mounts
    const slot = o.userData?.matSlot;
    if (EXEMPT_SLOTS.has(slot)) { ok++; return; }
    const mat = o.material;
    if (mat && EXEMPT_MATERIAL_TYPES.has(mat.type)) return;
    if (mat?.userData?.cloned === true) { ok++; return; }
    leaks.push({
      path: pathOf(o),
      type: mat?.type ?? '(none)',
      color: '#' + (mat?.color?.getHex?.() ?? 0).toString(16).padStart(6, '0'),
    });
  });
  return { planetSeed: planet.seed, ok, leaks };
}

/**
 * Audit every planet in `planets`. With `log: true`, prints a per-planet
 * summary to the console. Returns the raw report array.
 *
 * @param {import('./Planet.js').Planet[]} planets
 * @param {{ log?: boolean }} [opts]
 */
export function auditAllPlanets(planets, { log = false } = {}) {
  const reports = planets.map(auditPlanet);
  if (log) {
    let totalLeaks = 0;
    for (const r of reports) {
      totalLeaks += r.leaks.length;
      if (r.leaks.length === 0) {
        console.log(`[auditMaterials] Planet ${r.planetSeed}: ✓ ${r.ok} meshes clean`);
      } else {
        console.warn(`[auditMaterials] Planet ${r.planetSeed}: ✓ ${r.ok} clean, ⚠ ${r.leaks.length} leaks`);
        for (const leak of r.leaks) {
          console.warn(`    - ${leak.path} / ${leak.type} (${leak.color})`);
        }
      }
    }
    console.log(`[auditMaterials] ${reports.length} planets, ${totalLeaks} total leaks`);
  }
  return reports;
}
