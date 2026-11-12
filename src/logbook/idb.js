// Tiny IndexedDB wrapper. Zero deps; just enough for our object store.

const DB_NAME = 'paper-airplane';
const DB_VERSION = 1;
const ENTRIES = 'entries';
const META = 'meta';

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ENTRIES)) {
        const s = db.createObjectStore(ENTRIES, { keyPath: 'id' });
        s.createIndex('identity', 'identityKey', { unique: true });
        s.createIndex('claimed_at', 'claimed_at');
        s.createIndex('sync_state', 'sync_state');
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: 'k' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('idb_blocked'));
  });
  return _dbPromise;
}

function tx(storeName, mode) {
  return openDB().then((db) => {
    const t = db.transaction(storeName, mode);
    return { store: t.objectStore(storeName), done: complete(t) };
  });
}

function complete(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  });
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export const idb = {
  async get(id) {
    const { store } = await tx(ENTRIES, 'readonly');
    return req(store.get(id));
  },
  async getByIdentity(key) {
    const { store } = await tx(ENTRIES, 'readonly');
    return req(store.index('identity').get(key));
  },
  async getAll() {
    const { store } = await tx(ENTRIES, 'readonly');
    return req(store.getAll());
  },
  async getPendingSync() {
    const { store } = await tx(ENTRIES, 'readonly');
    return new Promise((resolve, reject) => {
      const out = [];
      const r = store.index('sync_state').openCursor();
      r.onsuccess = () => {
        const cur = r.result;
        if (!cur) return resolve(out);
        if (cur.value.sync_state === 'new' || cur.value.sync_state === 'failed') {
          out.push(cur.value);
        }
        cur.continue();
      };
      r.onerror = () => reject(r.error);
    });
  },
  /**
   * Atomic read-modify-write on the entries store: every read and write
   * happens inside ONE readwrite transaction, so no other writer can land
   * between them (separate get/put transactions let a stale whole-object
   * put clobber fields another path just wrote — the "lore drifting in…
   * forever" bug).
   *
   * `reads` is a list of `{ id }` or `{ identity }` lookups. `apply` runs
   * synchronously inside the last read's success callback with the records
   * in the same order (undefined when missing) and returns
   * `{ put?: entry[], del?: id[], result? }` or null for "no change".
   * Deletes are issued before puts so an id rewrite never trips the unique
   * identity index. Resolves with `result` once the transaction commits.
   * `apply` must not await: an idle transaction auto-commits.
   */
  async atomic(reads, apply) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(ENTRIES, 'readwrite');
      const store = t.objectStore(ENTRIES);
      const records = new Array(reads.length);
      let remaining = reads.length;
      let out = null;
      let failed = null;
      const write = () => {
        try {
          out = apply(records) || null;
        } catch (err) {
          failed = err;
          t.abort();
          return;
        }
        if (!out) return;
        for (const id of out.del || []) store.delete(id);
        for (const entry of out.put || []) store.put(entry);
      };
      t.oncomplete = () => resolve(out ? out.result : undefined);
      t.onerror = () => reject(failed || t.error);
      t.onabort = () => reject(failed || t.error || new Error('aborted'));
      reads.forEach((r, i) => {
        const q = r.identity !== undefined ? store.index('identity').get(r.identity) : store.get(r.id);
        q.onsuccess = () => {
          records[i] = q.result;
          if (--remaining === 0) write();
        };
      });
      if (remaining === 0) write();
    });
  },
  /**
   * Atomic patch of one entry. `fn(current)` returns the next whole entry
   * (built from the record read in this same transaction) or null to skip
   * the write. Resolves with the written entry, or null if `id` is missing
   * or nothing was written.
   */
  async mutate(id, fn) {
    return idb.atomic([{ id }], ([cur]) => {
      if (!cur) return null;
      const next = fn(cur);
      return next ? { put: [next], result: next } : null;
    }).then((r) => r ?? null);
  },
  /**
   * Cursor over every entry in one readwrite transaction; `fn(entry)`
   * returns the replacement or null to leave it. Resolves with the count
   * of rows rewritten.
   */
  async updateEach(fn) {
    const { store, done } = await tx(ENTRIES, 'readwrite');
    let changed = 0;
    const r = store.openCursor();
    r.onsuccess = () => {
      const cur = r.result;
      if (!cur) return;
      const next = fn(cur.value);
      if (next) { cur.update(next); changed++; }
      cur.continue();
    };
    await done;
    return changed;
  },
  async put(entry) {
    const { store, done } = await tx(ENTRIES, 'readwrite');
    store.put(entry);
    await done;
    return entry;
  },
  async delete(id) {
    const { store, done } = await tx(ENTRIES, 'readwrite');
    store.delete(id);
    await done;
  },
  async clear() {
    const { store, done } = await tx(ENTRIES, 'readwrite');
    store.clear();
    await done;
  },
  async metaGet(k) {
    const { store } = await tx(META, 'readonly');
    const row = await req(store.get(k));
    return row?.v;
  },
  async metaSet(k, v) {
    const { store, done } = await tx(META, 'readwrite');
    store.put({ k, v });
    await done;
  },
};
