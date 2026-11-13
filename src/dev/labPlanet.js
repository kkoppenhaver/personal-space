// Build one bench planet at the origin through the real construction path
// (Planet constructor → applyConcept → applyVisuals with forced catalog
// records). Shared by the placement lab and the look lab so both benches
// mount exactly what the game mounts.
//
// `q` holds the placement lab's query keys (documented in PlacementLab.js):
//   seed biome density shape pattern tier
//   sea amp slots motif subjects embed heroWater creatures_budget   forced concept
//   hero landmarks surface creatures                                catalog ids

import * as THREE from 'three';
import { Planet } from '../world/Planet.js';
import { getAssetById } from '../world/assets/Catalog.js';
import { load as loadGLB } from '../world/AssetCache.js';
import { normalizeShape, normalizePattern } from '../../shared/planet-dice.js';

export const LAB_RADIUS = 60;

/**
 * @param {URLSearchParams|Record<string, any>} q
 * @param {object} ctx
 * @param {object} ctx.rapier   the initialised RAPIER module
 * @param {object} ctx.world    a RAPIER.World
 * @param {THREE.WebGLRenderer} ctx.renderer
 * @param {Record<string, string>} [ctx.defaults] catalog ids used when `q` names none
 * @param {boolean} [ctx.serial] parse every GLB one at a time, in a fixed
 *   order, before mounting — makes renders repeatable (see below)
 * @param {string} [ctx.tag] console prefix
 * @returns {Promise<{ planet: Planet, info: object }>}
 */
export async function buildLabPlanet(q, { rapier, world, renderer, defaults = {}, serial = false, tag = 'lab' }) {
  const params = q instanceof URLSearchParams
    ? q
    : new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]));

  const seed = (parseInt(params.get('seed') || '42', 10) || 42) >>> 0;
  const biome = params.get('biome') || 'forest';
  const density = params.get('density') || 'medium';

  const planet = new Planet({
    rapier, world, seed, radius: LAB_RADIUS, center: new THREE.Vector3(),
    shape: normalizeShape(params.get('shape')),
    pattern: normalizePattern(params.get('pattern')),
  });

  // Forced concept (Phase 14b): sea/amp/slots/motif/subjects/embed/tier
  // params build a synthetic concept so the reference planets are
  // reproducible without a worker. e.g.
  //   ?placementLab=1&sea=0&amp=0.8&slots=3&motif=shared-heading&subjects=landmarks&embed=0.4&tier=singular
  if (['sea', 'amp', 'slots', 'motif', 'embed'].some((k) => params.has(k))) {
    if (params.has('tier')) planet.tier = params.get('tier');
    planet.applyConcept({
      teaser: 'forced lab concept',
      premise: 'forced lab concept',
      question: 'is the placement right?',
      biome,
      terrain: {
        sea_level: parseFloat(params.get('sea') ?? '0.42'),
        amplitude: parseFloat(params.get('amp') ?? '1.0'),
      },
      landmark_slots: parseInt(params.get('slots') ?? '4', 10),
      hero_on_water: params.has('heroWater'),
      creature_budget: parseFloat(params.get('creatures_budget') ?? '0.35'),
      density,
      motif: { kind: params.get('motif') ?? 'none', subjects: params.get('subjects') ?? 'surface' },
      ...(params.has('embed') ? { embed_bias: parseFloat(params.get('embed')) } : {}),
      asset_keywords: [],
    });
  }

  const ids = (key) => (params.get(key) ?? defaults[key] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const heroAsset = getAssetById(params.get('hero') || defaults.hero);
  const landmarkAssets = ids('landmarks').map(getAssetById);
  const surfaceAssets = ids('surface').map(getAssetById);
  const creatureAssets = ids('creatures').map(getAssetById).filter(Boolean);
  for (const [k, v] of [['hero', heroAsset], ['landmarks', landmarkAssets], ['surface', surfaceAssets]]) {
    const missing = (Array.isArray(v) ? v : [v]).filter((x) => !x).length;
    if (missing) console.warn(`[${tag}] ${missing} unknown ${k} id(s) — check the catalog`);
  }

  if (serial) {
    // Parse every GLB serially in a fixed order first. applyVisuals loads in
    // parallel, so geometry/material ids otherwise follow network completion
    // order — and three's render sort uses material.id, which flips depth
    // ties at intersections (a few dozen pixels differ run to run).
    for (const a of [heroAsset, ...landmarkAssets, ...surfaceAssets, ...creatureAssets]) {
      if (a?.url) await loadGLB(a.url, renderer).catch(() => {});
    }
  }

  await planet.applyVisuals({
    palette: planet.palette,
    biome,
    heroAsset,
    landmarkAssets: landmarkAssets.filter(Boolean),
    surfaceAssets: surfaceAssets.filter(Boolean),
    creatureAssets,
    density,
    renderer,
  });
  // No atmosphere on a bench — snap the reveal solid.
  planet.forceRevealComplete();

  const info = {
    seed, biome, density,
    hero: heroAsset?.id,
    landmarks: landmarkAssets.filter(Boolean).map((a) => a.id),
    surface: surfaceAssets.filter(Boolean).map((a) => a.id),
    slots: planet.landmarks.map((s) => `${s.slotId}:${s.kind}`),
  };
  return { planet, info };
}
