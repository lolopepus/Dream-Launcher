'use strict';
/**
 * Update check through GitHub Releases.
 *
 * Asks GitHub for the latest release of the launcher's repository (at most every 6 hours, or
 * when you press "Check for updates"). When it is newer than this version, the installer (.exe)
 * of that release can be downloaded here. It is checked against the SHA-256 that GitHub lists
 * for the file, then started the same way electron-builder's own updater does it
 * (silent, into the same folder, the launcher restarts afterwards).
 *
 * Releases must be tagged with the version (e.g. v2.3.0) and have the Setup .exe attached.
 */
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const API = 'https://api.github.com';

/** "v2.3.0" → [2, 3, 0]; anything after "-" (pre-release) is ignored. */
function parseVersion(v) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/i.exec(String(v || '').trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
}

/** > 0 when a is newer than b. */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** The installer of a release: an .exe from this repository's release downloads. */
function pickAsset(release, repo) {
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  const prefix = `https://github.com/${repo}/releases/download/`.toLowerCase();
  const exes = assets.filter((a) => a && /\.exe$/i.test(String(a.name || ''))
    && String(a.browser_download_url || '').toLowerCase().startsWith(prefix)
    && Number(a.size) > 1024 * 1024);
  const a = exes.find((x) => /setup/i.test(x.name)) || exes[0];
  if (!a) return null;
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(String(a.digest || ''));
  return {
    name: String(a.name).replace(/[\\/:*?"<>|]/g, '_'),
    size: Number(a.size),
    url: String(a.browser_download_url),
    sha256: digest ? digest[1].toLowerCase() : '',
  };
}

function parseRelease(release, repo) {
  if (!release || release.draft || release.prerelease) return null;
  const version = parseVersion(release.tag_name);
  if (!version) return null;
  const html = String(release.html_url || '');
  return {
    version: version.join('.'),
    tag: String(release.tag_name),
    name: String(release.name || release.tag_name),
    notes: String(release.body || '').slice(0, 4000),
    url: html.toLowerCase().startsWith(`https://github.com/${repo}/`.toLowerCase()) ? html : `https://github.com/${repo}/releases/latest`,
    publishedAt: Date.parse(release.published_at) || 0,
    asset: pickAsset(release, repo),
  };
}

class Updater extends EventEmitter {
  constructor({ repo, currentVersion, fetch, store, tempDir, log = console, now = Date.now }) {
    super();
    this.repo = repo;
    this.current = currentVersion;
    this.fetch = fetch;
    this.store = store;
    this.tempDir = tempDir;
    this.log = log;
    this.now = now;
    const saved = store.update && typeof store.update === 'object' ? store.update : {};
    this.state = {
      status: 'idle',
      current: currentVersion,
      latest: saved.latest && compareVersions(saved.latest.version, currentVersion) > 0 ? saved.latest : null,
      checkedAt: saved.checkedAt || 0,
      progress: null,
      error: null,
    };
    if (this.state.latest) this.state.status = 'available';
    this.file = null;
    this.fileVersion = null;
    this.busy = null;
  }

  snapshot() { return { ...this.state, latest: this.state.latest ? { ...this.state.latest } : null }; }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('change', this.snapshot());
  }

  _save() {
    this.store.update = { ...(this.store.update || {}), checkedAt: this.state.checkedAt, latest: this.state.latest };
    this.store.save('update', 500);
  }

  /** Has this newer version been announced already? (Only tell once per version.) */
  shouldAnnounce() {
    const l = this.state.latest;
    if (!l || this.state.status === 'upToDate') return false;
    return (this.store.update && this.store.update.announced) !== l.version;
  }

  markAnnounced() {
    if (!this.state.latest) return;
    this.store.update = { ...(this.store.update || {}), announced: this.state.latest.version };
    this.store.save('update', 500);
  }

  /** Looks for a newer release. force: even if it was checked recently. */
  check({ force = false } = {}) {
    if (this.busy) return this.busy;
    if (!force && this.now() - this.state.checkedAt < CHECK_EVERY_MS) return Promise.resolve(this.snapshot());
    this.busy = this._check().finally(() => { this.busy = null; });
    return this.busy;
  }

  async _check() {
    // A download in progress or finished is kept, unless an even newer version came out meanwhile.
    const keep = ['downloading', 'ready'].includes(this.state.status) ? this.state.status : null;
    const keptVersion = this.fileVersion || (this.state.latest && this.state.latest.version);
    if (!keep) this._set({ status: 'checking', error: null });
    try {
      const res = await this.fetch(`${API}/repos/${this.repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      });
      let latest = null;
      if (res.status === 404) {
        latest = null; // no release published yet
      } else if (!res.ok) {
        throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      } else {
        latest = parseRelease(await res.json(), this.repo);
      }
      const newer = latest && compareVersions(latest.version, this.current) > 0 ? latest : null;
      this.state.checkedAt = this.now();
      if (keep === 'ready' && newer && newer.version !== keptVersion) {
        // The downloaded installer is for an older version than the one now out: forget it.
        this.file = null;
        this.fileVersion = null;
        this._set({ latest: newer, status: 'available', progress: null, error: null });
      } else {
        this._set({ latest: newer, status: keep || (newer ? 'available' : 'upToDate'), error: null });
      }
      this._save();
    } catch (err) {
      const offline = !!(err && err.offline);
      this.log.warn && this.log.warn('[update] check failed:', err && err.message);
      this._set({ status: keep || (this.state.latest ? 'available' : 'error'), error: offline ? 'offline' : (err && err.status === 403 ? 'rateLimited' : 'failed') });
    }
    return this.snapshot();
  }

  /** Downloads the installer of the newer version and checks it. */
  download() {
    if (this.busy && this.state.status === 'downloading') return this.busy;
    const latest = this.state.latest;
    if (!latest || !latest.asset) return Promise.resolve({ error: latest ? 'noInstaller' : 'noUpdate' });
    this.busy = this._download(latest).finally(() => { this.busy = null; });
    return this.busy;
  }

  async _download(latest) {
    const asset = latest.asset;
    const dir = path.join(this.tempDir, 'Dream Launcher Update');
    const dest = path.join(dir, asset.name);
    const part = `${dest}.part`;
    this._set({ status: 'downloading', progress: { received: 0, total: asset.size }, error: null });
    let out = null;
    try {
      await fsp.mkdir(dir, { recursive: true });
      const res = await this.fetch(asset.url, { headers: { Accept: 'application/octet-stream' } });
      if (!res.ok || !res.body) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      const hash = crypto.createHash('sha256');
      out = fs.createWriteStream(part);
      const reader = res.body.getReader();
      let received = 0;
      let lastEmit = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        hash.update(chunk);
        received += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        if (this.now() - lastEmit > 250) {
          lastEmit = this.now();
          this._set({ progress: { received, total: asset.size } });
        }
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      out = null;
      if (received !== asset.size) throw Object.assign(new Error('size mismatch'), { code: 'incomplete' });
      const sum = hash.digest('hex');
      if (asset.sha256 && sum !== asset.sha256) throw Object.assign(new Error('checksum mismatch'), { code: 'checksum' });
      await fsp.rm(dest, { force: true });
      await fsp.rename(part, dest);
      this.file = dest;
      this.fileVersion = latest.version;
      this._set({ status: 'ready', progress: { received, total: asset.size } });
      return { ok: true, verified: !!asset.sha256 };
    } catch (err) {
      if (out) out.destroy();
      await fsp.rm(part, { force: true }).catch(() => {});
      const code = err && err.offline ? 'offline' : (err && err.code) || 'failed';
      this.log.warn && this.log.warn('[update] download failed:', err && err.message);
      this._set({ status: 'available', progress: null, error: code });
      return { error: code };
    }
  }

  /** The downloaded installer, if it is still there. */
  readyFile() {
    if (this.state.status !== 'ready' || !this.file) return null;
    try { return fs.statSync(this.file).isFile() ? this.file : null; } catch { return null; }
  }
}

module.exports = { Updater, parseVersion, compareVersions, parseRelease, pickAsset, CHECK_EVERY_MS };
