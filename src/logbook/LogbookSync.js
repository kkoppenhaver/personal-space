// LogbookSync: background flusher.
//
// Runs whenever there's something to send. On boot, after each new entry,
// on `online` event, and when the tab regains focus. Each entry's
// sync_state drives what we send:
//   - row update (POST or PATCH) when entry payload itself is new/changed
//   - thumbnail PUT when blob is present and not yet synced
//
// Failures bump retry_count + next_retry_at on the entry; we don't block
// the UI.

import { apiPost, apiPatch, apiPut, ApiError } from '../net/api.js';

const TICK_MS = 4000;

export class LogbookSync extends EventTarget {
  constructor({ store, auth }) {
    super();
    this.store = store;
    this.auth = auth;
    this._timer = null;
    this._running = false;
    this._kicked = false;
    this.online = true;      // last sync attempt succeeded
    this.lastError = null;
  }

  _setOnline(v, err = null) {
    if (this.online === v) return;
    this.online = v;
    this.lastError = err;
    this.dispatchEvent(new Event('change'));
  }

  start() {
    if (this._timer) return;
    addEventListener('online', () => this.flush());
    addEventListener('focus', () => this.flush());
    this.store.addEventListener('change', () => this.flush());
    this.auth.addEventListener('change', () => this.flush());
    this._timer = setInterval(() => this.flush(), TICK_MS);
    this.flush();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  async flush() {
    if (this._running) { this._kicked = true; return; }
    this._running = true;
    try {
      do {
        this._kicked = false;
        if (!this.auth.user || !this.auth.online) break;
        const pending = await this.store.pendingForSync();
        if (pending.length === 0) break;
        for (const entry of pending) {
          await this._flushOne(entry);
        }
      } while (this._kicked);
    } finally {
      this._running = false;
    }
  }

  async _flushOne(entry) {
    // 1. Row insert/upsert
    const rowNeedsSend = entry.sync_state === 'new' ||
      (entry.sync_state === 'failed' && entry.next_retry_at <= Date.now());
    if (rowNeedsSend) {
      try {
        await this.store.markSyncing(entry.id);
        let payload = toServerPayload(entry);
        // First send is always POST (idempotent server-side). Subsequent
        // updates after a successful sync go through PATCH in update().
        const res = await apiPost('/api/logbook', payload);
        await this.store.markSynced(entry.id, res.id, res.canonical === true);
        entry = await this.store.get(res.id) || entry;
        this._setOnline(true);
      } catch (e) {
        await this.store.markFailed(entry.id, e);
        if (e instanceof ApiError && (e.status === 401 || e.status === 413 || e.status === 422)) {
          // Don't keep retrying obviously-broken cases.
          return;
        }
        if (!(e instanceof ApiError)) this._setOnline(false, e);
        return; // try again next tick
      }
    }

    // 2. Thumbnail upload (separate request; can race with row PATCHes safely)
    const thumbNeedsSend = entry.thumbnailBlob && (
      entry.thumbnail_sync_state === 'new' ||
      (entry.thumbnail_sync_state === 'failed' && entry.next_retry_at <= Date.now())
    );
    if (thumbNeedsSend) {
      try {
        await apiPut(`/api/logbook/${entry.id}/thumb`, entry.thumbnailBlob, {
          raw: true,
          contentType: 'image/jpeg',
          timeoutMs: 10000,
        });
        await this.store.markThumbnailSynced(entry.id);
        this._setOnline(true);
      } catch (e) {
        await this.store.markThumbnailFailed(entry.id);
        if (!(e instanceof ApiError)) this._setOnline(false, e);
      }
    }
  }
}

export async function patchEntryRemote(id, patch) {
  // For updates after the initial sync (e.g. Tier 3 lore arriving),
  // the caller calls this directly. It's safe to call before the first
  // POST has happened; the server returns 404 in that case and the next
  // flush tick will pick it up.
  try {
    await apiPatch(`/api/logbook/${id}`, patch);
    return true;
  } catch {
    return false;
  }
}

function toServerPayload(entry) {
  return {
    id: entry.id,
    galaxy_seed: entry.galaxy_seed,
    cell_x: entry.cell_x, cell_y: entry.cell_y, cell_z: entry.cell_z,
    planet_index: entry.planet_index,
    planet_seed: entry.planet_seed,
    planet_name: entry.planet_name,
    biome: entry.biome,
    palette: entry.palette,
    landmarks: entry.landmarks,
    lore: entry.lore,
    lore_status: entry.lore_status,
    stat_time_to_land_ms: entry.stats?.time_to_land_ms ?? null,
    stat_top_speed: entry.stats?.top_speed ?? null,
    stat_crashes: entry.stats?.crashes ?? null,
    stat_distance_m: entry.stats?.distance_m ?? null,
    legacy: !!entry.legacy,
    claimed_at: entry.claimed_at,
  };
}
