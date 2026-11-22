'use strict';
/**
 * Xbox network data through OpenXBL (https://xbl.io), an independent Xbox Live API.
 * The user signs in there with their Xbox account and pastes the free API key into Options.
 *
 * Used for: playtime ("MinutesPlayed") and last played of Xbox PC games, achievements,
 * friends who play a game (with playtime, last played and achievement progress).
 *
 * The free plan allows 150 requests per hour, so everything is cached and counted here.
 * Responses may come wrapped as { content, code }; that envelope is removed.
 */
const BASES = ['https://api.xbl.io/v2', 'https://xbl.io/api/v2'];
const HOUR = 60 * 60 * 1000;
const BUDGET_PER_HOUR = 140;
const BACKGROUND_RESERVE = 45;
const TIMEOUT_MS = 20000;
const TTL = {
  account: 24 * HOUR,
  titles: 30 * 60 * 1000,
  minutes: HOUR,
  achievements: 10 * 60 * 1000,
  friends: 15 * 60 * 1000,
  presence: 2 * 60 * 1000,
  friendMinutes: 6 * HOUR,
  friendTitles: 24 * HOUR,
};
const STATS_BATCH = 40;
const FRIEND_INDEX_PER_RUN = 10;
const FRIEND_INDEX_GAP_MS = 10 * 60 * 1000;

class XboxError extends Error {
  constructor(message, extra = {}) {
    super(message);
    Object.assign(this, extra);
  }
}

function str(v) { return v === undefined || v === null ? '' : String(v); }

function time(v) {
  const t = typeof v === 'number' ? v : Date.parse(str(v));
  // Xbox uses 0001-01-01 for "never".
  return Number.isFinite(t) && t > Date.UTC(2001, 0, 1) ? t : 0;
}

function looseName(s) {
  return str(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[™®©]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Removes OpenXBL's { content, code } wrapper. */
function unwrap(body) {
  if (body && typeof body === 'object' && !Array.isArray(body) && 'content' in body && 'code' in body) {
    const code = Number(body.code);
    if (code === 401 || code === 403) throw new XboxError('auth', { auth: true, stale: true });
    if (code === 429) throw new XboxError('rateLimited', { rateLimited: true });
    return body.content;
  }
  return body;
}

function setting(user, ...ids) {
  const list = (user && Array.isArray(user.settings)) ? user.settings : [];
  for (const id of ids) {
    const s = list.find((x) => x && x.id === id && x.value);
    if (s) return String(s.value);
  }
  return '';
}

function parseAccount(body) {
  const user = body && Array.isArray(body.profileUsers) ? body.profileUsers[0] : (body && body.xuid ? body : null);
  if (!user) return null;
  const xuid = str(user.id || user.xuid);
  if (!/^\d{5,20}$/.test(xuid)) return null;
  return {
    xuid,
    gamertag: setting(user, 'ModernGamertag', 'Gamertag', 'GameDisplayName') || str(user.gamertag),
    avatar: setting(user, 'GameDisplayPicRaw') || str(user.displayPicRaw),
    gamerscore: Number(setting(user, 'Gamerscore')) || 0,
  };
}

function parseTitles(body) {
  const list = body && Array.isArray(body.titles) ? body.titles : (Array.isArray(body) ? body : []);
  const out = [];
  for (const t of list) {
    if (!t || !t.titleId) continue;
    const a = t.achievement || {};
    const detail = t.detail && typeof t.detail === 'object' ? t.detail : {};
    const avail = Array.isArray(detail.availabilities) ? detail.availabilities : [];
    const productId = str(t.productId || detail.productId || (avail.find((a) => a && a.ProductId) || {}).ProductId || t.storeId);
    out.push({
      titleId: str(t.titleId),
      name: str(t.name),
      pfn: str(t.pfn),
      type: str(t.type),
      devices: Array.isArray(t.devices) ? t.devices.map(str) : [],
      image: /^https:\/\//.test(str(t.displayImage)) ? str(t.displayImage) : '',
      productId: /^[0-9A-Za-z]{12}$/.test(productId) ? productId.toUpperCase() : '',
      lastPlayed: time(t.titleHistory && t.titleHistory.lastTimePlayed),
      ach: {
        unlocked: Number(a.currentAchievements) || 0,
        total: Number(a.totalAchievements) || 0,
        gamerscore: Number(a.currentGamerscore) || 0,
        gamerscoreTotal: Number(a.totalGamerscore) || 0,
        percent: Number(a.progressPercentage) || 0,
      },
    });
  }
  return out;
}

/** Finds { xuid, titleId, minutes } in a userstats batch answer, whatever its exact nesting. */
function parseMinutes(body) {
  const out = [];
  const visit = (node, xuidHint, depth) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) { for (const n of node) visit(n, xuidHint, depth + 1); return; }
    const name = str(node.name || node.statname);
    const titleId = str(node.titleid || node.titleId);
    if (/^minutesplayed$/i.test(name) && titleId) {
      const xuid = str(node.xuid || xuidHint);
      const minutes = Number(node.value);
      if (xuid && Number.isFinite(minutes)) out.push({ xuid, titleId, minutes: Math.max(0, Math.round(minutes)) });
      return;
    }
    const hint = node.arrangebyfield === 'xuid' && node.arrangebyfieldid ? str(node.arrangebyfieldid) : (node.xuid ? str(node.xuid) : xuidHint);
    for (const v of Object.values(node)) if (v && typeof v === 'object') visit(v, hint, depth + 1);
  };
  visit(body, '', 0);
  return out;
}

