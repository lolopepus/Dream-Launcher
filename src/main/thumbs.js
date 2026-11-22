'use strict';
/**
 * Sharp screenshot previews at the size the window shows them. Steam's own thumbnails are only
 * about 200 px wide, which looks blurry on large gallery tiles. Each preview is made once per
 * width bucket and kept on disk (the "thumbs" folder), keyed by file and modification time.
 */
const path = require('path');
const fsp = require('fs').promises;

const SIZES = [480, 640, 960, 1280, 1600];
const MEMORY_ITEMS = 240;

/** The width bucket for an asked width (few sizes, so previews can be reused). */
function bucket(raw) {
  const w = Number(raw) || 640;
  return SIZES.find((x) => x >= w) || SIZES[SIZES.length - 1];
}

class Thumbs {
  /**
   * @param {{ dir: string, nativeImage: object, parallel?: number }} opts
   *   nativeImage: Electron's nativeImage (createThumbnailFromPath / createFromPath).
   */
  constructor({ dir, nativeImage, parallel = 2 }) {
    this.dir = dir;
    this.nativeImage = nativeImage;
    this.parallel = parallel;
    this.memory = new Map(); // key -> Buffer
    this.pending = new Map(); // key -> Promise (the same preview asked for twice at once)
    this.running = 0;
    this.waiting = [];
  }

  /** JPEG bytes of a preview `width` (bucketed) wide, or null if the picture can't be read. */
  get(id, file, mtime, width) {
    const w = bucket(width);
    const key = `${id}-${Math.round(mtime || 0)}-${w}`;
    if (this.memory.has(key)) return Promise.resolve(this.memory.get(key));
    if (this.pending.has(key)) return this.pending.get(key);
    const job = this._load(key, file, w).finally(() => this.pending.delete(key));
    this.pending.set(key, job);
    return job;
  }

  async _load(key, file, width) {
    const cached = path.join(this.dir, `${key}.jpg`);
    let buf = null;
    try { buf = await fsp.readFile(cached); } catch { buf = null; }
    if (!buf) {
      // A few at a time, so scrolling through many screenshots doesn't hold up the app.
      await this._slot();
      try {
        buf = await this._make(file, width);
      } finally {
        this._release();
      }
      if (buf) fsp.writeFile(cached, buf).catch(() => {});
    }
    if (buf) {
      this.memory.set(key, buf);
      if (this.memory.size > MEMORY_ITEMS) this.memory.delete(this.memory.keys().next().value);
    }
    return buf;
  }

  async _make(file, width) {
    const ni = this.nativeImage;
    try {
      let img = null;
      if (ni && typeof ni.createThumbnailFromPath === 'function') {
        img = await ni.createThumbnailFromPath(file, { width, height: Math.round((width * 9) / 16) }).catch(() => null);
        if (img && img.isEmpty()) img = null;
        // Windows may hand back a smaller cached preview: then the picture itself is decoded.
        if (img && img.getSize().width < width * 0.7) img = null;
        else if (img && img.getSize().width > width * 1.3) img = img.resize({ width, quality: 'best' });
      }
      if (!img) {
        await new Promise((r) => setImmediate(r));
        const full = ni.createFromPath(file);
        if (full.isEmpty()) return null;
        img = full.getSize().width > width ? full.resize({ width, quality: 'best' }) : full;
      }
      return img.isEmpty() ? null : img.toJPEG(86);
    } catch {
      return null;
    }
  }

  _slot() {
    if (this.running < this.parallel) { this.running++; return Promise.resolve(); }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  _release() {
    const next = this.waiting.shift();
    if (next) next(); // the slot passes straight to the next one
    else this.running--;
  }

  /** Keeps the folder from growing forever: the oldest previews go first. */
  async prune(max = 1500) {
    let names;
    try { names = (await fsp.readdir(this.dir)).filter((n) => n.endsWith('.jpg')); } catch { return 0; }
    if (names.length <= max) return 0;
    const stats = await Promise.all(names.map(async (n) => {
      try { return { n, t: (await fsp.stat(path.join(this.dir, n))).mtimeMs }; } catch { return { n, t: 0 }; }
    }));
    stats.sort((a, b) => a.t - b.t);
    const old = stats.slice(0, names.length - max);
    for (const { n } of old) await fsp.rm(path.join(this.dir, n), { force: true }).catch(() => {});
    return old.length;
  }
}

module.exports = { Thumbs, bucket, SIZES };
