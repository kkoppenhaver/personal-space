// Lightweight read-only catalog accessor. Resolves `id` → asset record so the
// planet-construction code path can look up `url`, `scale_range`, `role`, etc.
// without depending on AssetRetriever (and its heavy minisearch + embedder
// imports). AssetRetriever owns shortlisting; this owns lookup.

import catalog from './catalog.json' with { type: 'json' };

const _byId = new Map((catalog.assets || []).map((a) => [a.id, a]));

/**
 * Look up an asset record by id. Returns `null` if not found — callers
 * should treat that as "fall back to procedural" rather than throwing.
 *
 * @param {string} id
 * @returns {object|null}
 */
export function getAssetById(id) {
  if (!id) return null;
  return _byId.get(id) || null;
}

/**
 * Quick existence check. Cheaper than getAssetById when only "is this id
 * still in the catalog?" matters.
 */
export function hasAsset(id) {
  return _byId.has(id);
}

/**
 * Catalog sanity meta. Useful for boot logs and dev tools.
 */
export function catalogMeta() {
  return {
    version: catalog.version,
    generated_at: catalog.generated_at,
    model: catalog.model,
    dtype: catalog.dtype,
    dim: catalog.dim,
    count: (catalog.assets || []).length,
  };
}
