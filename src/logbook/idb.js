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
