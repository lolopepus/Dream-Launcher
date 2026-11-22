'use strict';
/**
 * Steam Web API client (needs the user's own free API key from steamcommunity.com/dev/apikey).
 * Used for: owned (uninstalled) games, achievements of the selected game, friends who played it,
 * and the profile name/avatar.
 */
const API = 'https://api.steampowered.com';
const FRIENDS_TTL = 24 * 60 * 60 * 1000;
const FRIENDS_FORMAT = 3;
const FRIEND_ACH_TTL = 30 * 60 * 1000;
const FRIEND_ACH_MAX = 20;
const ACH_TTL = 10 * 60 * 1000;
const SCHEMA_TTL = 24 * 60 * 60 * 1000;
const LIVE_TTL = 60 * 1000;
const STEAM_LANG = { en: 'english', de: 'german', pl: 'polish' };

function steamLang(lang) {
  return STEAM_LANG[String(lang || 'en').split('-')[0]] || 'english';
}

function httpsOrEmpty(u) {
  return typeof u === 'string' && /^https:\/\//.test(u) ? u : '';
}

/**
 * Combines the player's achievement list with the game's schema (names, icons) and the global
 * unlock percentages. Unlocked first (newest first), then locked (most common first).
 */
function mergeAchievements(player, schema, percents) {
  const list = Array.isArray(player) ? player : [];
  const sch = schema || {};
  const pct = percents || {};
  const items = list
    .filter((a) => a && typeof a.apiname === 'string')
    .map((a) => {
      const meta = sch[a.apiname] || {};
      const achieved = Number(a.achieved) === 1;
      const p = Number(pct[a.apiname]);
      return {
        id: a.apiname,
        name: (typeof a.name === 'string' && a.name) || meta.name || a.apiname,
        desc: (typeof a.description === 'string' && a.description) || meta.desc || '',
        icon: httpsOrEmpty(achieved ? (meta.icon || meta.iconGray) : (meta.iconGray || meta.icon)),
        hidden: !!meta.hidden,
        achieved,
        unlockTime: achieved ? (Number(a.unlocktime) || 0) * 1000 : 0,
        percent: Number.isFinite(p) ? Math.round(p * 10) / 10 : null,
      };
    });
  items.sort((x, y) => {
    if (x.achieved !== y.achieved) return x.achieved ? -1 : 1;
    if (x.achieved) return y.unlockTime - x.unlockTime;
    return (y.percent ?? -1) - (x.percent ?? -1);
  });
  return { unlocked: items.filter((i) => i.achieved).length, total: items.length, items };
}

class SteamWeb {
  constructor({ store, fetch, log = console, onFriendsBuilt = null }) {
    this.store = store;
    this.fetch = fetch;
    this.log = log;
    this.onFriendsBuilt = onFriendsBuilt;
    this.achCache = new Map();
    this.schemaCache = new Map();
    this.percentCache = new Map();
    this.liveCache = new Map();
    this.friendAchCache = new Map();
    this.friendsBuilding = null;
  }