function parseAchievements(body) {
  const list = body && Array.isArray(body.achievements) ? body.achievements : [];
  const items = list.filter((a) => a && a.name).map((a) => {
    const achieved = /^achieved$/i.test(str(a.progressState));
    const icon = (Array.isArray(a.mediaAssets) ? a.mediaAssets : []).find((m) => m && /icon/i.test(str(m.type)) && /^https:\/\//.test(str(m.url)));
    const reward = (Array.isArray(a.rewards) ? a.rewards : []).find((r) => r && /gamerscore/i.test(str(r.type)));
    const rarity = a.rarity && Number.isFinite(Number(a.rarity.currentPercentage)) ? Number(a.rarity.currentPercentage) : null;
    const hidden = !!a.isSecret;
    return {
      id: str(a.id),
      name: str(a.name),
      desc: achieved ? str(a.description || a.lockedDescription) : str(a.lockedDescription || (hidden ? '' : a.description)),
      icon: icon ? str(icon.url) : '',
      achieved,
      unlockTime: achieved ? time(a.progression && a.progression.timeUnlocked) : 0,
      percent: rarity,
      hidden,
      gamerscore: reward ? Number(reward.value) || 0 : 0,
    };
  });
  // Unlocked first (newest first), then the rarest-but-closest: most common locked ones.
  items.sort((x, y) => (Number(y.achieved) - Number(x.achieved))
    || (x.achieved ? y.unlockTime - x.unlockTime : ((y.percent || 0) - (x.percent || 0))));
  const unlocked = items.filter((x) => x.achieved);
  return {
    unlocked: unlocked.length,
    total: items.length,
    gamerscore: unlocked.reduce((n, x) => n + x.gamerscore, 0),
    gamerscoreTotal: items.reduce((n, x) => n + x.gamerscore, 0),
    items,
  };
}

function parseFriends(body) {
  const list = body && Array.isArray(body.people) ? body.people : (Array.isArray(body) ? body : []);
  return list.filter((p) => p && p.xuid).map((p) => {
    const details = Array.isArray(p.presenceDetails) ? p.presenceDetails : [];
    const playing = details.filter((d) => d && d.IsGame !== false && d.TitleId && (!d.State || /active/i.test(str(d.State)))).map((d) => str(d.TitleId));
    return {
      xuid: str(p.xuid),
      name: str(p.modernGamertag || p.gamertag || p.displayName),
      avatar: /^https:\/\//.test(str(p.displayPicRaw)) ? str(p.displayPicRaw) : '',
      online: /online/i.test(str(p.presenceState)),
      playing,
    };
  });
}

/** Presence batch answer → Map(xuid → [titleIds being played]). */
function parsePresence(body) {
  const list = Array.isArray(body) ? body : (body && Array.isArray(body.people) ? body.people : []);
  const out = new Map();
  for (const p of list) {
    if (!p || !p.xuid) continue;
    const ids = [];
    for (const d of Array.isArray(p.devices) ? p.devices : []) {
      for (const t of Array.isArray(d && d.titles) ? d.titles : []) {
        if (t && t.id && (!t.state || /active/i.test(str(t.state))) && !/^(home|xbox app)$/i.test(str(t.name))) ids.push(str(t.id));
      }
    }
    out.set(str(p.xuid), ids);
  }
  return out;
}

class XboxLive {
  constructor({ store, fetch, log = console, now = Date.now }) {
    this.store = store;
    this.fetch = fetch;
    this.log = log;
    this.now = now;
    this.base = null;
    this.blockedUntil = 0;
    this.lastIndexRun = 0;
    this.indexing = null;
    this.inflight = new Map();
  }

  get data() {
    const d = this.store.xbox;
    if (!d.calls || !Array.isArray(d.calls)) d.calls = [];
    for (const k of ['minutes', 'achievements', 'friendMinutes', 'friendTitles']) if (!d[k] || typeof d[k] !== 'object') d[k] = {};
    return d;
  }

  _save(delay = 1500) { this.store.save('xbox', delay); }

  /** Requests left in this hour (our own count, kept below the 150/h of the free plan). */
  remaining() {
    const cutoff = this.now() - HOUR;
    const calls = this.data.calls.filter((t) => t > cutoff);
    this.data.calls = calls;
    return Math.max(0, BUDGET_PER_HOUR - calls.length);
  }

  status() {
    const d = this.data;
    return {
      account: d.account ? { gamertag: d.account.gamertag, avatar: d.account.avatar, gamerscore: d.account.gamerscore } : null,
      authError: !!d.authError,
      remaining: this.remaining(),
      rateLimited: this.blockedUntil > this.now(),
    };
  }

  /** Forget everything tied to the old key (called when the key changes). */
  reset() {
    this.store.xbox = { calls: this.data.calls };
    this.base = null;
    this.blockedUntil = 0;
    this._save(0);
  }

  async _request(key, method, p, body, { lang } = {}) {
    if (!key) throw new XboxError('noKey', { noKey: true });
    if (this.blockedUntil > this.now()) throw new XboxError('rateLimited', { rateLimited: true });
    if (this.remaining() <= 0) throw new XboxError('budget', { rateLimited: true });
    this.data.calls.push(this.now());
    this._save(4000);
    const bases = this.base ? [this.base, ...BASES.filter((b) => b !== this.base)] : BASES;
    let lastErr = null;
    for (const base of bases) {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
      let res;
      try {
        const headers = { 'X-Authorization': key, Accept: 'application/json' };
        if (lang) headers['Accept-Language'] = lang;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        res = await this.fetch(`${base}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, ...(ctrl ? { signal: ctrl.signal } : {}) });
      } catch (err) {
        if (err && err.offline) throw err;
        lastErr = err;
        continue;
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (res.status === 404 && base !== bases[bases.length - 1]) { lastErr = new XboxError('notFound', { status: 404 }); continue; }
      const header = (name) => {
        const v = res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null;
        return v === null || v === undefined || v === '' ? NaN : Number(v);
      };
      // Missing headers are "unknown", not 0.
      const left = header('x-ratelimit-remaining');
      if (res.status === 429 || (Number.isFinite(left) && left <= 0)) {
        const retry = header('retry-after');
        this.blockedUntil = this.now() + (Number.isFinite(retry) && retry > 0 ? retry * 1000 : 15 * 60 * 1000);
        if (res.status === 429) throw new XboxError('rateLimited', { rateLimited: true });
      }
      let json = null;
      try { json = await res.json(); } catch { json = null; }
      if (res.status === 401 || res.status === 403) {
        this.data.authError = { at: this.now() };
        this._save();
        throw new XboxError('auth', { auth: true, status: res.status });
      }
      if (!res.ok) throw new XboxError(`HTTP ${res.status}`, { status: res.status });
      let content;
      try {
        content = unwrap(json);
      } catch (err) {
        if (err.auth) { this.data.authError = { at: this.now(), stale: true }; this._save(); }
        throw err;
      }
      this.base = base;
      if (this.data.authError) { delete this.data.authError; this._save(); }
      return content;
    }
    throw lastErr || new XboxError('failed');
  }

  /** One request at a time per cache key; later callers share the answer. */
  _once(id, fn) {
    if (this.inflight.has(id)) return this.inflight.get(id);
    const p = Promise.resolve().then(fn).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  async account(key, { force = false } = {}) {
    const d = this.data;
    if (!force && d.account && d.account.key === keyTag(key) && this.now() - d.account.at < TTL.account) return d.account;
    return this._once('account', async () => {
      const acc = parseAccount(await this._request(key, 'GET', '/account'));
      if (!acc) throw new XboxError('noAccount');
      d.account = { ...acc, key: keyTag(key), at: this.now() };
      this._save();
      return d.account;
    });
  }

  async titles(key) {
    const d = this.data;
    if (d.titles && d.titles.key === keyTag(key) && this.now() - d.titles.at < TTL.titles) return d.titles.list;
    return this._once('titles', async () => {
      try {
        const list = parseTitles(await this._request(key, 'GET', '/player/titleHistory'));
        d.titles = { key: keyTag(key), at: this.now(), list };
        this._save();
        return list;
      } catch (err) {
        if (d.titles && Array.isArray(d.titles.list) && !err.auth) return d.titles.list;
        throw err;
      }
    });
  }

  /** Minutes played for some of your titles (cached per title for an hour). */
  async minutes(key, xuid, titleIds) {
    const d = this.data;
    const now = this.now();
    const stale = [...new Set(titleIds.map(str))].filter((id) => id && !(d.minutes[id] && now - d.minutes[id].at < TTL.minutes));
    for (let i = 0; i < stale.length; i += STATS_BATCH) {
      const chunk = stale.slice(i, i + STATS_BATCH);
      try {
        const rows = parseMinutes(await this._request(key, 'POST', '/player/stats', {
          xuids: [xuid],
          stats: chunk.map((id) => ({ name: 'MinutesPlayed', titleId: id })),
        }));
        for (const id of chunk) {
          const row = rows.find((r) => r.titleId === id && r.xuid === xuid) || rows.find((r) => r.titleId === id);
          d.minutes[id] = { at: now, minutes: row ? row.minutes : null };
        }
      } catch (err) {
        if (err.auth || err.offline) throw err;
        this.log.warn('[xbox] stats failed:', err && err.message);
        break;
      }
    }
    this._save();
    const out = {};
    for (const id of titleIds) {
      const e = d.minutes[str(id)];
      if (e && Number.isFinite(e.minutes)) out[str(id)] = e.minutes;
    }
    return out;
  }

  /**
   * Playtime, last played and achievement progress for local Xbox games.
   * games: [{ id, pfn, titleId (decimal string or ''), name }] → Map(gameId → info)
   */
  async libraryInfo(key, games, { refresh = true } = {}) {
    let titles;
    let account;
    if (refresh) {
      account = await this.account(key);
      titles = await this.titles(key);
    } else {
      account = this.data.account;
      titles = this.data.titles && this.data.titles.list;
    }
    if (!account || !Array.isArray(titles)) return new Map();
    const byPfn = new Map(titles.filter((t) => t.pfn).map((t) => [t.pfn.toLowerCase(), t]));
    const byId = new Map(titles.map((t) => [t.titleId, t]));
    const byName = new Map(titles.map((t) => [looseName(t.name), t]));
    const matched = new Map();
    for (const g of games) {
      const t = (g.pfn && byPfn.get(g.pfn.toLowerCase())) || (g.titleId && byId.get(g.titleId)) || byName.get(looseName(g.name));
      if (t) matched.set(g.id, t);
    }
    let minutes = {};
    const ids = [...new Set([...matched.values()].map((t) => t.titleId))];
    if (ids.length) {
      if (refresh) minutes = await this.minutes(key, account.xuid, ids).catch((err) => { if (err.auth) throw err; return {}; });
      else for (const id of ids) { const e = this.data.minutes[id]; if (e && Number.isFinite(e.minutes)) minutes[id] = e.minutes; }
    }
    const out = new Map();
    for (const [gameId, t] of matched) {
      out.set(gameId, {
        titleId: t.titleId,
        minutes: Object.prototype.hasOwnProperty.call(minutes, t.titleId) ? minutes[t.titleId] : null,
        lastPlayed: t.lastPlayed,
        ach: t.ach,
      });
    }
    return out;
  }

  /**
   * PC games from your Xbox history that are not in `exclude` (titles already on this PC), with
   * minutes played: shown in the library as "not installed", like Steam games you own.
   */
  async historyGames(key, exclude = new Set(), { refresh = true } = {}) {
    const titles = refresh ? await this.titles(key) : (this.data.titles && this.data.titles.list);
    const account = this.data.account;
    if (!Array.isArray(titles) || !account) return [];
    const isPcGame = (t) => (!t.type || /^game$/i.test(t.type))
      && t.devices.some((d) => /^(pc|win32|windows)/i.test(d));
    const list = titles.filter((t) => isPcGame(t) && !exclude.has(t.titleId) && t.name);
    const ids = list.map((t) => t.titleId);
    let minutes = {};
    if (ids.length && refresh) minutes = await this.minutes(key, account.xuid, ids).catch((err) => { if (err.auth) throw err; return {}; });
    else for (const id of ids) { const e = this.data.minutes[id]; if (e && Number.isFinite(e.minutes)) minutes[id] = e.minutes; }
    return list.map((t) => ({ ...t, minutes: Object.prototype.hasOwnProperty.call(minutes, t.titleId) ? minutes[t.titleId] : null }));
  }

  async achievements(key, titleId, lang) {
    const d = this.data;
    const id = str(titleId);
    const hit = d.achievements[id];
    if (hit && hit.lang === lang && this.now() - hit.at < TTL.achievements) return hit.value;
    return this._once(`ach:${id}`, async () => {
      const account = await this.account(key);
      let value;
      try {
        value = parseAchievements(await this._request(key, 'GET', `/achievements/player/${account.xuid}/${encodeURIComponent(id)}`, undefined, { lang }));
        if (!value.total) value = { error: 'none' };
      } catch (err) {
        if (err.auth || err.offline) throw err;
        if (hit) return hit.value;
        return { error: err.rateLimited ? 'rateLimited' : 'failed' };
      }
      d.achievements[id] = { at: this.now(), lang, value };
      this._save();
      return value;
    });
  }

  async friends(key) {
    const d = this.data;
    if (d.friends && d.friends.key === keyTag(key) && this.now() - d.friends.at < TTL.friends) return d.friends.list;
    return this._once('friends', async () => {
      try {
        const list = parseFriends(await this._request(key, 'GET', '/friends'));
        d.friends = { key: keyTag(key), at: this.now(), list, presenceAt: this.now() };
        this._save();
        return list;
      } catch (err) {
        if (d.friends && Array.isArray(d.friends.list) && !err.auth && !err.offline) return d.friends.list;
        throw err;
      }
    });
  }

  /** Fresh "playing now" for all friends (cheap: one request, at most every 2 minutes). */
  async presence(key) {
    const d = this.data;
    if (!d.friends || !Array.isArray(d.friends.list)) return;
    if (this.now() - (d.friends.presenceAt || 0) < TTL.presence) return;
    try {
      const map = parsePresence(await this._request(key, 'GET', '/presence'));
      if (map.size) {
        for (const f of d.friends.list) if (map.has(f.xuid)) f.playing = map.get(f.xuid);
      }
      d.friends.presenceAt = this.now();
      this._save();
    } catch (err) {
      if (err.auth || err.offline) throw err;
    }
  }

  async friendMinutes(key, titleId, xuids) {
    const d = this.data;
    const id = str(titleId);
    const hit = d.friendMinutes[id];
    if (hit && this.now() - hit.at < TTL.friendMinutes) return hit.map;
    const map = {};
    for (let i = 0; i < xuids.length; i += STATS_BATCH) {
      const chunk = xuids.slice(i, i + STATS_BATCH);
      try {
        for (const r of parseMinutes(await this._request(key, 'POST', '/player/stats', { xuids: chunk, stats: [{ name: 'MinutesPlayed', titleId: id }] }))) {
          if (r.titleId === id) map[r.xuid] = r.minutes;
        }
      } catch (err) {
        if (err.auth || err.offline) throw err;
        if (hit) return hit.map;
        break;
      }
    }
    d.friendMinutes[id] = { at: this.now(), map };
    this._save();
    return map;
  }

  /**
   * Builds the per-friend game list a few friends at a time (24 h cache), only while plenty of
   * the hourly requests are left. Gives "last played" and achievement progress per friend.
   */
  indexFriends(key) {
    if (this.indexing) return this.indexing;
    if (this.now() - this.lastIndexRun < FRIEND_INDEX_GAP_MS) return Promise.resolve();
    this.lastIndexRun = this.now();
    this.indexing = (async () => {
      const friends = await this.friends(key);
      const d = this.data;
      const due = friends.filter((f) => !(d.friendTitles[f.xuid] && this.now() - d.friendTitles[f.xuid].at < TTL.friendTitles));
      for (const f of due.slice(0, FRIEND_INDEX_PER_RUN)) {
        if (this.remaining() <= BACKGROUND_RESERVE) break;
        try {
          const titles = parseTitles(await this._request(key, 'GET', `/player/titleHistory/${f.xuid}`));
          const map = {};
          for (const t of titles) map[t.titleId] = [t.lastPlayed, t.ach.unlocked, t.ach.total];
          d.friendTitles[f.xuid] = { at: this.now(), titles: map };
        } catch (err) {
          if (err.auth || err.offline || err.rateLimited) break;
          d.friendTitles[f.xuid] = { at: this.now(), titles: {}, private: true };
        }
      }
      // Forget friends that were removed.
      const keep = new Set(friends.map((f) => f.xuid));
      for (const x of Object.keys(d.friendTitles)) if (!keep.has(x)) delete d.friendTitles[x];
      this._save();
    })().catch(() => {}).finally(() => { this.indexing = null; });
    return this.indexing;
  }

  /** Friends who played a title: playing now first, then most recent. */
  async friendsForTitle(key, titleId) {
    const id = str(titleId);
    const friends = await this.friends(key);
    await this.presence(key).catch((err) => { if (err.auth) throw err; });
    const minutes = await this.friendMinutes(key, id, friends.map((f) => f.xuid)).catch((err) => { if (err.auth) throw err; return {}; });
    this.indexFriends(key);
    const idx = this.data.friendTitles;
    const list = [];
    for (const f of friends) {
      const t = idx[f.xuid] && idx[f.xuid].titles ? idx[f.xuid].titles[id] : null;
      const mins = Number(minutes[f.xuid]) || 0;
      const playingNow = Array.isArray(f.playing) && f.playing.includes(id);
      if (!t && mins <= 0 && !playingNow) continue;
      list.push({
        id: f.xuid,
        name: f.name,
        avatar: f.avatar,
        minutes: mins,
        minutes2w: 0,
        lastPlayed: t ? Number(t[0]) || 0 : 0,
        playingNow,
        achievements: t && Number(t[2]) > 0 ? { unlocked: Number(t[1]) || 0, total: Number(t[2]) || 0 } : null,
        profileUrl: `https://account.xbox.com/profile?gamertag=${encodeURIComponent(f.name)}`,
      });
    }
    list.sort((a, b) => (Number(b.playingNow) - Number(a.playingNow)) || (b.lastPlayed - a.lastPlayed) || (b.minutes - a.minutes));
    return { list };
  }

  /** "X friends played" for many titles at once, from what is already saved (no requests). */
  friendsSummary(titleIds) {
    const d = this.data;
    const friends = d.friends && Array.isArray(d.friends.list) ? d.friends.list : [];
    const byXuid = new Map(friends.map((f) => [f.xuid, f]));
    const out = {};
    for (const raw of titleIds) {
      const id = str(raw);
      const who = new Set();
      for (const [xuid, e] of Object.entries(d.friendTitles)) if (e && e.titles && e.titles[id]) who.add(xuid);
      const fm = d.friendMinutes[id];
      if (fm && fm.map) for (const [xuid, m] of Object.entries(fm.map)) if (Number(m) > 0) who.add(xuid);
      const people = [...who].map((x) => byXuid.get(x)).filter(Boolean);
      if (people.length) out[id] = { count: people.length, people: people.slice(0, 3).map((p) => ({ name: p.name, avatar: p.avatar })) };
    }
    return out;
  }
}

/** Short fingerprint so cached data from another key is not reused (the key itself is not stored twice). */
function keyTag(key) {
  const s = str(key);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) | 0;
  return `${s.length}:${(h >>> 0).toString(36)}`;
}

/** Xbox title id from MicrosoftGame.config (hex) as the decimal string the API uses. */
function titleIdFromHex(hex) {
  const h = str(hex).trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]{1,8}$/i.test(h)) return '';
  return String(parseInt(h, 16));
}

module.exports = {
  XboxLive, XboxError, parseAccount, parseTitles, parseMinutes, parseAchievements, parseFriends, parsePresence,
  unwrap, titleIdFromHex, looseName,
};
