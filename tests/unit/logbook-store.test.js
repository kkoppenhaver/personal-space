// LogbookStore against an in-memory IndexedDB (fake-indexeddb).
//
// The headline test reproduces the "lore drifting in… forever" bug: several
// async paths mutate the same entry around a claim (Tier 3 lore patch,
// thumbnail attach, LogbookSync.flush reacting to every `change` event).
// Each must survive the others.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

let LogbookStore;
let store;

// idb.js caches its open-DB promise at module level, so every test gets a
// brand-new IndexedDB factory AND a fresh module graph.
beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  globalThis.IDBKeyRange = IDBKeyRange;
  vi.resetModules();
  ({ LogbookStore } = await import('../../src/logbook/LogbookStore.js'));
  store = new LogbookStore();
});

let n = 0;
function claimInput(over = {}) {
  n++;
  return {
    id: `local-${n}`,
    galaxy_seed: 7, cell_x: 1, cell_y: 2, cell_z: 3, planet_index: n,
    planet_seed: 1000 + n,
    planet_name: `Planet ${n}`,
    biome: 'forest',
    claimed_at: 1_700_000_000_000 + n,
    stats: { time_to_land_ms: 9000, top_speed: 40, crashes: 0, distance_m: 1200 },
    ...over,
  };
}

const LORE = 'The pilot notes the chairs all face the sea.';
const LANDMARKS = [{ name: 'The Seating', kind: 'hero' }];
const blob = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], { type: 'image/jpeg' });

describe('concurrent mutators (lost-update regression)', () => {
  it('lore patch, thumbnail attach and markSyncing all survive when interleaved', async () => {
    const e = await store.add(claimInput());
    expect(e.lore_status).toBe('pending');

    await Promise.all([
      store.update(e.id, { lore: LORE, lore_status: 'ready', landmarks: LANDMARKS }),
      store.attachThumbnail(e.id, blob()),
      store.markSyncing(e.id),
    ]);

    const got = await store.get(e.id);
    expect(got.lore).toBe(LORE);
    expect(got.lore_status).toBe('ready');
    expect(got.landmarks).toEqual(LANDMARKS);
    expect(got.thumbnailBlob).toBeTruthy();
    expect(got.thumbnail_sync_state).toBe('new');
    expect(got.sync_state).toBe('syncing');
  });

  it('a failed sync does not clobber lore or the thumbnail', async () => {
    const e = await store.add(claimInput());
    await store.markSyncing(e.id);

    await Promise.all([
      store.markFailed(e.id, new Error('offline')),
      store.update(e.id, { lore: LORE, lore_status: 'ready', landmarks: LANDMARKS }),
      store.attachThumbnail(e.id, blob()),
    ]);

    const got = await store.get(e.id);
    expect(got.lore).toBe(LORE);
    expect(got.lore_status).toBe('ready');
    expect(got.landmarks).toEqual(LANDMARKS);
    expect(got.thumbnail_sync_state).toBe('new');
    expect(got.thumbnailBlob).toBeTruthy();
    expect(got.sync_state).toBe('failed');
    expect(got.retry_count).toBe(1);
    expect(got.last_error).toBe('offline');
  });

  it('markSynced racing the lore patch keeps both the remote id and the lore', async () => {
    const e = await store.add(claimInput());
    await store.markSyncing(e.id);

    await Promise.all([
      store.markSynced(e.id, e.id, false),
      store.update(e.id, { lore: LORE, lore_status: 'ready' }),
      store.attachThumbnail(e.id, blob()),
      store.markThumbnailFailed(e.id),
    ]);

    const got = await store.get(e.id);
    expect(got.remote_id).toBe(e.id);
    expect(got.lore).toBe(LORE);
    expect(got.lore_status).toBe('ready');
    expect(got.thumbnailBlob).toBeTruthy();
    // The ONLY field two of these own jointly; the later call wins.
    expect(got.thumbnail_sync_state).toBe('failed');
    // update() ran after markSynced and changed lore → back to 'new'.
    expect(got.sync_state).toBe('new');
  });

  it('a flush-shaped burst (every change re-kicks sync) loses nothing', async () => {
    const e = await store.add(claimInput());
    const ops = [];
    for (let i = 0; i < 5; i++) {
      ops.push(store.markSyncing(e.id));
      ops.push(store.markFailed(e.id, 'x'));
    }
    ops.splice(3, 0, store.update(e.id, { lore: LORE, lore_status: 'ready', landmarks: LANDMARKS }));
    ops.splice(6, 0, store.attachThumbnail(e.id, blob()));
    await Promise.all(ops);

    const got = await store.get(e.id);
    expect(got.lore).toBe(LORE);
    expect(got.lore_status).toBe('ready');
    expect(got.landmarks).toEqual(LANDMARKS);
    expect(got.thumbnailBlob).toBeTruthy();
    expect(got.retry_count).toBe(5);
  });
});