  async _get(url, { timeoutMs = 15000 } = {}) {
    if (!this.fetch) throw new Error('no network');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetch(url, { signal: ctrl.signal });
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      return { ok: !!(res && res.ok), status: res ? res.status : 0, body };
    } finally {
      clearTimeout(timer);
    }
  }

  async ownedGames(key, steamId) {
    const url = `${API}/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(steamId)}&include_appinfo=1&include_played_free_games=1&format=json`;
    const r = await this._get(url, { timeoutMs: 30000 });
    if (!r.ok || !r.body || !r.body.response) throw new Error(`Steam API error ${r.status}`);
    const games = Array.isArray(r.body.response.games) ? r.body.response.games : [];
    return games
      .filter((g) => g && g.appid)
      .map((g) => ({
        appid: g.appid,
        name: typeof g.name === 'string' ? g.name : '',
        playtime_forever: Number(g.playtime_forever) || 0,
        playtime_2weeks: Number(g.playtime_2weeks) || 0,
        rtime_last_played: Number(g.rtime_last_played) || 0,
      }));
  }

  async playerSummaries(key, ids) {
    const out = new Map();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const r = await this._get(`${API}/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(key)}&steamids=${chunk.join(',')}`);
      const players = r.ok && r.body && r.body.response && Array.isArray(r.body.response.players) ? r.body.response.players : [];
      for (const p of players) {
        out.set(String(p.steamid), {
          name: typeof p.personaname === 'string' ? p.personaname : '',
          avatar: typeof p.avatarmedium === 'string' ? p.avatarmedium : (typeof p.avatar === 'string' ? p.avatar : ''),
          avatarFull: typeof p.avatarfull === 'string' ? p.avatarfull : '',
          gameId: p.gameid ? String(p.gameid) : '',
          gameName: typeof p.gameextrainfo === 'string' ? p.gameextrainfo : '',
          state: Number(p.personastate) || 0,
          lastOnline: (Number(p.lastlogoff) || 0) * 1000,
        });
      }
    }
    return out;
  }

  /** Checks a key + SteamID combination. Returns { ok, name } or { ok:false, error }. */
  async test(key, steamId) {
    if (!key) return { ok: false, error: 'noKey' };
    if (!steamId) return { ok: false, error: 'noSteamId' };
    try {
      const map = await this.playerSummaries(key, [steamId]);
      const me = map.get(String(steamId));
      if (!me) return { ok: false, error: 'invalid' };
      return { ok: true, name: me.name, avatar: me.avatarFull || me.avatar };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  }

  /** Achievement names, descriptions and icons of a game (localised). Cached for a day. */
  async schema(key, appId, lang) {
    const ck = `${appId}:${lang}`;
    const hit = this.schemaCache.get(ck);
    if (hit && Date.now() - hit.at < SCHEMA_TTL) return hit.value;
    let value = {};
    try {
      const r = await this._get(`${API}/ISteamUserStats/GetSchemaForGame/v2/?key=${encodeURIComponent(key)}&appid=${encodeURIComponent(appId)}&l=${lang}`);
      const list = r.body && r.body.game && r.body.game.availableGameStats && r.body.game.availableGameStats.achievements;
      if (Array.isArray(list)) {
        for (const a of list) {
          if (!a || typeof a.name !== 'string') continue;
          value[a.name] = {
            name: typeof a.displayName === 'string' ? a.displayName : '',
            desc: typeof a.description === 'string' ? a.description : '',
            icon: httpsOrEmpty(a.icon),
            iconGray: httpsOrEmpty(a.icongray),
            hidden: Number(a.hidden) === 1,
          };
        }
      }
    } catch {
      value = {};
    }
    this.schemaCache.set(ck, { at: Date.now(), value });
    return value;
  }

  /** Share of all players who unlocked each achievement. No key needed. Cached for a day. */
  async globalPercents(appId) {
    const hit = this.percentCache.get(String(appId));
    if (hit && Date.now() - hit.at < SCHEMA_TTL) return hit.value;
    let value = {};
    try {
      const r = await this._get(`${API}/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${encodeURIComponent(appId)}`);
      const list = r.body && r.body.achievementpercentages && r.body.achievementpercentages.achievements;
      if (Array.isArray(list)) for (const a of list) if (a && typeof a.name === 'string') value[a.name] = Number(a.percent);
    } catch {
      value = {};
    }
    this.percentCache.set(String(appId), { at: Date.now(), value });
    return value;
  }

  /**
   * Full achievement list of a game for the player.
   * Returns { unlocked, total, items } or { error: 'private' | 'none' | 'failed' }.
   */
  async achievementsFull(key, steamId, appId, lang = 'en') {
    const l = steamLang(lang);
    const cacheKey = `${steamId}:${appId}:${l}`;
    const hit = this.achCache.get(cacheKey);
    if (hit && Date.now() - hit.at < ACH_TTL) return hit.value;
    let value;
    try {
      const r = await this._get(`${API}/ISteamUserStats/GetPlayerAchievements/v1/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(steamId)}&appid=${encodeURIComponent(appId)}&l=${l}`);
      const stats = r.body && r.body.playerstats;
      if (stats && stats.success !== false && Array.isArray(stats.achievements) && stats.achievements.length) {
        const [schema, percents] = await Promise.all([this.schema(key, appId, l), this.globalPercents(appId)]);
        value = mergeAchievements(stats.achievements, schema, percents);
      } else if (stats && /not public|private/i.test(String(stats.error || ''))) {
        value = { error: 'private' };
      } else if (r.status === 403) {
        value = { error: 'private' };
      } else {
        value = { error: 'none' };
      }
    } catch {
      value = { error: 'failed' };
    }
    if (!value.error || value.error !== 'failed') this.achCache.set(cacheKey, { at: Date.now(), value });
    return value;
  }

  /** Short summary for the home screen: { unlocked, total } or null. */
  async achievements(key, steamId, appId, lang = 'en') {
    const full = await this.achievementsFull(key, steamId, appId, lang);
    return full && !full.error && full.total ? { unlocked: full.unlocked, total: full.total } : null;
  }

  /** Returns { [appId]: [steamid...] } for friends with playtime > 0, plus friend profiles. Cached for a day. */
  friendsIndex() {
    const c = this.store.steamWeb.friends;
    return c && c.byApp ? c : null;
  }

  /**
   * Rebuilds the saved friends list in the background when it is from an older version
   * (missing "last played"), for another account, or older than a day. The old list keeps
   * being shown until the new one is ready.
   */
  refreshFriendsIfStale(key, steamId) {
    const c = this.friendsIndex();
    if (!c) return false;
    const stale = c.format !== FRIENDS_FORMAT || c.steamId !== steamId || Date.now() - (c.builtAt || 0) >= FRIENDS_TTL;
    if (stale && !this.friendsBuilding) this.buildFriendsIndex(key, steamId, { force: true }).catch(() => {});
    return stale;
  }

  async buildFriendsIndex(key, steamId, { force = false } = {}) {
    const cached = this.store.steamWeb.friends;
    if (!force && cached && cached.steamId === steamId && cached.format === FRIENDS_FORMAT && Date.now() - cached.builtAt < FRIENDS_TTL) return cached;
    if (this.friendsBuilding) return this.friendsBuilding;
    this.friendsBuilding = (async () => {
      const r = await this._get(`${API}/ISteamUser/GetFriendList/v1/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(steamId)}&relationship=friend`);
      const list = r.ok && r.body && r.body.friendslist && Array.isArray(r.body.friendslist.friends) ? r.body.friendslist.friends : [];
      const ids = list.map((f) => String(f.steamid)).filter((x) => /^\d{17}$/.test(x)).slice(0, 250);
      const profiles = await this.playerSummaries(key, ids);
      const byApp = {};
      let index = 0;
      const worker = async () => {
        while (index < ids.length) {
          const fid = ids[index++];
          try {
            const games = await this.ownedGames(key, fid);
            for (const g of games) {
              if (g.playtime_forever > 0) (byApp[g.appid] = byApp[g.appid] || []).push([fid, g.playtime_forever, g.playtime_2weeks, g.rtime_last_played]);
            }
          } catch {
            // Private profile: skip.
          }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      const friends = {};
      for (const [id, p] of profiles) friends[id] = { name: p.name, avatar: p.avatar };
      const result = { steamId, builtAt: Date.now(), format: FRIENDS_FORMAT, byApp, friends };
      this.store.steamWeb.friends = result;
      this.store.save('steamWeb');
      if (this.onFriendsBuilt) { try { this.onFriendsBuilt(); } catch { /* ignore */ } }
      return result;
    })().finally(() => { this.friendsBuilding = null; });
    return this.friendsBuilding;
  }

  /** Friends who played a game: [{ id, name, avatar, minutes, minutes2w }], most played first. */
  _friendEntries(appId) {
    const idx = this.friendsIndex();
    if (!idx) return null;
    const raw = idx.byApp[appId] || idx.byApp[String(appId)] || [];
    const entries = raw.map((e) => (Array.isArray(e)
      ? { id: String(e[0]), minutes: Number(e[1]) || 0, minutes2w: Number(e[2]) || 0, lastPlayed: (Number(e[3]) || 0) * 1000 }
      : { id: String(e), minutes: 0, minutes2w: 0, lastPlayed: 0 }));
    entries.sort((a, b) => b.minutes - a.minutes);
    return entries.map((e) => ({
      ...e,
      name: (idx.friends[e.id] && idx.friends[e.id].name) || '',
      avatar: httpsOrEmpty(idx.friends[e.id] && idx.friends[e.id].avatar),
    }));
  }

  /** Summary for the home screen: { count, people: [3 most played] } or null while building. */
  friendsFor(appId) {
    const list = this._friendEntries(appId);
    if (!list) return null;
    return { count: list.length, people: list.slice(0, 3).map((p) => ({ name: p.name, avatar: p.avatar })) };
  }

  /**
   * "Friends who played" for many games at once (instant: from the cached friends list), so the
   * home screen can show it the moment a game is selected. { [appId]: { count, people } }
   */
  friendsSummary(appIds) {
    if (!this.friendsIndex()) return {};
    const out = {};
    for (const id of appIds) {
      const f = this.friendsFor(id);
      if (f && f.count > 0) out[String(id)] = f;
    }
    return out;
  }

  /** Online status of some friends (name, avatar, current game). Cached for a minute. */
  async liveStatus(key, ids) {
    const want = ids.filter((id) => {
      const hit = this.liveCache.get(id);
      return !hit || Date.now() - hit.at > LIVE_TTL;
    });
    if (want.length) {
      try {
        const map = await this.playerSummaries(key, want);
        for (const [id, p] of map) this.liveCache.set(id, { at: Date.now(), value: p });
      } catch { /* keep old values */ }
    }
    const out = new Map();
    for (const id of ids) { const hit = this.liveCache.get(id); if (hit) out.set(id, hit.value); }
    return out;
  }

  /** Achievement progress of one friend in a game ({ unlocked, total } or null). Cached. */
  async friendAchievements(key, friendId, appId) {
    const ck = `${friendId}:${appId}`;
    const hit = this.friendAchCache.get(ck);
    if (hit && Date.now() - hit.at < FRIEND_ACH_TTL) return hit.value;
    let value = null;
    try {
      const r = await this._get(`${API}/ISteamUserStats/GetPlayerAchievements/v1/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(friendId)}&appid=${encodeURIComponent(appId)}`);
      const list = r.body && r.body.playerstats && r.body.playerstats.success !== false ? r.body.playerstats.achievements : null;
      if (Array.isArray(list) && list.length) {
        const times = list.filter((a) => Number(a.achieved) === 1).map((a) => Number(a.unlocktime) || 0).filter((x) => x > 0);
        value = {
          unlocked: list.filter((a) => Number(a.achieved) === 1).length,
          total: list.length,
          // Steam doesn't say when someone started a game; the first achievement is the closest hint.
          firstUnlock: times.length ? Math.min(...times) * 1000 : 0,
          lastUnlock: times.length ? Math.max(...times) * 1000 : 0,
        };
      }
    } catch { value = null; }
    this.friendAchCache.set(ck, { at: Date.now(), value });
    return value;
  }

  /**
   * Friends who played a game, with playtime and who is playing it right now.
   * Returns { list: [...] } or { building: true } while the friends index is being built.
   */
  async friendsDetail(key, steamId, appId) {
    let list = this._friendEntries(appId);
    if (!list) {
      this.buildFriendsIndex(key, steamId).catch(() => {});
      return { building: true };
    }
    this.refreshFriendsIfStale(key, steamId);
    list = list.slice(0, 60);
    const live = await this.liveStatus(key, list.map((p) => p.id));
    // Achievement progress for the most active friends (public profiles only), 4 at a time.
    const ach = new Map();
    const top = list.slice(0, FRIEND_ACH_MAX);
    let i = 0;
    const worker = async () => {
      while (i < top.length) {
        const p = top[i++];
        ach.set(p.id, await this.friendAchievements(key, p.id, appId));
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    const out = list.map((p) => {
      const l = live.get(p.id);
      const playingNow = !!(l && l.gameId && String(l.gameId) === String(appId));
      return {
        id: p.id,
        name: (l && l.name) || p.name,
        avatar: httpsOrEmpty((l && (l.avatarFull || l.avatar)) || p.avatar),
        minutes: p.minutes,
        minutes2w: p.minutes2w,
        // Steam's "last played"; if a profile doesn't report it, the latest achievement is the best hint.
        lastPlayed: p.lastPlayed || ((ach.get(p.id) && ach.get(p.id).lastUnlock) || 0),
        playingNow,
        otherGame: !playingNow && l && l.gameId ? (l.gameName || '') : '',
        inGame: !!(l && l.gameId),
        online: !!(l && l.state > 0),
        state: l ? l.state : 0,
        lastOnline: l ? l.lastOnline : 0,
        achievements: ach.get(p.id) || null,
      };
    }).sort((a, b) => (Number(b.playingNow) - Number(a.playingNow)) || (b.lastPlayed - a.lastPlayed) || (b.minutes - a.minutes));
    return {
      list: out,
      totalMinutes: out.reduce((n, p) => n + p.minutes, 0),
      playingNow: out.filter((p) => p.playingNow).length,
      online: out.filter((p) => p.online).length,
    };
  }
}

module.exports = { SteamWeb, mergeAchievements, steamLang };
