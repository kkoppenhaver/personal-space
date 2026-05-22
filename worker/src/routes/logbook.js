// Logbook CRUD + thumbnail upload/download.
// All routes require a session; anonymous users are fine — they have one too.

import { Hono } from 'hono';
import { requireSession } from '../lib/auth-mw.js';
import { rateLimit } from '../lib/ratelimit.js';

export const logbook = new Hono();

const ENTRY_SOFT_CAP = 500;
const ENTRY_HARD_CAP = 2000;
const LORE_MAX_BYTES = 2048;
const THUMB_MAX_BYTES = 150 * 1024;

logbook.use('*', requireSession);

// ─── List ────────────────────────────────────────────────────────────────

logbook.get('/', async (c) => {
  const user = c.get('user');
  const rs = await c.env.DB.prepare(
    `SELECT id, galaxy_seed, cell_x, cell_y, cell_z, planet_index, planet_seed,
            planet_name, biome, palette, landmarks, lore, lore_status,
            thumbnail_key, stat_time_to_land_ms, stat_top_speed, stat_crashes,
            stat_distance_m, legacy, claimed_at, updated_at
     FROM entries WHERE user_id = ?1
     ORDER BY claimed_at DESC LIMIT 5000`,
  ).bind(user.id).all();
  return c.json({ entries: (rs.results || []).map(decodeEntry) });
});

// ─── Create / upsert ─────────────────────────────────────────────────────

logbook.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => null);
  const e = validateEntryInput(body);
  if (!e.ok) return c.json({ error: e.error }, 400);
  const v = e.value;

  // Entry cap (hard). Soft cap is enforced client-side as a warning UX.
  const { results } = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM entries WHERE user_id = ?1`,
  ).bind(user.id).all();
  if ((results?.[0]?.n ?? 0) >= ENTRY_HARD_CAP) {
    return c.json({ error: 'entry_cap_reached', cap: ENTRY_HARD_CAP }, 422);
  }

  const now = Date.now();
  const insert = c.env.DB.prepare(`
    INSERT INTO entries
      (id, user_id, galaxy_seed, cell_x, cell_y, cell_z, planet_index, planet_seed,
       planet_name, biome, palette, landmarks, lore, lore_status,
       stat_time_to_land_ms, stat_top_speed, stat_crashes, stat_distance_m,
       legacy, claimed_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
    ON CONFLICT(user_id, galaxy_seed, cell_x, cell_y, cell_z, planet_index)
      DO UPDATE SET updated_at = excluded.updated_at
    RETURNING id
  `).bind(
    v.id, user.id, v.galaxy_seed, v.cell_x, v.cell_y, v.cell_z, v.planet_index, v.planet_seed,
    v.planet_name, v.biome ?? null, v.palette ? JSON.stringify(v.palette) : null,
    v.landmarks ? JSON.stringify(v.landmarks) : null,
    v.lore ?? null, v.lore_status ?? 'pending',
    v.stat_time_to_land_ms ?? null, v.stat_top_speed ?? null,
    v.stat_crashes ?? null, v.stat_distance_m ?? null,
    v.legacy ? 1 : 0, v.claimed_at, now,
  );
  const row = await insert.first();
  const wasNew = row.id === v.id;

  // Only count first-time claims. Duplicates (same identity tuple posted from
  // a second tab or device) return the canonical id but don't bump the counter.
  if (wasNew) {
    c.executionCtx.waitUntil(c.env.DB.prepare(
      `UPDATE users SET claim_count = claim_count + 1, last_seen_at = ?1 WHERE id = ?2`,
    ).bind(now, user.id).run().catch(() => {}));
  }

  return c.json({ id: row.id, canonical: !wasNew });
});

// ─── Patch (backfill lore + stats after claim) ───────────────────────────

logbook.patch('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'bad_json' }, 400);

  const sets = [];
  const binds = [];
  let n = 1;
  function set(col, val) { sets.push(`${col} = ?${n}`); binds.push(val); n++; }

  if ('lore' in body) {
    if (body.lore !== null && (typeof body.lore !== 'string' || body.lore.length > LORE_MAX_BYTES)) {
      return c.json({ error: 'lore_too_long' }, 400);
    }
    set('lore', body.lore);
  }
  if ('lore_status' in body) {
    if (!['pending', 'ready', 'failed'].includes(body.lore_status)) {
      return c.json({ error: 'bad_lore_status' }, 400);
    }
    set('lore_status', body.lore_status);
  }
  if ('landmarks' in body) {
    set('landmarks', body.landmarks ? JSON.stringify(body.landmarks) : null);
  }
  if ('stat_time_to_land_ms' in body) set('stat_time_to_land_ms', toInt(body.stat_time_to_land_ms));
  if ('stat_top_speed' in body) set('stat_top_speed', toNum(body.stat_top_speed));
  if ('stat_crashes' in body) set('stat_crashes', toInt(body.stat_crashes));
  if ('stat_distance_m' in body) set('stat_distance_m', toNum(body.stat_distance_m));

  if (sets.length === 0) return c.json({ error: 'nothing_to_update' }, 400);
  set('updated_at', Date.now());

  const sql = `UPDATE entries SET ${sets.join(', ')} WHERE id = ?${n} AND user_id = ?${n + 1}`;
  binds.push(id, user.id);

  const res = await c.env.DB.prepare(sql).bind(...binds).run();
  if (!res.meta?.changes) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

// ─── Delete ──────────────────────────────────────────────────────────────

logbook.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT thumbnail_key FROM entries WHERE id = ?1 AND user_id = ?2`,
  ).bind(id, user.id).first();
  if (!row) return c.json({ error: 'not_found' }, 404);

  await c.env.DB.prepare(`DELETE FROM entries WHERE id = ?1 AND user_id = ?2`)
    .bind(id, user.id).run();
  if (row.thumbnail_key) {
    c.executionCtx.waitUntil(c.env.THUMBS.delete(row.thumbnail_key).catch(() => {}));
  }
  return c.json({ ok: true });
});

