'use strict';
/**
 * The library: runs all store scanners, merges results with user data (favorites, hidden,
 * subscriptions, tracked playtime, artwork) and produces the list the interface shows.
 */
const EventEmitter = require('events');
const { createRegistryReader } = require('./util/registry');
const { scanSteam, refreshDownloading } = require('./sources/steam');
const { scanEpic } = require('./sources/epic');
const { scanGog } = require('./sources/gog');
const { scanUbisoft } = require('./sources/ubisoft');
const { scanXbox } = require('./sources/xbox');
const { scanEmulators } = require('./sources/emulators');
const { scanManual } = require('./sources/manual');
const { Sizes } = require('./sizes');
const { looseName } = require('./xboxlive');

const SCANNERS = {
  steam: scanSteam,
  epic: scanEpic,
  gog: scanGog,
  ubisoft: scanUbisoft,
  xbox: scanXbox,
  emulators: scanEmulators,
  manual: scanManual,
};

const REGISTRY_KEYS = [
  ['HKEY_CURRENT_USER\\Software\\Valve\\Steam', 0],
  ['HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 0],
  ['HKEY_LOCAL_MACHINE\\SOFTWARE\\Valve\\Steam', 0],
  ['HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Epic Games\\EpicGamesLauncher', 0],
  ['HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games', 1],
  ['HKEY_LOCAL_MACHINE\\SOFTWARE\\GOG.com\\Games', 1],
  ['HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\GalaxyClient', 1],
  ['HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher', 2],
  ['HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 1, 'Uplay Install'],
  ['HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 1, 'Uplay Install'],
];

const OWNED_CACHE_MS = 6 * 60 * 60 * 1000;

function sortName(name) {
  return String(name || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/^(the|a|an)\s+/i, '')
    .toLowerCase();
}

class Library extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('./store').Store} deps.store
   * @param {(opts:object)=>Promise<{registry:object, appx:any[], battery:number|null}>} deps.probe
   * @param {object} deps.artwork   Artwork resolver (urlsFor, enqueue)
   * @param {object} deps.steamWeb  Steam Web API client
   * @param {object} [deps.env]
   */
  constructor({ store, probe, artwork, steamWeb, xbox = null, isOnline = () => true, env = process.env, log = console }) {
    super();
    this.store = store;
    this.probe = probe;
    this.artwork = artwork;
    this.steamWeb = steamWeb;
    this.xbox = xbox;
    this.isOnline = isOnline;
    this.env = env;
    this.log = log;
    this.raw = [];
    this.byId = new Map();
    this.sourceStatus = {};
    this.steamMeta = null;
    this.hasBattery = null;
    this.running = new Set();
    this.scanning = null;
    this.lastScanAt = 0;
    this._emitTimer = null;
    this.sizes = new Sizes({ store, log });
    if (store.libraryCache && Array.isArray(store.libraryCache.games)) {
      this.sizes.apply(store.libraryCache.games);
      this._setRaw(store.libraryCache.games);
      this.sourceStatus = store.libraryCache.sourceStatus || {};
      // The Steam account from the last scan, so Steam features work right after start-up.
      const m = store.libraryCache.steamMeta;
      if (m && m.user && m.user.id64) this.steamMeta = { steamPath: m.steamPath || '', user: m.user };
    }
    if (this.artwork && this.artwork.on) this.artwork.on('updated', () => this.emitUpdated());
  }

  _setRaw(games) {
    this.raw = games;
    this.byId = new Map(games.map((g) => [g.id, g]));
  }

  get(id) { return this.byId.get(id) || null; }

  emitUpdated(delay = 600) {
    clearTimeout(this._emitTimer);
    this._emitTimer = setTimeout(() => this.emit('updated'), delay);
  }

  scan(reason = 'manual') {
    if (this.scanning) return this.scanning;
    this.scanning = this._scan(reason).finally(() => { this.scanning = null; });
    return this.scanning;
  }

  async _scan() {
    const settings = this.store.settings;
    const probeData = await this.probe({
      registry: REGISTRY_KEYS,
      appx: !!settings.sources.xbox,
      battery: this.hasBattery === null,
    });
    if (typeof probeData.battery === 'number') this.hasBattery = probeData.battery > 0;
    const ctx = {
      reg: createRegistryReader(probeData.registry),
      env: this.env,
      appx: probeData.appx,
      settings,
    };
    const status = {};
    const all = [];
    let steamMeta = null;
    await Promise.all(Object.entries(SCANNERS).map(async ([name, fn]) => {
      if (!settings.sources[name]) { status[name] = { enabled: false, available: false, count: 0 }; return; }
      try {
        const res = await fn(ctx);
        status[name] = { enabled: true, available: !!res.available, count: res.games.length };
        if (res.status) status[name].details = res.status;
        if (name === 'steam') steamMeta = res.meta;
        all.push(...res.games);
      } catch (err) {
        this.log.error(`[library] ${name} scan failed:`, err && err.message);
        status[name] = { enabled: true, available: false, count: 0, error: String(err && err.message || err) };
      }
    }));

    if (settings.sources.steam) await this._mergeSteamOwned(all, steamMeta, status);
    if (settings.sources.xbox) await this._mergeXbox(all, status);

    // Keep a stable, unique list.
    const seen = new Set();
    const games = [];
    for (const g of all) {
      if (!g || !g.id || seen.has(g.id)) continue;
      seen.add(g.id);
      games.push(g);
    }
    this.steamMeta = steamMeta;
    this.sourceStatus = status;
    this.sizes.apply(games);
    this._setRaw(games);
    this.lastScanAt = Date.now();
    const user = steamMeta && steamMeta.user;
    this.store.libraryCache = {
      savedAt: this.lastScanAt, games, sourceStatus: status,
      steamMeta: user && user.id64 ? { steamPath: steamMeta.steamPath || '', user: { id64: user.id64, accountId: user.accountId, personaName: user.personaName } } : null,
    };
    this.store.save('libraryCache', 1500);
    this.emit('updated');
    if (this.artwork) this.artwork.enqueue(games, { steamMeta, settings });
    // Sizes for games whose store doesn't report one (measured in the background).
    this.sizes.refresh(games, () => this.emitUpdated(1500));
    return this.list();
  }

  steamId() {
    const s = this.store.settings;
    if (s.steamId) return s.steamId;
    const user = this.steamMeta && this.steamMeta.user;
    return user ? user.id64 : '';
  }

  async _mergeSteamOwned(all, steamMeta, status) {
    const s = this.store.settings;
    const key = s.steamApiKey;
    const steamId = s.steamId || (steamMeta && steamMeta.user && steamMeta.user.id64) || '';
    if (!key || !steamId || !this.steamWeb) return;
    let owned = null;
    const cache = this.store.steamWeb.owned;
    const fresh = cache && cache.steamId === steamId && Date.now() - cache.fetchedAt < OWNED_CACHE_MS;
    if (cache && cache.steamId === steamId && Array.isArray(cache.games) && (fresh || !this.isOnline())) {
      // Offline: the list from the last time online is used.
      owned = cache.games;
    } else {
      try {
        owned = await this.steamWeb.ownedGames(key, steamId);
        this.store.steamWeb.owned = { steamId, fetchedAt: Date.now(), games: owned };
        this.store.save('steamWeb');
      } catch (err) {
        this.log.warn('[library] Steam owned games failed:', err && err.message);
        owned = cache && Array.isArray(cache.games) ? cache.games : null;
      }
    }
    if (!owned) return;
    const installed = new Map(all.filter((g) => g.source === 'steam').map((g) => [g.sourceId, g]));
    let added = 0;
    for (const o of owned) {
      const appId = String(o.appid);
      const local = installed.get(appId);
      if (local) {
        local.playtimeMinutes = Math.max(local.playtimeMinutes || 0, Number(o.playtime_forever) || 0);
        const lp = (Number(o.rtime_last_played) || 0) * 1000;
        if (lp > (local.lastPlayed || 0)) local.lastPlayed = lp;
        continue;
      }
      if (!s.showUninstalledSteam || !o.name) continue;
      all.push({
        id: `steam:${appId}`,
        source: 'steam',
        sourceId: appId,
        name: String(o.name),
        installed: false,
        status: 'notInstalled',
        progress: null,
        installDir: null,
        sizeBytes: 0,
        playtimeMinutes: Number(o.playtime_forever) || 0,
        lastPlayed: (Number(o.rtime_last_played) || 0) * 1000,
        launch: { type: 'url', url: `steam://install/${appId}` },
        install: { type: 'url', url: `steam://install/${appId}` },
        client: { type: 'url', url: `steam://nav/games/details/${appId}` },
        tracksOwnPlaytime: true,
      });
      added++;
    }
    if (status.steam) status.steam.owned = added;
  }

  /**
   * Playtime, last played and achievement progress of Xbox games from the Xbox network
   * (OpenXBL key in Options). Offline, the values from the last sync are used.
   */
  async _mergeXbox(all, status) {
    const key = this.store.settings.xblApiKey;
    if (!key || !this.xbox) return;
    const local = all.filter((g) => g.source === 'xbox');
    if (!local.length) {
      if (this.store.settings.showUninstalledXbox) {
        try { await this.xbox.account(key); } catch { /* offline or bad key: history is from the cache */ }
        await this._addXboxHistory(all, local, key, status);
      }
      return;
    }
    let info;
    try {
      info = await this.xbox.libraryInfo(key, local.map((g) => ({ id: g.id, pfn: g.sourceId, titleId: g.xboxTitleId || '', name: g.name })), { refresh: this.isOnline() });
    } catch (err) {
      if (!(err && err.offline)) this.log.warn('[library] Xbox sync failed:', err && err.message);
      try { info = await this.xbox.libraryInfo(key, local.map((g) => ({ id: g.id, pfn: g.sourceId, titleId: g.xboxTitleId || '', name: g.name })), { refresh: false }); } catch { info = null; }
      if (status.xbox && err && err.auth) status.xbox.onlineError = 'auth';
    }
    if (!info) info = new Map();
    for (const g of local) {
      const x = info.get(g.id);
      if (!x) continue;
      g.xboxTitleId = x.titleId;
      if (x.lastPlayed) g.lastPlayed = Math.max(g.lastPlayed || 0, x.lastPlayed);
      if (Number.isFinite(x.minutes)) {
        g.playtimeMinutes = x.minutes;
        g.playtimeSource = 'xbox';
        // The Xbox network counts all play, also the sessions started here.
        g.tracksOwnPlaytime = true;
      }
      if (x.ach && x.ach.total > 0) g.xboxAchievements = { unlocked: x.ach.unlocked, total: x.ach.total, gamerscore: x.ach.gamerscore, gamerscoreTotal: x.ach.gamerscoreTotal };
    }
    if (status.xbox) status.xbox.online = info.size;
    if (this.store.settings.showUninstalledXbox) await this._addXboxHistory(all, local, key, status);
  }

  /**
   * Xbox PC games you played before but that are not installed here (from your Xbox history),
   * shown in the library only. Install opens the game's page in the Microsoft Store.
   */
  async _addXboxHistory(all, local, key, status) {
    const exclude = new Set(local.map((g) => g.xboxTitleId).filter(Boolean));
    let history;
    try {
      history = await this.xbox.historyGames(key, exclude, { refresh: this.isOnline() });
    } catch {
      try { history = await this.xbox.historyGames(key, exclude, { refresh: false }); } catch { history = []; }
    }
    // The same game from another store already in the list (e.g. a Steam version): skip it.
    const names = new Set(all.map((g) => looseName(g.name)));
    let added = 0;
    for (const t of history) {
      if (names.has(looseName(t.name))) continue;
      names.add(looseName(t.name));
      const store = t.productId
        ? `ms-windows-store://pdp/?ProductId=${t.productId}`
        : `ms-windows-store://search/?query=${encodeURIComponent(t.name)}`;
      all.push({
        id: `xbox:title:${t.titleId}`,
        source: 'xbox',
        sourceId: t.pfn || `title:${t.titleId}`,
        name: t.name,
        installed: false,
        status: 'notInstalled',
        progress: null,
        installDir: null,
        sizeBytes: 0,
        playtimeMinutes: Number.isFinite(t.minutes) ? t.minutes : 0,
        playtimeSource: Number.isFinite(t.minutes) ? 'xbox' : null,
        lastPlayed: t.lastPlayed || 0,
        launch: { type: 'url', url: store },
        install: { type: 'url', url: store },
        client: null,
        tracksOwnPlaytime: true,
        xboxTitleId: t.titleId,
        xboxAchievements: t.ach && t.ach.total > 0 ? { unlocked: t.ach.unlocked, total: t.ach.total, gamerscore: t.ach.gamerscore, gamerscoreTotal: t.ach.gamerscoreTotal } : null,
        remoteArt: t.image ? { square: t.image } : null,
      });
      added++;
    }
    if (status.xbox) status.xbox.owned = added;
  }

  /** Cheap progress refresh for Steam downloads. Returns true if anything changed. */
  async refreshDownloads() {
    const active = this.raw.filter((g) => g.source === 'steam' && (g.status === 'installing' || g.status === 'updating'));
    if (!active.length) return false;
    const updates = await refreshDownloading(active);
    let changed = false;
    for (const u of updates) {
      const g = this.byId.get(u.id);
      if (!g) continue;
      if (u.removed) continue;
      for (const k of ['status', 'progress', 'installed', 'sizeBytes']) {
        if (g[k] !== u[k]) { g[k] = u[k]; changed = true; }
      }
    }
    if (changed) this.emit('updated');
    return changed;
  }

  hasActiveDownloads() {
    return this.raw.some((g) => g.source === 'steam' && (g.status === 'installing' || g.status === 'updating'));
  }

  setRunning(id, running) {
    if (running) this.running.add(id); else this.running.delete(id);
    this.emit('updated');
  }

  sourceLabel(g) {
    switch (g.source) {
      case 'steam': return 'Steam';
      case 'epic': return 'Epic Games';
      case 'gog': return 'GOG';
      case 'ubisoft': return 'Ubisoft Connect';
      case 'xbox': return 'Xbox';
      case 'emulators': return g.emulatorName || 'Emulator';
      case 'manual': return 'PC';
      default: return g.source;
    }
  }

  toPublic(g) {
    const ov = this.store.getOverride(g.id);
    const tracked = this.store.playtime[g.id];
    let playtime = g.playtimeMinutes || 0;
    let lastPlayed = g.lastPlayed || 0;
    let dayOnly = !!g.lastPlayedDayOnly && lastPlayed > 0;
    // Who really knows the playtime: Steam, Cemu or the Xbox network. Otherwise only the time
    // counted while games were started from here is known.
    const source = g.source === 'steam' ? 'steam' : (g.playtimeSource || null);
    if (tracked) {
      if (!g.tracksOwnPlaytime) playtime += tracked.minutes || 0;
      if ((tracked.lastPlayed || 0) > lastPlayed) { lastPlayed = tracked.lastPlayed; dayOnly = false; }
    }
    const running = this.running.has(g.id);
    const art = this.artwork ? this.artwork.urlsFor(g.id, ov) : {};
    return {
      id: g.id,
      source: g.source,
      sourceLabel: this.sourceLabel(g),
      name: g.name,
      sortName: sortName(g.name),
      installed: !!g.installed,
      status: running ? 'running' : g.status,
      progress: typeof g.progress === 'number' ? g.progress : null,
      sizeBytes: g.sizeBytes || 0,
      playtimeMinutes: playtime,
      lastPlayed,
      lastPlayedDayOnly: dayOnly,
      playtimeKnown: !!source,
      playtimeSource: source || (playtime > 0 ? 'tracked' : null),
      lastBooted: (tracked && tracked.lastPlayed) || 0,
      firstPlayed: g.firstPlayed || 0,
      xboxTitleId: g.xboxTitleId || '',
      xboxAchievements: g.xboxAchievements || null,
      platform: g.platform || '',
      installPath: g.installed ? (g.romPath || g.installDir || '') : '',
      favorite: !!ov.favorite,
      hidden: !!ov.hidden,
      subscription: ov.subscription || null,
      art,
      actions: {
        play: !!g.installed && g.status !== 'missing' && !!g.launch && g.status !== 'notInstalled',
        install: g.status === 'notInstalled' && !!g.install,
        update: g.status === 'updateRequired' && !!g.update,
        checkUpdates: !!g.updateIsManual && !!g.update,
        openClient: !!g.client,
        showFolder: !!g.installDir && g.installed,
        editable: g.source === 'manual',
        removable: g.source === 'manual',
      },
    };
  }

  list() {
    return this.raw.map((g) => this.toPublic(g));
  }

  snapshot() {
    return {
      games: this.list(),
      sources: this.sourceStatus,
      scanning: !!this.scanning,
      lastScanAt: this.lastScanAt,
    };
  }
}

module.exports = { Library, REGISTRY_KEYS, sortName };
