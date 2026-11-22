'use strict';
/**
 * Install sizes for games whose store does not report one (GOG, Ubisoft, Xbox, emulators).
 * Steam and Epic sizes come from their manifests. Folder sizes are measured in the background,
 * one folder at a time, and remembered for a week (sizes.json) so sorting by size is instant.
 */
const path = require('path');
const fsp = require('fs').promises;
const { normKey } = require('./util/fsx');

const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 400000;

/** Total size of all files below a folder (does not follow links or junctions). */
async function folderSize(dir, { maxEntries = MAX_ENTRIES } = {}) {
  let total = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length && seen < maxEntries) {
    const cur = stack.pop();
    let entries;
    try { entries = await fsp.readdir(cur, { withFileTypes: true }); } catch { continue; }
    const files = [];
    for (const e of entries) {
      seen++;
      if (e.isDirectory()) stack.push(path.join(cur, e.name));
      else if (e.isFile()) files.push(path.join(cur, e.name));
    }
    for (let i = 0; i < files.length; i += 64) {
      const stats = await Promise.all(files.slice(i, i + 64).map((f) => fsp.lstat(f).catch(() => null)));
      for (const st of stats) if (st && st.isFile()) total += st.size;
    }
  }
  return total;
}

/** What to measure for a game: a file (emulator game) or a folder, or null. */
function target(g) {
  if (!g || g.sizeBytes > 0 || !g.installed) return null;
  if (g.romPath) return { key: normKey(g.romPath), path: g.romPath, file: true };
  if (g.source === 'manual' || !g.installDir) return null;
  return { key: normKey(g.installDir), path: g.installDir, file: false };
}

class Sizes {
  constructor({ store, log = console, measureFolder = folderSize }) {
    this.store = store;
    this.log = log;
    this.measureFolder = measureFolder;
    if (!this.store.sizes || typeof this.store.sizes !== 'object') this.store.sizes = {};
    this.queue = [];
    this.running = false;
  }

  /** Fills in known sizes (synchronously, from the cache). */
  apply(games) {
    for (const g of games) {
      const t = target(g);
      const hit = t && this.store.sizes[t.key];
      if (hit && hit.bytes > 0) g.sizeBytes = hit.bytes;
    }
  }

  /** Measures missing or old sizes in the background; onUpdate() is called when some changed. */
  refresh(games, onUpdate) {
    const now = Date.now();
    for (const g of games) {
      const t = target(g);
      if (!t) continue;
      const hit = this.store.sizes[t.key];
      if (hit && now - hit.at < MAX_AGE) continue;
      if (!this.queue.some((q) => q.t.key === t.key)) this.queue.push({ g, t });
    }
    if (!this.running && this.queue.length) this._run(onUpdate);
  }

  async _run(onUpdate) {
    this.running = true;
    let changed = 0;
    try {
      while (this.queue.length) {
        const { g, t } = this.queue.shift();
        let bytes = 0;
        try {
          bytes = t.file ? (await fsp.stat(t.path)).size : await this.measureFolder(t.path);
        } catch { bytes = 0; }
        this.store.sizes[t.key] = { bytes, at: Date.now() };
        if (bytes > 0) { g.sizeBytes = bytes; changed++; }
        if (changed && changed % 5 === 0 && onUpdate) onUpdate();
      }
    } finally {
      this.running = false;
      this.store.save('sizes', 2000);
      if (changed && onUpdate) onUpdate();
    }
  }
}

module.exports = { Sizes, folderSize, target };
