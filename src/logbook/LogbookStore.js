// LogbookStore: the local source of truth for logbook entries.
//
// Lives in IndexedDB. Identity dedupe is by the planet identity tuple
// (galaxy_seed, cell_x, cell_y, cell_z, planet_index). Two tabs claiming
// the same planet always converge on a single row.
//
// Sync state per entry:
//   'new'     — never sent
//   'syncing' — in flight to server (transient; reset on load in case of crash)
//   'synced'  — server has it
//   'failed'  — last attempt errored; will retry on next tick
//
// Thumbnail bytes (Blob) live on the entry too, separate from sync state, so
// we can upload independently of the main row.

import { idb } from './idb.js';

const SENTINEL = -2147483648;

export class LogbookStore extends EventTarget {
  /**
   * @param {{ id, galaxy_seed, cell_x, cell_y, cell_z, planet_index,
   *          planet_seed, planet_name, biome?, palette?, landmarks?,
   *          lore?, lore_status?, claimed_at, stats?, thumbnailBlob? }} input
   */
  async add(input) {
    const identityKey = makeIdentityKey(input);
    const existing = await idb.getByIdentity(identityKey);
    if (existing) {
      // Dedupe: merge any newly available fields (e.g. lore filled in by a
      // later attempt) but keep the canonical id + sync state.
      const merged = mergeForDedupe(existing, input);
      if (changed(existing, merged)) {
        merged.updated_at = Date.now();
        if (existing.sync_state === 'synced') merged.sync_state = 'new';
        await idb.put(merged);
        this._emit();
      }
      return merged;
    }
    const now = Date.now();
    const entry = {
      id: input.id,
      identityKey,
      galaxy_seed: input.galaxy_seed,
      cell_x: input.cell_x, cell_y: input.cell_y, cell_z: input.cell_z,
      planet_index: input.planet_index,
      planet_seed: input.planet_seed,
      planet_name: input.planet_name,
      biome: input.biome ?? null,
      palette: input.palette ?? null,
      landmarks: input.landmarks ?? null,
      lore: input.lore ?? null,
      lore_status: input.lore_status ?? (input.lore ? 'ready' : 'pending'),
      thumbnail_url: null,
      thumbnailBlob: input.thumbnailBlob ?? null,
      thumbnail_sync_state: input.thumbnailBlob ? 'new' : null,
      stats: input.stats ?? null,
      legacy: input.legacy === true,
      claimed_at: input.claimed_at,
      updated_at: now,
      sync_state: 'new',
      retry_count: 0,
      next_retry_at: 0,
      remote_id: null,
    };
    await idb.put(entry);
    this._emit();
    return entry;
  }

  async update(id, patch) {
    const e = await idb.get(id);
    if (!e) return null;
    const updated = { ...e, ...patch, updated_at: Date.now() };
    if (patch.lore !== undefined || patch.stats !== undefined || patch.landmarks !== undefined) {
      if (updated.sync_state === 'synced') updated.sync_state = 'new';
    }
    await idb.put(updated);
    this._emit();
    return updated;
  }

  async attachThumbnail(id, blob) {
    const e = await idb.get(id);
    if (!e) return null;
    e.thumbnailBlob = blob;
    e.thumbnail_sync_state = 'new';
    e.updated_at = Date.now();
    await idb.put(e);
    this._emit();
    return e;
  }

  async markSyncing(id) {
    const e = await idb.get(id); if (!e) return;
    e.sync_state = 'syncing';
    await idb.put(e);
  }

  async markSynced(id, remoteId, canonical) {
    const e = await idb.get(id); if (!e) return;
    e.sync_state = 'synced';
    e.remote_id = remoteId;
    e.retry_count = 0;
    e.next_retry_at = 0;
    if (canonical && remoteId !== id) {
      // Server returned the canonical id from a prior insert; rewrite locally.
      const collision = await idb.get(remoteId);
      if (!collision) {
        await idb.delete(id);
        e.id = remoteId;
        await idb.put(e);
      } else {
        // The canonical row exists locally too — drop the loser and keep the
        // canonical with our merged data.
        const merged = mergeForDedupe(collision, e);
        merged.sync_state = 'synced';
        merged.remote_id = remoteId;
        await idb.put(merged);
        await idb.delete(id);
      }
    } else {
      await idb.put(e);
    }
    this._emit();
  }