// ─── Thumbnail PUT (image/jpeg) ──────────────────────────────────────────

logbook.put('/:id/thumb', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  const limited = await rateLimit(c.env.THUMB_LIMITER, `thumb:${user.id}`);
  if (!limited.success) return c.json({ error: 'rate_limited' }, 429);

  const ct = c.req.header('content-type') || '';
  if (!ct.startsWith('image/jpeg')) return c.json({ error: 'bad_content_type' }, 415);

  const lenHdr = parseInt(c.req.header('content-length') || '0', 10);
  if (lenHdr && lenHdr > THUMB_MAX_BYTES) return c.json({ error: 'too_large' }, 413);

  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (buf.byteLength === 0) return c.json({ error: 'empty' }, 400);
  if (buf.byteLength > THUMB_MAX_BYTES) return c.json({ error: 'too_large' }, 413);
  // JPEG magic bytes
  if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) {
    return c.json({ error: 'not_a_jpeg' }, 400);
  }

  // Make sure the entry exists and belongs to this user.
  const owns = await c.env.DB.prepare(
    `SELECT id FROM entries WHERE id = ?1 AND user_id = ?2`,
  ).bind(id, user.id).first();
  if (!owns) return c.json({ error: 'not_found' }, 404);

  const key = `thumbs/${user.id}/${id}.jpg`;
  await c.env.THUMBS.put(key, buf, {
    httpMetadata: {
      contentType: 'image/jpeg',
      cacheControl: 'public, max-age=31536000, immutable',
    },
  });

  await c.env.DB.prepare(
    `UPDATE entries SET thumbnail_key = ?1, updated_at = ?2 WHERE id = ?3`,
  ).bind(key, Date.now(), id).run();

  return c.json({ ok: true, key });
});

