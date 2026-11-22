'use strict';
/**
 * Persistent JSON storage in the user's data folder (%APPDATA%\Dream Launcher).
 * Writes are debounced and atomic. Every file is validated on load.
 */
const path = require('path');
const fsp = require('fs').promises;
const { readJson, writeJsonAtomic } = require('./util/fsx');
const { DEFAULT_SETTINGS, sanitizeSettings, migrateSettings, sanitizeOverrides } = require('./defaults');

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.dirs = {
      art: path.join(dataDir, 'art'),
      media: path.join(dataDir, 'media'),
      avatar: path.join(dataDir, 'avatar'),
      // Sharp screenshot previews, made once per size (see main.js).
      thumbs: path.join(dataDir, 'thumbs'),
    };
    this.settings = sanitizeSettings({});
    this.overrides = {};
    this.playtime = {};
    this.artIndex = {};
    this.libraryCache = null;
    this.steamWeb = {};
    this.xbox = {};
    this.update = {};
    this.device = null;
    this.sizes = {};
    this._timers = new Map();
    this._pending = new Map();
  }

  file(name) { return path.join(this.dataDir, name); }

  async load() {
    await fsp.mkdir(this.dataDir, { recursive: true });
    for (const d of Object.values(this.dirs)) await fsp.mkdir(d, { recursive: true });
    const rawSettings = await readJson(this.file('settings.json'));
    const migrated = migrateSettings(rawSettings);
    this.settings = sanitizeSettings(migrated.settings);
    if (migrated.changed) this.save('settings', 0);
    this.overrides = sanitizeOverrides(await readJson(this.file('overrides.json')));
    this.playtime = this._cleanPlaytime(await readJson(this.file('playtime.json')));
    const art = await readJson(this.file('artindex.json'));
    this.artIndex = art && typeof art === 'object' && !Array.isArray(art) ? art : {};
    const lib = await readJson(this.file('library-cache.json'));
    this.libraryCache = lib && Array.isArray(lib.games) ? lib : null;
    const sw = await readJson(this.file('steamweb.json'));
    this.steamWeb = sw && typeof sw === 'object' && !Array.isArray(sw) ? sw : {};
    const xb = await readJson(this.file('xbox.json'));
    this.xbox = xb && typeof xb === 'object' && !Array.isArray(xb) ? xb : {};
    const up = await readJson(this.file('update.json'));
    this.update = up && typeof up === 'object' && !Array.isArray(up) ? up : {};
    const dev = await readJson(this.file('device.json'));
    this.device = dev && typeof dev === 'object' && !Array.isArray(dev) ? dev : null;
    const sizes = await readJson(this.file('sizes.json'));
    this.sizes = sizes && typeof sizes === 'object' && !Array.isArray(sizes) ? sizes : {};
  }

  _cleanPlaytime(input) {
    const out = {};
    if (!input || typeof input !== 'object') return out;
    for (const [id, v] of Object.entries(input)) {
      if (!v || typeof v !== 'object') continue;
      const minutes = Number(v.minutes);
      const lastPlayed = Number(v.lastPlayed);
      out[id] = {
        minutes: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0,
        lastPlayed: Number.isFinite(lastPlayed) && lastPlayed > 0 ? lastPlayed : 0,
      };
    }
    return out;
  }

  /** Schedules a debounced write of one of the store's documents. */
  save(name, delay = 400) {
    const map = {
      settings: ['settings.json', () => this.settings],
      overrides: ['overrides.json', () => this.overrides],
      playtime: ['playtime.json', () => this.playtime],
      artIndex: ['artindex.json', () => this.artIndex],
      libraryCache: ['library-cache.json', () => this.libraryCache],
      steamWeb: ['steamweb.json', () => this.steamWeb],
      xbox: ['xbox.json', () => this.xbox],
      update: ['update.json', () => this.update],
      device: ['device.json', () => this.device],
      sizes: ['sizes.json', () => this.sizes],
    };
    const entry = map[name];
    if (!entry) throw new Error(`Unknown store document: ${name}`);
    clearTimeout(this._timers.get(name));
    const timer = setTimeout(() => {
      this._timers.delete(name);
      const p = writeJsonAtomic(this.file(entry[0]), entry[1]()).catch((err) => {
        console.error(`[store] failed to save ${entry[0]}:`, err && err.message);
      });
      this._pending.set(name, p);
      p.finally(() => { if (this._pending.get(name) === p) this._pending.delete(name); });
    }, delay);
    this._timers.set(name, timer);
  }

  /** Writes everything that is scheduled right now (used before quitting). */
  async flush() {
    const names = [...this._timers.keys()];
    for (const name of names) {
      clearTimeout(this._timers.get(name));
      this._timers.delete(name);
      this.save(name, 0);
    }
    await new Promise((r) => setTimeout(r, 5));
    await Promise.allSettled([...this._pending.values()]);
  }

  updateSettings(patch) {
    this.settings = sanitizeSettings(patch, this.settings);
    this.save('settings');
    return this.settings;
  }

  resetSettings() {
    this.settings = sanitizeSettings({}, DEFAULT_SETTINGS);
    this.save('settings', 0);
    return this.settings;
  }

  getOverride(id) { return this.overrides[id] || {}; }

  setOverride(id, patch) {
    const cur = { ...(this.overrides[id] || {}) };
    for (const [k, v] of Object.entries(patch || {})) {
      if (v === null || v === undefined || v === false || v === '') delete cur[k];
      else cur[k] = v;
    }
    const clean = sanitizeOverrides({ [id]: cur })[id];
    if (clean) this.overrides[id] = clean; else delete this.overrides[id];
    this.save('overrides');
    return this.overrides[id] || {};
  }

  addPlaytime(id, minutes, startedAt) {
    const cur = this.playtime[id] || { minutes: 0, lastPlayed: 0 };
    cur.minutes = Math.max(0, Math.round((cur.minutes || 0) + Math.max(0, minutes)));
    cur.lastPlayed = Math.max(cur.lastPlayed || 0, startedAt || 0);
    this.playtime[id] = cur;
    this.save('playtime');
  }

  markPlayed(id, when) {
    const cur = this.playtime[id] || { minutes: 0, lastPlayed: 0 };
    cur.lastPlayed = Math.max(cur.lastPlayed || 0, when || Date.now());
    this.playtime[id] = cur;
    this.save('playtime');
  }
}

module.exports = { Store };
