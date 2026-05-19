// Logbook: planets visited, persisted in localStorage. Slide-out panel.

const STORAGE_KEY = 'paper-airplane:logbook:v1';

export class Logbook {
  constructor() {
    this.panel = document.getElementById('logbook');
    this.list = document.getElementById('logbook-list');
    this.btn = document.getElementById('logbook-toggle');
    this.entries = load();
    if (this.btn) this.btn.addEventListener('click', () => this.toggle());
    this.render();
  }

  add(entry) {
    // Avoid duplicates by seed
    if (this.entries.some(e => e.seed === entry.seed)) return;
    this.entries.push(entry);
    save(this.entries);
    this.render();
  }

  toggle() {
    if (!this.panel) return;
    this.panel.classList.toggle('open');
  }

  render() {
    if (!this.list) return;
    this.list.innerHTML = '';
    const sorted = [...this.entries].sort((a, b) => b.visitedAt - a.visitedAt);
    if (sorted.length === 0) {
      this.list.innerHTML = '<div class="entry" style="opacity:0.4">No worlds yet — fly into atmosphere.</div>';
      return;
    }
    for (const e of sorted) {
      const div = document.createElement('div');
      div.className = 'entry';
      div.innerHTML = `
        <div class="name">${escapeHTML(e.name || `Unnamed-${e.seed}`)}</div>
        <div class="biome">${escapeHTML(e.biome || 'unknown')}</div>
        <div class="ts">${new Date(e.visitedAt).toLocaleString()}</div>
      `;
      this.list.appendChild(div);
    }
  }
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function save(entries) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch (e) { /* quota etc. — ignore */ }
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
