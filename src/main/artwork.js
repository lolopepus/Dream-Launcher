'use strict';
/**
 * Artwork resolver and cache.
 *
 * Order per game:
 *   Steam  -> Steam's own local library cache (flat, per-app and content-hashed folders)
 *          -> Steam CDN (fixed paths) -> Steam store header -> SteamGridDB (if a key is set)
 *   GOG    -> GOG's public catalogue API (box art, background, logo) -> SteamGridDB
 *   Xbox   -> images shipped with the game package (splash screen, square logo) -> SteamGridDB
 *   Others -> SteamGridDB (needs a free API key)
 * Logos (transparent game titles) come from Steam and GOG, otherwise from SteamGridDB.
 *
 * Images are stored in %APPDATA%\Dream Launcher\art and served to the UI as dl://art/<file>.
 */
const EventEmitter = require('events');
const path = require('path');
const crypto = require('crypto');
const fsp = require('fs').promises;
const { isFile, listDir } = require('./util/fsx');
const { isNetworkError } = require('./connectivity');

const INDEX_VERSION = 3;
// Entries written by these older versions are still valid; only missing pieces are fetched.
const COMPATIBLE_VERSIONS = [2, 3];
const RETRY_MS = 3 * 24 * 60 * 60 * 1000;

// Games whose store name has no SteamGridDB entry: the entry to use instead.
const SGDB_ALIASES = new Map([
  ['minecraft for windows', 'Minecraft'],
  ['minecraft for windows 10', 'Minecraft'],
  ['minecraft windows 10 edition', 'Minecraft'],
  ['minecraft: windows 10 edition', 'Minecraft'],
]);
// Raised when the names searched for change, so the games concerned are looked up again at once.
const SEARCH_V = 2;

/** The name to search SteamGridDB for. */
function sgdbName(name) {
  const key = String(name || '').replace(/[®™©]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return SGDB_ALIASES.get(key) || String(name || '');
}
const CONCURRENCY = 4;
const SGDB = 'https://www.steamgriddb.com/api/v2';

function fileBase(id) {
  const slug = String(id).replace(/[^A-Za-z0-9]+/g, '_').slice(0, 60);
  const hash = crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 8);
  return `${slug}-${hash}`;
}