describe('add', () => {
  it('dedupes by planet identity, keeping the first id and claim time', async () => {
    const input = claimInput();
    const first = await store.add(input);
    const second = await store.add({ ...input, id: 'local-other', claimed_at: 1, lore: LORE });
    expect(second.id).toBe(first.id);
    expect(second.claimed_at).toBe(first.claimed_at);
    expect(second.lore).toBe(LORE);
    const all = await store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].lore).toBe(LORE);
  });

  it('dedupe of a synced entry with new data flips it back to new', async () => {
    const input = claimInput();
    const first = await store.add(input);
    await store.markSynced(first.id, first.id, false);
    await store.add({ ...input, lore: LORE });
    expect((await store.get(first.id)).sync_state).toBe('new');
  });

  it('dedupe with nothing new neither writes nor emits', async () => {
    const input = claimInput();
    await store.add(input);
    const onChange = vi.fn();
    store.addEventListener('change', onChange);
    await store.add({ ...input, id: 'dupe' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('concurrent adds of the same planet converge on one row', async () => {
    const input = claimInput();
    const [a, b] = await Promise.all([
      store.add(input),
      store.add({ ...input, id: 'local-tab2', lore: LORE }),
    ]);
    expect(a.id).toBe(b.id);
    const all = await store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].lore).toBe(LORE);
  });
});