  async markFailed(id, error) {
    const e = await idb.get(id); if (!e) return;
    e.sync_state = 'failed';
    e.retry_count = (e.retry_count || 0) + 1;
    e.next_retry_at = Date.now() + backoffMs(e.retry_count);
    e.last_error = String(error?.message || error);
    await idb.put(e);
    this._emit();
  }

  async markThumbnailSynced(id) {
    const e = await idb.get(id); if (!e) return;
    e.thumbnail_sync_state = 'synced';
    // We could drop the blob to save space; keep it for now (offline detail view).
    await idb.put(e);
    this._emit();
  }

  async markThumbnailFailed(id) {
    const e = await idb.get(id); if (!e) return;
    e.thumbnail_sync_state = 'failed';
    await idb.put(e);
  }

  async delete(id) {
    await idb.delete(id);
    this._emit();
  }

  async getAll() {
    const all = await idb.getAll();
    return all.sort((a, b) => b.claimed_at - a.claimed_at);
  }

  async get(id) { return idb.get(id); }

  async pendingForSync() {
    const all = await idb.getAll();
    const now = Date.now();
    return all.filter((e) =>
      (e.sync_state === 'new' || (e.sync_state === 'failed' && e.next_retry_at <= now))
      || (e.thumbnailBlob && e.thumbnail_sync_state === 'new')
      || (e.thumbnailBlob && e.thumbnail_sync_state === 'failed' && e.next_retry_at <= now),
    );
  }

  async resetTransientSyncing() {
    // Recovery after a crashed tab: any 'syncing' rows should retry.
    const all = await idb.getAll();
    for (const e of all) {
      if (e.sync_state === 'syncing') {
        e.sync_state = 'new';
        await idb.put(e);
      }
    }
  }

  _emit() {
    this.dispatchEvent(new Event('change'));
  }
}

function makeIdentityKey(e) {
  return `${e.galaxy_seed}|${e.cell_x},${e.cell_y},${e.cell_z}|${e.planet_index}`;
}

// For legacy entries (migrated from localStorage v1) where only `seed` was
// known, build a sentinel key so they don't collide with real entries.
export function legacyIdentity(seed) {
  return {
    galaxy_seed: 0, cell_x: SENTINEL, cell_y: SENTINEL, cell_z: SENTINEL,
    planet_index: -1, planet_seed: seed,
  };
}

function mergeForDedupe(prev, next) {
  return {
    ...prev,
    planet_name: next.planet_name || prev.planet_name,
    biome: next.biome ?? prev.biome,
    palette: next.palette ?? prev.palette,
    landmarks: next.landmarks ?? prev.landmarks,
    lore: next.lore ?? prev.lore,
    lore_status: next.lore_status ?? prev.lore_status,
    stats: next.stats ?? prev.stats,
    thumbnailBlob: next.thumbnailBlob ?? prev.thumbnailBlob,
    thumbnail_sync_state: next.thumbnailBlob
      ? 'new'
      : (prev.thumbnail_sync_state ?? null),
    claimed_at: prev.claimed_at,
    legacy: prev.legacy,
  };
}

function changed(a, b) {
  // Cheap shallow diff over the fields that matter for sync state.
  const keys = ['planet_name', 'biome', 'lore', 'lore_status', 'landmarks', 'palette', 'stats'];
  for (const k of keys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return true;
  }
  if ((a.thumbnailBlob == null) !== (b.thumbnailBlob == null)) return true;
  return false;
}

function backoffMs(retryCount) {
  // 5s, 15s, 1m, 5m, 30m, cap at 30m.
  const ladder = [5_000, 15_000, 60_000, 300_000, 1_800_000];
  return ladder[Math.min(retryCount - 1, ladder.length - 1)];
}
