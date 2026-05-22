// Logbook UI — slide-out drawer that lists every claimed planet and lets
// you open a detail view (thumbnail, lore, landmarks, stats).
//
// The component is a pure renderer over a LogbookStore. Old code paths in
// main.js can still call `logbook.add(oldShape)`; that's translated to a
// legacy-tagged entry in the new store until Phase 4 rewires the claim site.

import { legacyIdentity } from '../logbook/LogbookStore.js';

export class Logbook {
  /**
   * @param {{ store: import('../logbook/LogbookStore.js').LogbookStore }} opts
   */
  constructor({ store }) {
    this.store = store;
    this.panel = document.getElementById('logbook');
    this.list = document.getElementById('logbook-list');
    this.btn = document.getElementById('logbook-toggle');
    this.detailId = null;          // when set, render detail view for this id
    this._thumbCache = new WeakMap(); // blob → object URL

    if (this.btn) this.btn.addEventListener('click', () => this.toggle());
    if (this.list) this.list.addEventListener('click', (e) => this._onListClick(e));

    this.store.addEventListener('change', () => this.render());
    this.render();
  }

  // Back-compat shim for the current claim site in main.js.
  // Phase 4 will replace the caller; until then any old-shape add() becomes a
  // legacy=true entry with the sentinel identity.
  add(input) {
    if (input && 'galaxy_seed' in input) return this.store.add(input);
    if (input && 'seed' in input) {
      const idn = legacyIdentity(input.seed);
      return this.store.add({
        id: cryptoUUID(),
        galaxy_seed: idn.galaxy_seed,
        cell_x: idn.cell_x, cell_y: idn.cell_y, cell_z: idn.cell_z,
        planet_index: idn.planet_index,
        planet_seed: input.seed | 0,
        planet_name: String(input.name || `Unnamed-${input.seed}`),
        biome: input.biome ?? null,
        palette: input.palette ?? null,
        landmarks: Array.isArray(input.landmarks) ? input.landmarks : null,
        claimed_at: Number(input.visitedAt) || Date.now(),
        legacy: true,
      });
    }
    return Promise.resolve(null);
  }

  toggle() {
    if (!this.panel) return;
    this.panel.classList.toggle('open');
    if (!this.panel.classList.contains('open')) this.detailId = null;
  }

  async render() {
    if (!this.list) return;
    const entries = await this.store.getAll();

    if (this.detailId) {
      const e = entries.find((x) => x.id === this.detailId);
      if (e) return this._renderDetail(e);
      this.detailId = null;
    }
    this._renderList(entries);
  }

  _renderList(entries) {
    if (entries.length === 0) {
      this.list.innerHTML = '<div class="entry" style="opacity:0.4">No worlds yet — fly into atmosphere.</div>';
      return;
    }
    const live = entries.filter((e) => !e.legacy);
    const legacy = entries.filter((e) => e.legacy);

    let html = '';
    for (const e of live) html += this._tile(e);
    if (legacy.length > 0) {
      html += `<div class="section-divider">BEFORE THE GALAXY</div>`;
      for (const e of legacy) html += this._tile(e);
    }
    this.list.innerHTML = html;
  }

  _tile(e) {
    const dot = syncDot(e);
    return `
      <div class="entry" data-id="${attr(e.id)}">
        <div class="row">
          <span class="name">${esc(e.planet_name || `Unnamed-${e.planet_seed}`)}</span>
          <span class="sync ${dot.cls}" title="${dot.title}">${dot.glyph}</span>
        </div>
        <div class="biome">${esc(e.biome || 'unknown')}</div>
        <div class="ts">${formatDate(e.claimed_at)}</div>
      </div>
    `;
  }

  _renderDetail(e) {
    const thumbHtml = this._thumbHTML(e);
    const lore = e.lore_status === 'ready' && e.lore
      ? `<div class="lore">${esc(e.lore)}</div>`
      : e.lore_status === 'failed'
        ? `<div class="lore muted">lore lost to time.</div>`
        : `<div class="lore muted">lore drifting in…</div>`;
    const landmarksHtml = (Array.isArray(e.landmarks) && e.landmarks.length > 0)
      ? `<div class="landmarks"><div class="section-divider">LANDMARKS</div>${
          e.landmarks.map((l) => `<div class="landmark">
            <div class="lname">${esc(l.name || `Slot ${l.slotId}`)}</div>
            ${l.blurb ? `<div class="lblurb">${esc(l.blurb)}</div>` : ''}
          </div>`).join('')
        }</div>` : '';
    const s = e.stats || {};
    const statsHtml = `
      <div class="section-divider">FLIGHT</div>
      <div class="stats">
        ${statRow('time to land', formatMs(s.time_to_land_ms))}
        ${statRow('top speed', s.top_speed != null ? `${s.top_speed.toFixed(1)} m/s` : '—')}
        ${statRow('crashes', s.crashes ?? '—')}
        ${statRow('distance', s.distance_m != null ? `${(s.distance_m / 1000).toFixed(2)} km` : '—')}
      </div>
    `;
    this.list.innerHTML = `
      <button class="back-btn" data-back="1">← BACK</button>
      ${thumbHtml}
      <div class="detail-title">${esc(e.planet_name)}</div>
      <div class="detail-biome">${esc(e.biome || 'unknown')}${e.legacy ? ' · legacy' : ''}</div>
      ${lore}
      ${landmarksHtml}
      ${statsHtml}
      <div class="detail-ts">${formatDate(e.claimed_at)}</div>
    `;
  }

  _thumbHTML(e) {
    if (e.thumbnailBlob) {
      let url = this._thumbCache.get(e.thumbnailBlob);
      if (!url) {
        url = URL.createObjectURL(e.thumbnailBlob);
        this._thumbCache.set(e.thumbnailBlob, url);
      }
      return `<img class="thumb" src="${url}" alt="">`;
    }
    if (e.thumbnail_url) {
      return `<img class="thumb" src="${attr(e.thumbnail_url)}" alt="">`;
    }
    const pal = e.palette || {};
    const a = pal.sky || pal.high || '#444';
    const b = pal.water || pal.low || '#222';
    return `<div class="thumb placeholder" style="background:linear-gradient(160deg,${esc(a)},${esc(b)})"></div>`;
  }

  _onListClick(ev) {
    const back = ev.target.closest('[data-back]');
    if (back) {
      this.detailId = null;
      this.render();
      return;
    }
    const tile = ev.target.closest('[data-id]');
    if (tile) {
      this.detailId = tile.dataset.id;
      this.render();
    }
  }
}

function syncDot(e) {
  if (e.legacy) return { cls: 'sync-muted', glyph: '·', title: 'legacy entry' };
  if (e.sync_state === 'synced') return { cls: 'sync-ok', glyph: '●', title: 'saved to cloud' };
  if (e.sync_state === 'syncing') return { cls: 'sync-pending', glyph: '◐', title: 'syncing…' };
  if (e.sync_state === 'failed') return { cls: 'sync-failed', glyph: '◌', title: 'will retry' };
  return { cls: 'sync-pending', glyph: '○', title: 'pending sync' };
}

function statRow(label, val) {
  return `<div class="stat-row"><span class="stat-label">${label}</span><span class="stat-val">${esc(String(val))}</span></div>`;
}

function formatDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

function formatMs(ms) {
  if (ms == null) return '—';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60), r = (s - m * 60);
  return `${m}m ${r.toFixed(0)}s`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function attr(s) { return esc(s); }

function cryptoUUID() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