describe('update', () => {
  it('flips synced back to new when lore, stats or landmarks change', async () => {
    for (const patch of [{ lore: LORE }, { stats: { crashes: 3 } }, { landmarks: LANDMARKS }]) {
      const e = await store.add(claimInput());
      await store.markSynced(e.id, e.id, false);
      const out = await store.update(e.id, patch);
      expect(out.sync_state).toBe('new');
      expect((await store.get(e.id)).sync_state).toBe('new');
    }
  });

  it('does not flip synced for other fields', async () => {
    const e = await store.add(claimInput());
    await store.markSynced(e.id, e.id, false);
    await store.update(e.id, { lore_status: 'failed' });
    expect((await store.get(e.id)).sync_state).toBe('synced');
  });

  it('returns null for a missing id and emits nothing', async () => {
    const onChange = vi.fn();
    store.addEventListener('change', onChange);
    expect(await store.update('nope', { lore: LORE })).toBeNull();
    expect(await store.attachThumbnail('nope', blob())).toBeNull();
    await store.markSyncing('nope');
    await store.markFailed('nope', 'x');
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('markSynced with a canonical id', () => {
  it('rewrites the local id to the server canonical id', async () => {
    const e = await store.add(claimInput({ lore: LORE }));
    await store.markSynced(e.id, 'srv-1', true);
    expect(await store.get(e.id)).toBeUndefined();
    const got = await store.get('srv-1');
    expect(got.id).toBe('srv-1');
    expect(got.remote_id).toBe('srv-1');
    expect(got.sync_state).toBe('synced');
    expect(got.lore).toBe(LORE);
  });

  it('merges into an existing local canonical row and drops the loser', async () => {
    const canonical = await store.add(claimInput({ id: 'srv-2' }));
    const loser = await store.add(claimInput({ lore: LORE }));
    await store.markSynced(loser.id, canonical.id, true);
    expect(await store.get(loser.id)).toBeUndefined();
    const got = await store.get('srv-2');
    expect(got.lore).toBe(LORE);
    expect(got.sync_state).toBe('synced');
    expect(got.remote_id).toBe('srv-2');
  });
});

describe('pendingForSync', () => {
  it('returns new rows, due failures, and unsynced thumbnails only', async () => {
    const fresh = await store.add(claimInput());
    const synced = await store.add(claimInput());
    await store.markSynced(synced.id, synced.id, false);
    const failedDue = await store.add(claimInput());
    await store.markFailed(failedDue.id, 'x');
    const failedLater = await store.add(claimInput());
    await store.markFailed(failedLater.id, 'x');
    const thumbOnly = await store.add(claimInput());
    await store.markSynced(thumbOnly.id, thumbOnly.id, false);
    await store.attachThumbnail(thumbOnly.id, blob());
    const thumbDone = await store.add(claimInput());
    await store.attachThumbnail(thumbDone.id, blob());
    await store.markSynced(thumbDone.id, thumbDone.id, false);
    await store.markThumbnailSynced(thumbDone.id);
    const syncing = await store.add(claimInput());
    await store.markSyncing(syncing.id);

    // Make failedDue's retry due without waiting out the backoff.
    const realNow = Date.now;
    const now = realNow();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const due = await store.get(failedDue.id);
    expect(due.next_retry_at).toBeGreaterThan(now);
    vi.spyOn(Date, 'now').mockReturnValue(due.next_retry_at);
    const ids = (await store.pendingForSync()).map((e) => e.id).sort();
    vi.restoreAllMocks();

    // failedLater has the same backoff, so it is due at the same moment —
    // check the "not yet due" side separately.
    expect(ids).toEqual([fresh.id, failedDue.id, failedLater.id, thumbOnly.id].sort());
    const notYet = (await store.pendingForSync()).map((e) => e.id);
    expect(notYet).not.toContain(failedDue.id);
    expect(notYet).not.toContain(failedLater.id);
    expect(notYet).not.toContain(synced.id);
    expect(notYet).not.toContain(thumbDone.id);
    expect(notYet).not.toContain(syncing.id);
  });
});

describe('resetTransientSyncing', () => {
  it('turns crashed syncing rows back into new and leaves the rest alone', async () => {
    const a = await store.add(claimInput({ lore: LORE }));
    const b = await store.add(claimInput());
    const c = await store.add(claimInput());
    await store.markSyncing(a.id);
    await store.markSyncing(b.id);
    await store.markSynced(c.id, c.id, false);
    await store.resetTransientSyncing();
    expect((await store.get(a.id)).sync_state).toBe('new');
    expect((await store.get(a.id)).lore).toBe(LORE);
    expect((await store.get(b.id)).sync_state).toBe('new');
    expect((await store.get(c.id)).sync_state).toBe('synced');
  });
});

describe('change events', () => {
  it('fire for add/update/attach/markSynced/markFailed/markThumbnailSynced/delete, not markSyncing/markThumbnailFailed', async () => {
    const onChange = vi.fn();
    store.addEventListener('change', onChange);
    const e = await store.add(claimInput());
    expect(onChange).toHaveBeenCalledTimes(1);
    await store.markSyncing(e.id);
    expect(onChange).toHaveBeenCalledTimes(1);
    await store.markThumbnailFailed(e.id);
    expect(onChange).toHaveBeenCalledTimes(1);
    await store.update(e.id, { lore: LORE });
    await store.attachThumbnail(e.id, blob());
    await store.markFailed(e.id, 'x');
    await store.markSynced(e.id, e.id, false);
    await store.markThumbnailSynced(e.id);
    await store.delete(e.id);
    expect(onChange).toHaveBeenCalledTimes(7);
  });
});