function extFromType(type, url) {
  const t = String(type || '').toLowerCase();
  if (t.includes('jpeg') || t.includes('jpg')) return '.jpg';
  if (t.includes('png')) return '.png';
  if (t.includes('webp')) return '.webp';
  if (t.includes('gif')) return '.gif';
  const m = /\.(jpe?g|png|webp|gif)(?:\?|#|$)/i.exec(String(url || ''));
  if (m) return m[1].toLowerCase() === 'jpeg' ? '.jpg' : `.${m[1].toLowerCase()}`;
  return '.jpg';
}

function steamCdnUrls(appId, file) {
  return [
    `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appId}/${file}`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/${file}`,
  ];
}

/** Looks for a Steam library-cache file in all known layouts. */
async function findSteamCached(libraryCache, appId, names) {
  if (!libraryCache) return null;
  for (const n of names) {
    const flat = path.join(libraryCache, `${appId}_${n}`);
    if (await isFile(flat)) return flat;
  }
  const dir = path.join(libraryCache, String(appId));
  for (const n of names) {
    const p = path.join(dir, n);
    if (await isFile(p)) return p;
  }
  const subs = (await listDir(dir)).filter((e) => e.isDirectory() && /^[0-9a-f]{40}$/i.test(e.name));
  for (const n of names) {
    for (const s of subs) {
      const p = path.join(dir, s.name, n);
      if (await isFile(p)) return p;
    }
  }
  return null;
}

class Artwork extends EventEmitter {
  constructor({ store, fetch, log = console, isOnline = () => true }) {
    super();
    this.store = store;
    this.fetch = fetch;
    this.isOnline = isOnline;
    this.log = log;
    this.queue = [];
    this.queued = new Set();
    this.active = 0;
    this.ctx = { steamMeta: null, settings: null };
    this._emitTimer = null;
  }

  get dir() { return this.store.dirs.art; }

  /** Counts requests that failed for lack of a connection (not "picture not found"). */
  _noteFailure(err) {
    if (err && (err.offline || isNetworkError(err))) this.netFailures = (this.netFailures || 0) + 1;
  }

  urlFor(file, version) {
    if (!file) return null;
    return `dl://art/${encodeURIComponent(file)}${version ? `?v=${version}` : ''}`;
  }

  urlsFor(id, override = {}) {
    const e = this.store.artIndex[id] || {};
    const custom = (override && override.customArt) || {};
    const v = e.triedAt || 0;
    return {
      cover: custom.cover ? this.urlFor(custom.cover) : this.urlFor(e.cover, v),
      hero: custom.hero ? this.urlFor(custom.hero) : this.urlFor(e.hero, v),
      logo: custom.logo ? this.urlFor(custom.logo) : this.urlFor(e.logo, v),
      // The cover is not a 2:3 portrait (square logo or landscape header): show it "contained".
      coverFit: custom.cover ? 'cover' : (e.coverFit || 'cover'),
    };
  }

  needsWork(id, force, game) {
    if (force) return true;
    const e = this.store.artIndex[id];
    if (!e || e.v !== INDEX_VERSION) return true;
    // Already looked at offline: wait until online again.
    if (!this.isOnline() && !e.triedAt) return false;
    if (e.cover && e.hero && e.logo) return false;
    const hasKey = !!(this.ctx.settings && this.ctx.settings.sgdbApiKey);
    // Searched under another SteamGridDB name now (e.g. Minecraft for Windows): look again.
    if (hasKey && game && sgdbName(game.name) !== game.name && (e.searchV || 0) < SEARCH_V) return true;
    if (hasKey && !e.withSgdb) return true;
    if (e.cover && e.hero && !hasKey) return false;
    return Date.now() - (e.triedAt || 0) > RETRY_MS;
  }

  enqueue(games, ctx = {}, { force = false } = {}) {
    this.ctx = { ...this.ctx, ...ctx };
    for (const g of games) {
      if (!g || !g.id || this.queued.has(g.id)) continue;
      if (!this.needsWork(g.id, force, g)) continue;
      this.queued.add(g.id);
      this.queue.push({ game: g, force });
    }
    this._pump();
  }

  _pump() {
    while (this.active < CONCURRENCY && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      this._resolve(job.game, job.force)
        .catch((err) => this.log.warn('[artwork]', job.game.id, err && err.message))
        .finally(() => {
          this.active--;
          this.queued.delete(job.game.id);
          this._pump();
        });
    }
  }

  _changed() {
    this.store.save('artIndex', 1000);
    clearTimeout(this._emitTimer);
    this._emitTimer = setTimeout(() => this.emit('updated'), 700);
  }

  async _copyLocal(src, id, kind) {
    const dest = `${fileBase(id)}-${kind}${extFromType('', src)}`;
    await fsp.copyFile(src, path.join(this.dir, dest));
    return dest;
  }

  async _download(url, id, kind, headers) {
    if (!this.fetch || !url) return null;
    let res;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      res = await this.fetch(url, { headers: headers || {}, signal: ctrl.signal });
      if (!res || !res.ok) return null;
      const type = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
      if (type && !/^image\//i.test(type)) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024) return null;
      const dest = `${fileBase(id)}-${kind}${extFromType(type, url)}`;
      await fsp.writeFile(path.join(this.dir, dest), buf);
      return dest;
    } catch (err) {
      this._noteFailure(err);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async _firstDownload(urls, id, kind, headers) {
    for (const u of urls) {
      const f = await this._download(u, id, kind, headers);
      if (f) return f;
    }
    return null;
  }

  async _getJson(url, headers) {
    if (!this.fetch) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await this.fetch(url, { headers: headers || {}, signal: ctrl.signal });
      if (!res || !res.ok) return null;
      return await res.json();
    } catch (err) {
      this._noteFailure(err);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async _resolve(game, force) {
    const id = game.id;
    const old = this.store.artIndex[id];
    const prev = (!force && old && COMPATIBLE_VERSIONS.includes(old.v)) ? old : {};
    const entry = { cover: prev.cover || null, hero: prev.hero || null, logo: prev.logo || null, coverFit: prev.coverFit || 'cover' };
    const settings = this.ctx.settings || {};
    // Offline, only local pictures (Steam's own cache, Xbox package art) are used; the game is
    // looked at again once online.
    const online = this.isOnline();
    const failuresBefore = this.netFailures || 0;

    if (game.source === 'steam') await this._steam(game, entry);
    else if (game.source === 'gog') await this._gog(game, entry);
    else if (game.source === 'xbox') await this._xbox(game, entry);

    let withSgdb = false;
    if ((!entry.cover || !entry.hero || !entry.logo) && settings.sgdbApiKey && online) {
      withSgdb = true;
      await this._sgdb(game, entry, settings.sgdbApiKey);
    }
    // Only remember "looked for pictures" when the internet really answered.
    const complete = online && this.isOnline() && (this.netFailures || 0) === failuresBefore;
    this.store.artIndex[id] = {
      ...entry,
      v: INDEX_VERSION,
      triedAt: complete ? Date.now() : (prev.triedAt || 0),
      withSgdb: (withSgdb && complete) || !!prev.withSgdb,
      searchV: withSgdb && complete ? SEARCH_V : (prev.searchV || 0),
    };
    this._changed();
  }

  async _steam(game, entry) {
    const appId = game.sourceId;
    const lc = this.ctx.steamMeta && this.ctx.steamMeta.libraryCache;
    if (!entry.cover) {
      const local = await findSteamCached(lc, appId, ['library_600x900_2x.jpg', 'library_600x900.jpg', 'library_capsule_2x.jpg', 'library_capsule.jpg']);
      entry.cover = local ? await this._copyLocal(local, game.id, 'cover')
        : await this._firstDownload([...steamCdnUrls(appId, 'library_600x900_2x.jpg'), ...steamCdnUrls(appId, 'library_600x900.jpg')], game.id, 'cover');
      if (entry.cover) entry.coverFit = 'cover';
    }
    if (!entry.hero) {
      const local = await findSteamCached(lc, appId, ['library_hero_2x.jpg', 'library_hero.jpg']);
      entry.hero = local ? await this._copyLocal(local, game.id, 'hero')
        : await this._firstDownload(steamCdnUrls(appId, 'library_hero.jpg'), game.id, 'hero');
    }
    if (!entry.logo) {
      const local = await findSteamCached(lc, appId, ['logo_2x.png', 'logo.png']);
      entry.logo = local ? await this._copyLocal(local, game.id, 'logo')
        : await this._firstDownload(steamCdnUrls(appId, 'logo.png'), game.id, 'logo');
    }
    if (!entry.cover || !entry.hero) {
      // Newer apps publish art only under hashed paths; the store API returns the header URL.
      let header = await findSteamCached(lc, appId, ['header.jpg', 'library_header_2x.jpg', 'library_header.jpg']);
      let headerFile = header ? await this._copyLocal(header, game.id, 'header') : null;
      if (!headerFile) {
        const data = await this._getJson(`https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appId)}&filters=basic`);
        const info = data && data[appId] && data[appId].success ? data[appId].data : null;
        if (info && typeof info.header_image === 'string') headerFile = await this._download(info.header_image, game.id, 'header');
      }
      if (headerFile) {
        if (!entry.hero) entry.hero = headerFile;
        if (!entry.cover) { entry.cover = headerFile; entry.coverFit = 'contain'; }
      }
    }
  }

  async _gog(game, entry) {
    const data = await this._getJson(`https://api.gog.com/v2/games/${encodeURIComponent(game.sourceId)}?locale=en-US`);
    const links = data && data._links;
    if (!links) return;
    const href = (k) => {
      const v = links[k] && links[k].href;
      return typeof v === 'string' && v ? v.replace(/_?\{formatter\}/g, '') : null;
    };
    if (!entry.cover) {
      const f = await this._download(href('boxArtImage'), game.id, 'cover');
      if (f) { entry.cover = f; entry.coverFit = 'cover'; }
    }
    if (!entry.hero) entry.hero = await this._download(href('galaxyBackgroundImage') || href('backgroundImage'), game.id, 'hero');
    if (!entry.logo) entry.logo = await this._download(href('logo'), game.id, 'logo');
  }

  async _xbox(game, entry) {
    const art = game.localArt || {};
    if (!entry.hero && art.hero) entry.hero = await this._copyLocal(art.hero, game.id, 'hero').catch(() => null);
    if (!entry.cover && art.square) {
      const f = await this._copyLocal(art.square, game.id, 'cover').catch(() => null);
      if (f) { entry.cover = f; entry.coverFit = 'contain'; }
    }
    // Not installed: the box art from your Xbox history.
    if (!entry.cover && game.remoteArt && game.remoteArt.square) {
      const f = await this._download(game.remoteArt.square, game.id, 'cover');
      if (f) { entry.cover = f; entry.coverFit = 'contain'; }
    }
  }

  async _sgdbGameId(game, key) {
    if (!this.sgdbIds) this.sgdbIds = new Map();
    if (this.sgdbIds.has(game.id)) return this.sgdbIds.get(game.id);
    const headers = { Authorization: `Bearer ${key}` };
    let found = null;
    if (game.source === 'steam') {
      const d = await this._getJson(`${SGDB}/games/steam/${encodeURIComponent(game.sourceId)}`, headers);
      if (d && d.success && d.data && d.data.id) found = d.data.id;
    }
    if (!found) {
      // Store names like "… for Windows" often have no entry: then the plain name is tried.
      const names = [sgdbName(game.name)];
      const plain = names[0].replace(/\s*(?:for windows(?: 10| 11)?|windows(?: 10| 11)? edition|\(pc\)|pc edition)\s*$/i, '').trim();
      if (plain && plain !== names[0]) names.push(plain);
      for (const name of names) {
        const d = await this._getJson(`${SGDB}/search/autocomplete/${encodeURIComponent(name)}`, headers);
        if (d && d.success && Array.isArray(d.data) && d.data.length) { found = d.data[0].id; break; }
      }
    }
    if (found) this.sgdbIds.set(game.id, found);
    return found;
  }

  async sgdbList(game, kind, key) {
    const headers = { Authorization: `Bearer ${key}` };
    const gameId = await this._sgdbGameId(game, key);
    if (!gameId) return [];
    const endpoint = kind === 'hero' ? 'heroes' : kind === 'logo' ? 'logos' : 'grids';
    const dims = kind === 'cover' ? '&dimensions=600x900,660x930,342x482' : '';
    let d = await this._getJson(`${SGDB}/${endpoint}/game/${gameId}?nsfw=false&humor=false${dims}`, headers);
    if (!d || !d.success) d = await this._getJson(`${SGDB}/${endpoint}/game/${gameId}${dims ? `?${dims.slice(1)}` : ''}`, headers);
    if (!d || !d.success || !Array.isArray(d.data)) return [];
    return d.data
      .filter((x) => x && typeof x.url === 'string' && !x.nsfw && !x.humor)
      .filter((x) => !x.mime || /^image\/(png|jpeg|webp)$/i.test(x.mime))
      .slice(0, 30)
      .map((x) => ({ url: x.url, thumb: typeof x.thumb === 'string' ? x.thumb : x.url, width: x.width || 0, height: x.height || 0 }));
  }

  async _sgdb(game, entry, key) {
    if (!entry.cover || entry.coverFit === 'contain') {
      const list = await this.sgdbList(game, 'cover', key);
      const f = list.length ? await this._download(list[0].url, game.id, 'cover', {}) : null;
      if (f) { entry.cover = f; entry.coverFit = 'cover'; }
    }
    if (!entry.hero) {
      const list = await this.sgdbList(game, 'hero', key);
      if (list.length) entry.hero = await this._download(list[0].url, game.id, 'hero', {});
    }
    if (!entry.logo) {
      const list = await this.sgdbList(game, 'logo', key);
      if (list.length) entry.logo = await this._download(list[0].url, game.id, 'logo', {});
    }
  }

  /** Downloads a chosen image (e.g. from SteamGridDB) as the game's custom artwork. */
  async saveCustomFromUrl(id, kind, url) {
    const f = await this._download(url, id, `custom-${kind}-${Date.now()}`, {});
    if (!f) throw new Error('download failed');
    return f;
  }

  /** Copies a picked local image as the game's custom artwork. */
  async saveCustomFromFile(id, kind, filePath) {
    const ext = extFromType('', filePath);
    if (!['.jpg', '.png', '.webp', '.gif'].includes(ext)) throw new Error('unsupported image type');
    const dest = `${fileBase(id)}-custom-${kind}-${Date.now()}${ext}`;
    await fsp.copyFile(filePath, path.join(this.dir, dest));
    return dest;
  }

  async clearCache() {
    const keep = new Set();
    for (const o of Object.values(this.store.overrides)) {
      if (o && o.customArt) for (const f of Object.values(o.customArt)) keep.add(f);
    }
    const entries = await listDir(this.dir);
    for (const e of entries) {
      if (e.isFile() && !keep.has(e.name)) await fsp.unlink(path.join(this.dir, e.name)).catch(() => {});
    }
    this.store.artIndex = {};
    this.store.save('artIndex', 0);
  }
}

module.exports = {
  sgdbName, Artwork, findSteamCached, fileBase, extFromType, steamCdnUrls,
};
