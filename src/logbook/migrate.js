// One-time migration: import the localStorage v1 logbook into the IDB store.
//
// Old shape (Logbook.add):
//   { seed, name, biome, palette, landmarks, visitedAt }
//
// We don't know the new identity tuple for these entries, so they get the
// sentinel from LogbookStore.legacyIdentity + legacy=true. The detail view
// will group them under "Before the galaxy".

import { idb } from './idb.js';
import { legacyIdentity } from './LogbookStore.js';

const OLD_KEY = 'paper-airplane:logbook:v1';
const MIGRATED_FLAG = 'logbook:v1-migrated';

export async function migrateLocalStorageIfNeeded(store) {
  if (await idb.metaGet(MIGRATED_FLAG)) return { migrated: 0, skipped: true };
  let raw;
  try { raw = localStorage.getItem(OLD_KEY); } catch { raw = null; }
  if (!raw) {
    await idb.metaSet(MIGRATED_FLAG, true);
    return { migrated: 0, skipped: true };
  }
  let arr;
  try { arr = JSON.parse(raw); } catch { arr = null; }
  if (!Array.isArray(arr) || arr.length === 0) {
    await idb.metaSet(MIGRATED_FLAG, true);
    try { localStorage.removeItem(OLD_KEY); } catch {}
    return { migrated: 0, skipped: true };
  }

  let migrated = 0;
  for (const old of arr) {
    if (!old || typeof old !== 'object' || old.seed == null) continue;
    const idn = legacyIdentity(old.seed);
    await store.add({
      id: cryptoUUID(),
      galaxy_seed: idn.galaxy_seed,
      cell_x: idn.cell_x, cell_y: idn.cell_y, cell_z: idn.cell_z,
      planet_index: idn.planet_index,
      planet_seed: old.seed | 0,
      planet_name: String(old.name || `Unnamed-${old.seed}`),
      biome: old.biome || null,
      palette: old.palette || null,
      landmarks: Array.isArray(old.landmarks) ? old.landmarks : null,
      claimed_at: Number(old.visitedAt) || Date.now(),
      legacy: true,
    });
    migrated++;
  }

  await idb.metaSet(MIGRATED_FLAG, true);
  try { localStorage.removeItem(OLD_KEY); } catch {}
  return { migrated, skipped: false };
}

function cryptoUUID() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  // Fallback (very old browsers won't get here in 2026).
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