// ─── Thumbnail GET ───────────────────────────────────────────────────────

logbook.get('/:id/thumb', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT thumbnail_key FROM entries WHERE id = ?1 AND user_id = ?2`,
  ).bind(id, user.id).first();
  if (!row?.thumbnail_key) return c.json({ error: 'no_thumbnail' }, 404);

  const obj = await c.env.THUMBS.get(row.thumbnail_key);
  if (!obj) return c.json({ error: 'gone' }, 410);

  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set('etag', obj.httpEtag);
  h.set('cache-control', 'public, max-age=31536000, immutable');
  return new Response(obj.body, { status: 200, headers: h });
});

// ─── Helpers ─────────────────────────────────────────────────────────────

function decodeEntry(r) {
  return {
    id: r.id,
    galaxy_seed: r.galaxy_seed,
    cell_x: r.cell_x, cell_y: r.cell_y, cell_z: r.cell_z,
    planet_index: r.planet_index,
    planet_seed: r.planet_seed,
    planet_name: r.planet_name,
    biome: r.biome,
    palette: r.palette ? JSON.parse(r.palette) : null,
    landmarks: r.landmarks ? JSON.parse(r.landmarks) : null,
    lore: r.lore,
    lore_status: r.lore_status,
    thumbnail_url: r.thumbnail_key ? `/api/logbook/${r.id}/thumb` : null,
    stats: {
      time_to_land_ms: r.stat_time_to_land_ms,
      top_speed: r.stat_top_speed,
      crashes: r.stat_crashes,
      distance_m: r.stat_distance_m,
    },
    legacy: r.legacy === 1,
    claimed_at: r.claimed_at,
    updated_at: r.updated_at,
  };
}

function validateEntryInput(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'bad_json' };
  const need = ['id', 'galaxy_seed', 'cell_x', 'cell_y', 'cell_z', 'planet_index',
                'planet_seed', 'planet_name', 'claimed_at'];
  for (const k of need) if (!(k in body)) return { ok: false, error: `missing_${k}` };
  if (typeof body.id !== 'string' || body.id.length < 8 || body.id.length > 64) {
    return { ok: false, error: 'bad_id' };
  }
  if (typeof body.planet_name !== 'string' || body.planet_name.length > 80) {
    return { ok: false, error: 'bad_planet_name' };
  }
  if (body.lore !== undefined && body.lore !== null) {
    if (typeof body.lore !== 'string' || body.lore.length > LORE_MAX_BYTES) {
      return { ok: false, error: 'lore_too_long' };
    }
  }
  return {
    ok: true,
    value: {
      id: body.id,
      galaxy_seed: toInt(body.galaxy_seed),
      cell_x: toInt(body.cell_x), cell_y: toInt(body.cell_y), cell_z: toInt(body.cell_z),
      planet_index: toInt(body.planet_index),
      planet_seed: toInt(body.planet_seed),
      planet_name: body.planet_name,
      biome: typeof body.biome === 'string' ? body.biome : null,
      palette: body.palette ?? null,
      landmarks: Array.isArray(body.landmarks) ? body.landmarks : null,
      lore: body.lore ?? null,
      lore_status: body.lore_status ?? (body.lore ? 'ready' : 'pending'),
      stat_time_to_land_ms: optInt(body.stat_time_to_land_ms),
      stat_top_speed: optNum(body.stat_top_speed),
      stat_crashes: optInt(body.stat_crashes),
      stat_distance_m: optNum(body.stat_distance_m),
      legacy: body.legacy === true,
      claimed_at: toInt(body.claimed_at),
    },
  };
}

function toInt(v) { return v == null ? 0 : (v | 0); }
function toNum(v) { return v == null ? 0 : Number(v); }
function optInt(v) { return v == null ? null : (v | 0); }
function optNum(v) { return v == null ? null : Number(v); }
