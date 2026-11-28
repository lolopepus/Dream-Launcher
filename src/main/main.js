'use strict';
/**
 * Dream Launcher - main process.
 * Creates the window, serves the interface over the app:// scheme, serves cached artwork and
 * media over dl://, and answers all requests from the interface (see preload.js).
 */
const { app, BrowserWindow, ipcMain, protocol, shell, dialog, net, Menu, nativeImage, clipboard } = require('electron');
const path = require('path');
const crypto = require('crypto');
const fsp = require('fs').promises;
const { Store } = require('./store');
const { Library } = require('./library');
const { Artwork } = require('./artwork');
const { SteamWeb } = require('./steamweb');
const { XboxLive } = require('./xboxlive');
const { Connectivity } = require('./connectivity');
const { Updater } = require('./updater');
const { spawn } = require('child_process');
// GitHub repository whose releases are checked for updates. package.json can override it; the
// fallback matters because packaging may not keep custom package.json fields.
const DEFAULT_UPDATE_REPO = 'lolopepus/Dream-Launcher';
const UPDATE_REPO = (() => {
  try {
    const r = require('../../package.json').updateRepo;
    return typeof r === 'string' && /^[\w.-]+\/[\w.-]+$/.test(r) ? r : DEFAULT_UPDATE_REPO;
  } catch { return DEFAULT_UPDATE_REPO; }
})();
const { Sessions } = require('./sessions');
const { runProbe, listProcesses, listProcessNames, detectDevice } = require('./util/powershell');
const { classifyDevice } = require('./device');
const { steamScreenshots } = require('./screenshots');
const { listClips, clipManifest } = require('./clips');
const { emulatorShots, shotsForGame } = require('./emushots');
const { Thumbs } = require('./thumbs');
const { DiscordPresence, buildActivity } = require('./discord');
const { PRESETS } = require('./emulator-presets');
const { sanitizeSettings, sanitizeOverrides, SECRET_KEYS, sectionDefaults } = require('./defaults');
const { readJson, writeJsonAtomic } = require('./util/fsx');

app.setName('Dream Launcher');
app.setAppUserModelId('com.dreamlauncher.app');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  { scheme: 'dl', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const RENDERER_ROOT = path.join(__dirname, '..', 'renderer');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
};
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const ART_KINDS = ['cover', 'hero', 'logo'];
const AUDIO_EXTS = ['mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'aac', 'flac'];

let win = null;
let store;
let library;
let artwork;
let steamWeb;
let xbox;
let connectivity;
let updater;
let sessions;
let quitting = false;
let discord = null; // Discord status (discord.js)
const startedAt = Date.now();
let playing = null; // { id, since } of the game started through the launcher

/** Shows the current state on Discord (or nothing, when turned off). */
function updateDiscord() {
  if (!discord || !store) return;
  const s = store.settings;
  if (!s.discordStatus) { discord.stop(); return; }
  discord.start();
  const lang = s.language && s.language !== 'auto' ? s.language : String(app.getLocale() || 'en').slice(0, 2);
  discord.set(buildActivity({ enabled: true, lang, playing: !!playing, since: startedAt, repo: UPDATE_REPO }));
}

const log = {
  info: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
};

// ---------------------------------------------------------------- helpers

/** Serves a file below `root`. Supports byte ranges (needed by the audio player for seeking). */
async function serveFile(root, relPath, req) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, '.' + path.sep + relPath);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    return new Response('Forbidden', { status: 403 });
  }
  try {
    const data = await fsp.readFile(target);
    const headers = {
      'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'access-control-allow-origin': '*',
      'cache-control': 'no-cache',
      'accept-ranges': 'bytes',
    };
    const range = req && req.headers && req.headers.get ? req.headers.get('range') : null;
    const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
    if (m && (m[1] || m[2])) {
      const size = data.length;
      let start = m[1] ? Number(m[1]) : size - Number(m[2]);
      let end = m[1] && m[2] ? Number(m[2]) : size - 1;
      start = Math.max(0, start);
      end = Math.min(size - 1, end);
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
      }
      return new Response(data.subarray(start, end + 1), {
        status: 206,
        headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) },
      });
    }
    return new Response(data, { status: 200, headers: { ...headers, 'content-length': String(data.length) } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function publicSettings() {
  const s = { ...store.settings };
  const secrets = {};
  for (const k of SECRET_KEYS) {
    const v = s[k] || '';
    secrets[k] = v ? `•••• ${v.slice(-4)}` : '';
    s[k] = '';
  }
  s.secrets = secrets;
  return s;
}

function detectedSteamId() {
  const u = library && library.steamMeta && library.steamMeta.user;
  return u ? u.id64 : '';
}

function steamCreds() {
  const s = store.settings;
  return { key: s.steamApiKey, steamId: s.steamId || detectedSteamId() };
}

/**
 * Key + Steam ID for Steam Web features. If the key is set but the account isn't known yet
 * (first start, scan still running), waits for the scan instead of reporting a missing key.
 * Returns { key, steamId } or { missing: 'key' | 'id' }.
 */
async function steamCredsReady() {
  let c = steamCreds();
  if (c.key && !c.steamId && library.scanning) {
    await Promise.race([library.scanning.catch(() => {}), new Promise((r) => setTimeout(r, 20000))]);
    c = steamCreds();
  }
  if (!c.key) return { missing: 'key' };
  if (!c.steamId) return { missing: 'id' };
  return c;
}

/** Steam account facts the interface needs (detected SteamID for the Accounts options). */
function profileInfo() {
  const user = library && library.steamMeta && library.steamMeta.user;
  return { steamName: (user && user.personaName) || '', steamId: detectedSteamId() };
}

// ---------------------------------------------------------------- device (handheld detection)

function deviceSummary() {
  const info = store.device && store.device.info;
  const c = classifyDevice(info, { hasBattery: library ? library.hasBattery : null });
  return { ...c, detectedAt: (store.device && store.device.at) || 0 };
}

async function refreshDevice() {
  const info = await detectDevice();
  const before = JSON.stringify(deviceSummary());
  store.device = { at: Date.now(), info };
  store.save('device', 0);
  const after = deviceSummary();
  if (JSON.stringify(after) !== before) send('app:device', after);
}

// ---------------------------------------------------------------- Steam screenshots

const shotTokens = new Map(); // token -> { path, thumbPath, mtime }
let thumbs = null; // sharp previews (thumbs.js), made when the store is ready

const jpegResponse = (buf) => new Response(buf, { status: 200, headers: { 'content-type': 'image/jpeg', 'access-control-allow-origin': '*', 'cache-control': 'no-cache' } });

async function serveShot(token, params) {
  const info = shotTokens.get(token);
  if (!info) return new Response('Not found', { status: 404 });
  if (params.has('thumb')) {
    const buf = thumbs ? await thumbs.get(token, info.path, info.mtime, params.get('w')) : null;
    if (buf) return jpegResponse(buf);
    if (info.thumbPath) return serveFile(path.dirname(info.thumbPath), path.basename(info.thumbPath));
  }
  return serveFile(path.dirname(info.path), path.basename(info.path));
}

/**
 * Screenshots of an emulator game (Cemu, Dolphin, PPSSPP, RPCS3): matched by the game's ID or by
 * the times it was played (see emushots.js).
 */
async function emuShotsFor(g) {
  const exe = g.launch && g.launch.path;
  if (!exe || !g.emuKind) return [];
  const env = { ...process.env, DOCUMENTS: app.getPath('documents') };
  const all = await emulatorShots(g.emuKind, exe, env);
  if (!all.length) return [];
  const siblings = library.raw.filter((x) => x.emuKind === g.emuKind && x.emulatorId === g.emulatorId && !store.getOverride(x.id).hidden);
  const tracked = store.playtime[g.id];
  return shotsForGame(g.emuKind, g, all, { siblings, sessions: tracked && tracked.sessions }).slice(0, 400);
}

async function screenshotsFor(g) {
  let list;
  if (g.emuKind) list = await emuShotsFor(g);
  else {
    const meta = library.steamMeta;
    list = await steamScreenshots(meta && meta.steamPath, meta && meta.user && meta.user.accountId, g.sourceId);
  }
  if (shotTokens.size > 6000) shotTokens.clear();
  return list.map((item) => {
    const token = crypto.createHash('sha1').update(item.path.toLowerCase()).digest('hex').slice(0, 24);
    shotTokens.set(token, { path: item.path, thumbPath: item.thumbPath, mtime: item.time });
    return { id: token, kind: 'shot', full: `dl://shot/${token}`, thumb: `dl://shot/${token}?thumb=1`, time: item.time };
  });
}

// ---------------------------------------------------------------- Steam clips (game recording)

const clipTokens = new Map(); // token -> clip ({ dir, sessions, thumb, ... })

async function clipsFor(g) {
  const meta = library.steamMeta;
  const list = await listClips({ steamPath: meta && meta.steamPath, accountId: meta && meta.user && meta.user.accountId, appId: g.sourceId });
  if (clipTokens.size > 3000) clipTokens.clear();
  return list.map((clip) => {
    const token = crypto.createHash('sha1').update(`clip:${clip.dir.toLowerCase()}`).digest('hex').slice(0, 24);
    clipTokens.set(token, clip);
    return { id: token, kind: 'clip', time: clip.time, duration: clip.duration, thumb: clip.thumb ? `dl://clip/${token}/thumb` : null };
  });
}

const CLIP_PIECE_RE = /^[\w.-]{1,120}\.m4s$/i;

/** dl://clip/<token>/thumb  or  dl://clip/<token>/<session>/<piece>.m4s */
async function serveClip(pathname) {
  const parts = pathname.replace(/^\//, '').split('/').map((x) => { try { return decodeURIComponent(x); } catch { return ''; } });
  const clip = clipTokens.get(parts[0]);
  if (!clip) return new Response('Not found', { status: 404 });
  if (parts.length === 2 && parts[1] === 'thumb' && clip.thumb) return serveFile(path.dirname(clip.thumb), path.basename(clip.thumb));
  if (parts.length === 3 && /^\d{1,3}$/.test(parts[1]) && CLIP_PIECE_RE.test(parts[2])) {
    const dir = clip.sessions[Number(parts[1])];
    if (dir) return serveFile(dir, parts[2]);
  }
  return new Response('Not found', { status: 404 });
}

// ---------------------------------------------------------------- online status / Xbox

function netStatus() {
  const st = connectivity ? connectivity.snapshot() : { online: true, mode: 'auto', reason: null };
  const s = store.settings;
  return {
    ...st,
    services: {
      steam: { key: !!s.steamApiKey, account: !!(s.steamId || detectedSteamId()) },
      xbox: { key: !!s.xblApiKey, ...(xbox ? xbox.status() : {}) },
      sgdb: { key: !!s.sgdbApiKey },
    },
  };
}

function langTag(lang) {
  return { de: 'de-DE', pl: 'pl-PL', en: 'en-US' }[String(lang || '').slice(0, 2)] || 'en-US';
}

/** Achievements and friends of an Xbox game (OpenXBL key in Options). */
async function xboxHub(g, lang, online) {
  if (!online) return { xbox: true, offline: true };
  const key = store.settings.xblApiKey;
  if (!key) return { xbox: true, needsXboxKey: true };
  if (!g.xboxTitleId) return { xbox: true, notLinked: true };
  try {
    const [achievements, friends] = await Promise.all([
      xbox.achievements(key, g.xboxTitleId, langTag(lang)),
      xbox.friendsForTitle(key, g.xboxTitleId).catch((err) => { if (err && (err.auth || err.offline)) throw err; return { list: [] }; }),
    ]);
    return { xbox: true, achievements, friends };
  } catch (err) {
    if (err && err.offline) return { xbox: true, offline: true };
    if (err && err.auth) return { xbox: true, xboxAuth: true };
    if (err && err.rateLimited) return { xbox: true, rateLimited: true };
    return { xbox: true, achievements: { error: 'failed' }, friends: { list: [] } };
  }
}

function snapshot() {
  return { ...library.snapshot(), hasBattery: library.hasBattery };
}

function gameOrError(id) {
  const g = library.get(id);
  if (!g) throw Object.assign(new Error('Game not found'), { code: 'notFound' });
  return g;
}

function mainWindowOrNull() {
  return win && !win.isDestroyed() ? win : null;
}

async function pickFile(filters, { folder = false } = {}) {
  const options = {
    properties: folder ? ['openDirectory'] : ['openFile'],
    filters: folder ? undefined : filters,
  };
  const parent = mainWindowOrNull();
  const res = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
  return res.filePaths[0];
}

function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------- settings side effects

const RESCAN_KEYS = ['sources', 'showUninstalledSteam', 'showUninstalledXbox', 'steamApiKey', 'steamId', 'xblApiKey', 'launchGogViaGalaxy', 'emulators', 'manualGames'];

function applySettingsSideEffects(prev, next) {
  const changed = (k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]);
  if (changed('startWithWindows') && app.isPackaged) {
    try { app.setLoginItemSettings({ openAtLogin: !!next.startWithWindows }); } catch (err) { log.warn('login item', err.message); }
  }
  if (changed('startFullscreen') && win && !win.isDestroyed()) win.setFullScreen(!!next.startFullscreen);
  if (changed('onlineMode')) connectivity.modeChanged().catch(() => {});
  if (changed('discordStatus') || changed('language')) updateDiscord();
  if (RESCAN_KEYS.some(changed)) {
    if (changed('steamApiKey') || changed('steamId')) store.steamWeb = {};
    if (changed('xblApiKey')) xbox.reset();
    library.scan('settings').catch((err) => log.error('scan', err));
  } else if (changed('sgdbApiKey') && next.sgdbApiKey) {
    artwork.enqueue(library.raw, { steamMeta: library.steamMeta, settings: next });
  }
}

// ---------------------------------------------------------------- IPC

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!win || event.sender !== win.webContents) throw new Error('unauthorized');
    try {
      return await fn(...args);
    } catch (err) {
      log.warn(`[ipc] ${channel}:`, err && err.message);
      return { error: (err && err.code) || 'failed', message: String(err && err.message || err) };
    }
  });
}

async function runAction(action) {
  try {
    await sessions.run(action);
    return { ok: true };
  } catch (err) {
    return { error: 'clientMissing', message: String(err && err.message || err) };
  }
}

function registerIpc() {
  handle('app:init', async () => ({
    settings: publicSettings(),
    library: snapshot(),
    profile: profileInfo(),
    net: netStatus(),
    update: updater ? updater.snapshot() : null,
    presets: PRESETS,
    system: {
      platform: process.platform,
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      locale: app.getLocale(),
      languages: typeof app.getPreferredSystemLanguages === 'function' ? app.getPreferredSystemLanguages() : [],
      fullscreen: !!(win && win.isFullScreen()),
      device: deviceSummary(),
    },
  }));
  handle('app:device', async () => deviceSummary());

  handle('settings:set', async (patch) => {
    if (!patch || typeof patch !== 'object') return publicSettings();
    const clean = { ...patch };
    delete clean.secrets;
    const prev = store.settings;
    const next = store.updateSettings(clean);
    applySettingsSideEffects(prev, next);
    return publicSettings();
  });

  handle('settings:reset', async () => {
    const prev = store.settings;
    const next = store.resetSettings();
    applySettingsSideEffects(prev, next);
    send('profile:updated', profileInfo());
    return publicSettings();
  });

  // Resets only the settings of one Options tab.
  handle('settings:resetSection', async (section) => {
    const patch = sectionDefaults(String(section || ''));
    if (!patch) return { error: 'invalid' };
    const prev = store.settings;
    let next = store.updateSettings(patch);
    if (patch.music === 'builtin' && prev.music === 'custom') next = store.updateSettings({ music: 'builtin' });
    applySettingsSideEffects(prev, next);
    if ('steamId' in patch) send('profile:updated', profileInfo());
    return publicSettings();
  });

  handle('settings:export', async () => {
    const options = {
      defaultPath: path.join(app.getPath('documents'), 'dream-launcher-settings.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    };
    const parent = mainWindowOrNull();
    const res = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    if (res.canceled || !res.filePath) return { canceled: true };
    const settings = { ...store.settings };
    for (const k of [...SECRET_KEYS, 'customMusicFile', 'customMusicName']) delete settings[k];
    const overrides = {};
    for (const [id, o] of Object.entries(store.overrides)) {
      const copy = { ...o };
      delete copy.customArt; // image files are not part of the export
      if (Object.keys(copy).length) overrides[id] = copy;
    }
    await writeJsonAtomic(res.filePath, { app: 'Dream Launcher', format: 1, exportedAt: new Date().toISOString(), settings, overrides });
    return { ok: true, path: res.filePath };
  });

  handle('settings:import', async () => {
    const file = await pickFile([{ name: 'JSON', extensions: ['json'] }]);
    if (!file) return { canceled: true };
    const data = await readJson(file);
    if (!data || data.app !== 'Dream Launcher' || !data.settings || typeof data.settings !== 'object') {
      return { error: 'invalidFile' };
    }
    const prev = store.settings;
    const keep = {};
    for (const k of [...SECRET_KEYS, 'customMusicFile', 'customMusicName']) keep[k] = prev[k];
    const next = sanitizeSettings({ ...data.settings, ...keep }, prev);
    if (next.music === 'custom' && !next.customMusicFile) next.music = 'builtin';
    store.settings = next;
    store.save('settings', 0);
    const imported = sanitizeOverrides(data.overrides);
    for (const [id, o] of Object.entries(imported)) {
      const cur = store.overrides[id] || {};
      store.overrides[id] = { ...o, ...(cur.customArt ? { customArt: cur.customArt } : {}) };
    }
    store.save('overrides', 0);
    applySettingsSideEffects(prev, next);
    library.emitUpdated(50);
    return { ok: true, settings: publicSettings() };
  });

  handle('library:get', async () => snapshot());
  handle('library:scan', async () => { await library.scan('manual'); return snapshot(); });

  handle('game:launch', async (id) => {
    const g = gameOrError(id);
    if (g.status === 'notInstalled' && g.install) return runAction(g.install);
    if (g.status === 'missing') return { error: 'missing' };
    // Note: Steam games that need an update are started anyway; Steam updates them first.
    if (sessions.isRunning(id)) return { error: 'alreadyRunning' };
    try {
      await sessions.launch(g);
      return { ok: true };
    } catch (err) {
      return { error: g.launch && g.launch.type === 'url' ? 'clientMissing' : 'launchFailed', message: String(err && err.message || err) };
    }
  });
  handle('game:install', async (id) => { const g = gameOrError(id); return g.install ? runAction(g.install) : { error: 'unsupported' }; });
  handle('game:update', async (id) => { const g = gameOrError(id); return g.update ? runAction(g.update) : { error: 'unsupported' }; });
  handle('game:openClient', async (id) => { const g = gameOrError(id); return g.client ? runAction(g.client) : { error: 'unsupported' }; });
  handle('game:showFolder', async (id) => {
    const g = gameOrError(id);
    if (g.romPath) { shell.showItemInFolder(g.romPath); return { ok: true }; }
    if (g.manualPath) { shell.showItemInFolder(g.manualPath); return { ok: true }; }
    if (!g.installDir) return { error: 'unsupported' };
    const err = await shell.openPath(g.installDir);
    return err ? { error: 'failed', message: err } : { ok: true };
  });
  handle('game:setFlags', async (id, patch) => {
    gameOrError(id);
    const p = patch && typeof patch === 'object' ? patch : {};
    const allowed = {};
    if ('favorite' in p) allowed.favorite = !!p.favorite;
    if ('hidden' in p) allowed.hidden = !!p.hidden;
    if ('subscription' in p) allowed.subscription = p.subscription || null;
    store.setOverride(id, allowed);
    library.emitUpdated(30);
    return library.toPublic(library.get(id));
  });
  handle('game:details', async (id, lang) => {
    const g = gameOrError(id);
    if (!connectivity.isOnline()) return { achievements: null, friends: null, offline: true };
    if (g.source !== 'steam') return { achievements: null, friends: null };
    const c = await steamCredsReady();
    if (c.missing) return { achievements: null, friends: null, needsKey: c.missing === 'key', needsId: c.missing === 'id' };
    const { key, steamId } = c;
    const achievements = g.installed || g.playtimeMinutes > 0 ? await steamWeb.achievements(key, steamId, g.sourceId, lang) : null;
    const friends = steamWeb.friendsFor(g.sourceId);
    if (!friends) steamWeb.buildFriendsIndex(key, steamId).catch(() => {});
    else steamWeb.refreshFriendsIfStale(key, steamId);
    return { achievements, friends };
  });
  // Everything for the slide-down panel under the tiles: achievements and friends.
  handle('game:hub', async (id, lang) => {
    const g = gameOrError(id);
    const online = connectivity.isOnline();
    if (g.source === 'xbox') return xboxHub(g, lang, online);
    if (g.emuKind) return { steam: false, emulator: g.emuKind, screenshots: await screenshotsFor(g).catch(() => []) };
    if (g.source !== 'steam') return { steam: false };
    // Screenshots are read from the Steam folder: they work without a Web API key.
    if (!library.steamMeta && library.scanning) await Promise.race([library.scanning.catch(() => {}), new Promise((r) => setTimeout(r, 20000))]);
    // Screenshots and clips (Steam game recording) are both on this PC.
    const [screenshots, clips] = await Promise.all([screenshotsFor(g).catch(() => []), clipsFor(g).catch(() => [])]);
    if (!online) return { steam: true, offline: true, screenshots, clips };
    const c = await steamCredsReady();
    if (c.missing) return { steam: true, needsKey: c.missing === 'key', needsId: c.missing === 'id', screenshots, clips };
    const { key, steamId } = c;
    const [achievements, friends] = await Promise.all([
      steamWeb.achievementsFull(key, steamId, g.sourceId, lang),
      steamWeb.friendsDetail(key, steamId, g.sourceId).catch(() => ({ list: [] })),
    ]);
    return { steam: true, achievements, friends, screenshots, clips };
  });
  // Everything the window needs to play a clip (pieces, formats, times).
  handle('clip:manifest', async (token) => {
    const clip = clipTokens.get(String(token || ''));
    if (!clip) return { error: 'notFound' };
    const m = await clipManifest(clip, (i, file) => `dl://clip/${token}/${i}/${encodeURIComponent(file)}`);
    if (!m.sessions.length) return { error: 'empty' };
    return m;
  });
  handle('clip:showInFolder', async (token) => {
    const clip = clipTokens.get(String(token || ''));
    if (!clip) return { error: 'notFound' };
    const err = await shell.openPath(clip.dir);
    return err ? { error: 'failed' } : { ok: true };
  });
  handle('shot:showInFolder', async (token) => {
    const info = shotTokens.get(String(token || ''));
    if (!info) return { error: 'notFound' };
    shell.showItemInFolder(info.path);
    return { ok: true };
  });
  // "X friends played" for every game at once (Steam app ids, and "xbox:<title id>").
  handle('steam:friendsSummary', async () => {
    if (!connectivity.isOnline()) return {};
    const ids = library.raw.filter((g) => g.source === 'steam').map((g) => g.sourceId);
    const out = steamWeb.friendsSummary(ids);
    const xboxIds = library.raw.filter((g) => g.source === 'xbox' && g.xboxTitleId).map((g) => g.xboxTitleId);
    if (store.settings.xblApiKey && xboxIds.length) {
      for (const [id, v] of Object.entries(xbox.friendsSummary(xboxIds))) out[`xbox:${id}`] = v;
    }
    return out;
  });
  handle('update:status', async () => updater.snapshot());
  handle('update:check', async () => {
    if (!UPDATE_REPO) return { ...updater.snapshot(), error: 'failed' };
    if (!connectivity.isOnline()) return { ...updater.snapshot(), error: 'offline' };
    return updater.check({ force: true });
  });
  handle('update:download', async () => {
    if (!connectivity.isOnline()) return { error: 'offline' };
    return updater.download();
  });
  // Starts the downloaded installer the way electron-builder's updater does (silent, same folder,
  // launcher restarts afterwards) and closes the launcher so it can be replaced.
  handle('update:install', async () => {
    const file = updater.readyFile();
    if (!file) return { error: 'notReady' };
    try {
      const child = spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' });
      child.on('error', (err) => log.error('[update] installer did not start', err));
      child.unref();
    } catch (err) {
      log.error('[update] installer did not start', err);
      return { error: 'failed' };
    }
    setTimeout(() => app.quit(), 400);
    return { ok: true };
  });
  handle('net:status', async () => netStatus());
  handle('net:check', async () => { await connectivity.check(); return netStatus(); });
  handle('xbox:test', async () => {
    if (!connectivity.isOnline()) return { error: 'offline' };
    const key = store.settings.xblApiKey;
    if (!key) return { error: 'noKey' };
    try {
      const acc = await xbox.account(key, { force: true });
      library.scan('xbox').catch(() => {});
      return { ok: true, name: acc.gamertag, gamerscore: acc.gamerscore };
    } catch (err) {
      return { error: err && err.auth ? 'auth' : (err && err.rateLimited ? 'rateLimited' : 'failed') };
    }
  });
  handle('game:stopTracking', async (id) => ({ ok: sessions.stop(String(id || '')) }));

  handle('manual:pick', async () => {
    const file = await pickFile([
      { name: 'Games and shortcuts', extensions: ['exe', 'lnk', 'url', 'bat', 'cmd'] },
      { name: 'All files', extensions: ['*'] },
    ]);
    if (!file) return { canceled: true };
    return { path: file, name: path.basename(file, path.extname(file)) };
  });
  handle('manual:save', async (entry) => {
    if (!entry || typeof entry !== 'object' || !entry.path) return { error: 'invalid' };
    const list = [...store.settings.manualGames];
    const id = entry.id && list.some((m) => m.id === entry.id) ? entry.id : newId();
    const item = { id, name: String(entry.name || ''), path: String(entry.path), args: String(entry.args || '') };
    const idx = list.findIndex((m) => m.id === id);
    if (idx >= 0) list[idx] = item; else list.push(item);
    const prev = store.settings;
    const next = store.updateSettings({ manualGames: list });
    applySettingsSideEffects(prev, next);
    return { ok: true, id: `manual:${id}` };
  });
  handle('manual:remove', async (gameId) => {
    const sid = String(gameId || '').replace(/^manual:/, '');
    const prev = store.settings;
    const next = store.updateSettings({ manualGames: store.settings.manualGames.filter((m) => m.id !== sid) });
    store.setOverride(`manual:${sid}`, { favorite: null, hidden: null, subscription: null, customArt: null });
    applySettingsSideEffects(prev, next);
    return { ok: true };
  });
  handle('manual:get', async (gameId) => {
    const sid = String(gameId || '').replace(/^manual:/, '');
    return store.settings.manualGames.find((m) => m.id === sid) || null;
  });

  handle('art:pickFile', async (id, kind) => {
    gameOrError(id);
    if (!ART_KINDS.includes(kind)) return { error: 'invalid' };
    const file = await pickFile([{ name: 'Images', extensions: IMAGE_EXTS }]);
    if (!file) return { canceled: true };
    const saved = await artwork.saveCustomFromFile(id, kind, file);
    const cur = store.getOverride(id).customArt || {};
    store.setOverride(id, { customArt: { ...cur, [kind]: saved } });
    library.emitUpdated(30);
    return { ok: true, game: library.toPublic(library.get(id)) };
  });
  handle('art:reset', async (id, kind) => {
    gameOrError(id);
    if (!ART_KINDS.includes(kind)) return { error: 'invalid' };
    const cur = { ...(store.getOverride(id).customArt || {}) };
    delete cur[kind];
    store.setOverride(id, { customArt: Object.keys(cur).length ? cur : null });
    library.emitUpdated(30);
    return { ok: true, game: library.toPublic(library.get(id)) };
  });
  handle('art:options', async (id, kind) => {
    const g = gameOrError(id);
    const key = store.settings.sgdbApiKey;
    if (!key) return { needsKey: true, items: [] };
    if (!connectivity.isOnline()) return { offline: true, items: [] };
    const items = await artwork.sgdbList(g, ART_KINDS.includes(kind) ? kind : 'cover', key);
    return { items };
  });
  handle('art:apply', async (id, kind, url) => {
    gameOrError(id);
    if (!ART_KINDS.includes(kind) || typeof url !== 'string' || !/^https:\/\//.test(url)) return { error: 'invalid' };
    const saved = await artwork.saveCustomFromUrl(id, kind, url);
    const cur = store.getOverride(id).customArt || {};
    store.setOverride(id, { customArt: { ...cur, [kind]: saved } });
    library.emitUpdated(30);
    return { ok: true, game: library.toPublic(library.get(id)) };
  });
  handle('art:refreshAll', async () => {
    artwork.enqueue(library.raw, { steamMeta: library.steamMeta, settings: store.settings }, { force: true });
    return { ok: true };
  });
  handle('art:clearCache', async () => {
    await artwork.clearCache();
    artwork.enqueue(library.raw, { steamMeta: library.steamMeta, settings: store.settings }, { force: true });
    library.emitUpdated(30);
    return { ok: true };
  });

  handle('emu:pickExe', async () => {
    const file = await pickFile([{ name: 'Programs', extensions: ['exe'] }, { name: 'All files', extensions: ['*'] }]);
    return file ? { path: file } : { canceled: true };
  });
  handle('emu:pickFolder', async () => {
    const dir = await pickFile(null, { folder: true });
    return dir ? { path: dir } : { canceled: true };
  });
  handle('emu:save', async (emu) => {
    if (!emu || typeof emu !== 'object') return { error: 'invalid' };
    const list = [...store.settings.emulators];
    const id = emu.id && list.some((e) => e.id === emu.id) ? emu.id : newId();
    const item = { ...emu, id };
    const idx = list.findIndex((e) => e.id === id);
    if (idx >= 0) list[idx] = item; else list.push(item);
    const prev = store.settings;
    const next = store.updateSettings({ emulators: list });
    applySettingsSideEffects(prev, next);
    return { ok: true, settings: publicSettings() };
  });
  handle('emu:remove', async (id) => {
    const prev = store.settings;
    const next = store.updateSettings({ emulators: store.settings.emulators.filter((e) => e.id !== id) });
    applySettingsSideEffects(prev, next);
    return { ok: true, settings: publicSettings() };
  });

  handle('profile:get', async () => profileInfo());

  handle('music:pick', async () => {
    const file = await pickFile([{ name: 'Audio', extensions: AUDIO_EXTS }]);
    if (!file) return { canceled: true };
    const ext = path.extname(file).toLowerCase();
    if (!AUDIO_EXTS.includes(ext.slice(1))) return { error: 'invalid' };
    const name = `music-${Date.now()}${ext}`;
    await fsp.copyFile(file, path.join(store.dirs.media, name));
    const old = store.settings.customMusicFile;
    const prev = store.settings;
    const next = store.updateSettings({ customMusicFile: name, customMusicName: path.basename(file), music: 'custom' });
    if (old && old !== name) fsp.unlink(path.join(store.dirs.media, old)).catch(() => {});
    applySettingsSideEffects(prev, next);
    return { ok: true, settings: publicSettings() };
  });

  handle('steam:test', async () => {
    if (!connectivity.isOnline()) return { error: 'offline' };
    const { key, steamId } = steamCreds();
    const res = await steamWeb.test(key, steamId);
    return res;
  });

  // Text in the clipboard, read only when the user presses "Paste key" (API keys window).
  handle('app:clipboardText', async () => ({ text: String(clipboard.readText() || '').trim().slice(0, 300) }));
  handle('app:openDataFolder', async () => {
    const err = await shell.openPath(app.getPath('userData'));
    return err ? { error: 'failed' } : { ok: true };
  });
  handle('app:openExternal', async (url) => {
    if (typeof url !== 'string' || !/^https:\/\/[\w.-]+(\/|$)/.test(url)) return { error: 'invalid' };
    await shell.openExternal(url);
    return { ok: true };
  });
  handle('app:quit', async () => { setTimeout(() => app.quit(), 50); return { ok: true }; });
  handle('app:minimize', async () => { if (win) win.minimize(); return { ok: true }; });
  handle('app:toggleFullscreen', async () => {
    if (!win) return { fullscreen: false };
    win.setFullScreen(!win.isFullScreen());
    return { fullscreen: win.isFullScreen() };
  });
}

// ---------------------------------------------------------------- window

function createWindow() {
  const s = store.settings;
  win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 960,
    minHeight: 540,
    show: false,
    backgroundColor: '#05081a',
    title: 'Dream Launcher',
    autoHideMenuBar: true,
    fullscreen: !!s.startFullscreen,
    icon: path.join(RENDERER_ROOT, 'img', 'icon-256.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.once('ready-to-show', () => { win.show(); win.focus(); });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://dream/')) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    if (!app.isPackaged && input.control && input.shift && String(input.key).toLowerCase() === 'i') {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });
  win.on('enter-full-screen', () => send('app:fullscreen', true));
  win.on('leave-full-screen', () => send('app:fullscreen', false));
  win.on('focus', () => { send('app:focus', true); if (sessions) sessions.checkNow(); maybeRescan(); });
  win.on('blur', () => send('app:focus', false));
  win.on('closed', () => { win = null; });
  win.loadURL('app://dream/index.html');
}

let lastFocusScan = 0;
function maybeRescan() {
  if (!library || library.scanning) return;
  const now = Date.now();
  if (now - library.lastScanAt < 60000 || now - lastFocusScan < 60000) return;
  lastFocusScan = now;
  library.scan('focus').catch(() => {});
}

// ---------------------------------------------------------------- startup

function wireEvents() {
  library.on('updated', () => send('library:updated', snapshot()));
  library.on('updated', () => updateDiscord());
  let scannedOnce = false;
  library.on('updated', () => {
    if (scannedOnce || !library.lastScanAt) return;
    scannedOnce = true;
    send('profile:updated', profileInfo());
    send('app:device', deviceSummary());
    const { key, steamId } = steamCreds();
    if (key && steamId) setTimeout(() => { if (connectivity.isOnline()) steamWeb.buildFriendsIndex(key, steamId).catch(() => {}); }, 15000);
    if (store.settings.xblApiKey) setTimeout(() => { if (connectivity.isOnline()) xbox.indexFriends(store.settings.xblApiKey).catch(() => {}); }, 20000);
  });
  updater.on('change', (s) => send('update:status', s));
  // Look for a new version right after start-up (the window shows the notice once the intro is
  // over), then every hour (GitHub is asked at most every 6 hours). A newer version is announced once.
  let checkedOnce = false;
  const autoCheck = async () => {
    if (!UPDATE_REPO || !store.settings.checkForUpdates || !connectivity.isOnline()) return;
    // The first check after start always asks GitHub (not the saved answer), so a version that
    // came out since the last check is offered right away instead of an older one.
    const force = !checkedOnce;
    checkedOnce = true;
    await updater.check({ force });
    if (updater.shouldAnnounce()) {
      send('update:announce', updater.snapshot());
      updater.markAnnounced();
    }
  };
  setTimeout(() => autoCheck().catch(() => {}), 3000).unref();
  setInterval(() => autoCheck().catch(() => {}), 60 * 60 * 1000).unref();
  connectivity.on('change', (state, prev) => {
    send('net:status', netStatus());
    if (state.online && !prev.online) {
      // Offline at start: look for updates as soon as the internet is there.
      if (!checkedOnce) autoCheck().catch(() => {});
      // Back online: refresh owned games, Xbox data and missing artwork.
      library.scan('online').catch(() => {});
    }
  });
  sessions.on('started', (id) => {
    library.setRunning(id, true);
    playing = { id, since: Date.now() };
    updateDiscord();
    send('game:started', id);
    if (store.settings.minimizeOnLaunch && win && !win.isDestroyed()) {
      setTimeout(() => { if (win && !win.isDestroyed() && sessions.isRunning(id)) win.minimize(); }, 1200);
    }
  });
  sessions.on('ended', (id, info) => {
    library.setRunning(id, false);
    if (playing && playing.id === id) { playing = null; updateDiscord(); }
    send('game:ended', id);
    // Cemu writes its play log when the game closes; the Xbox network updates a bit later.
    const g = library.get(id);
    if (g && (g.playtimeSource === 'cemu' || g.source === 'xbox')) {
      // Mark the Xbox numbers as old (kept for offline use) so the next sync fetches them again.
      if (g.source === 'xbox' && g.xboxTitleId && store.xbox && store.xbox.minutes && store.xbox.minutes[g.xboxTitleId]) store.xbox.minutes[g.xboxTitleId].at = 0;
      if (g.source === 'xbox' && store.xbox && store.xbox.titles) store.xbox.titles.at = 0;
      setTimeout(() => library.scan('session').catch(() => {}), g.source === 'xbox' ? 60000 : 4000);
    }
    if (info && info.detected && !info.manual && store.settings.restoreAfterPlaying && win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

function startTimers() {
  const downloads = setInterval(() => {
    if (library.hasActiveDownloads()) library.refreshDownloads().catch(() => {});
  }, 3000);
  const rescan = setInterval(() => {
    if (win && !win.isDestroyed() && win.isFocused()) maybeRescan();
  }, 10 * 60 * 1000);
  for (const t of [downloads, rescan]) if (t && typeof t.unref === 'function') t.unref();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    store = new Store(app.getPath('userData'));
    await store.load();
    thumbs = new Thumbs({ dir: store.dirs.thumbs, nativeImage });
    connectivity = new Connectivity({
      fetch: (url, opts) => net.fetch(url, opts),
      getMode: () => store.settings.onlineMode,
      linkUp: () => (typeof net.isOnline === 'function' ? net.isOnline() : true),
      log,
    });
    // Everything that goes to the internet uses this: it refuses at once while offline.
    const fetchFn = connectivity.onlineFetch();
    const isOnline = () => connectivity.isOnline();
    artwork = new Artwork({ store, fetch: fetchFn, log, isOnline });
    steamWeb = new SteamWeb({ store, fetch: fetchFn, log, onFriendsBuilt: () => send('steam:friends') });
    xbox = new XboxLive({ store, fetch: fetchFn, log });
    library = new Library({ store, probe: runProbe, artwork, steamWeb, xbox, isOnline, log });
    updater = new Updater({ repo: UPDATE_REPO, currentVersion: app.getVersion(), fetch: fetchFn, store, tempDir: app.getPath('temp'), log });
    discord = new DiscordPresence({ log });
    sessions = new Sessions({
      openExternal: (url) => shell.openExternal(url),
      openPath: (p) => shell.openPath(p),
      listProcesses,
      listProcessNames,
      store,
      log,
    });

    const decodePath = (u) => {
      try { return decodeURIComponent(u.pathname); } catch { return null; }
    };
    protocol.handle('app', (req) => {
      const u = new URL(req.url);
      if (u.host !== 'dream') return new Response('Not found', { status: 404 });
      let rel = decodePath(u);
      if (rel === null) return new Response('Bad request', { status: 400 });
      if (rel === '/' || rel === '') rel = '/index.html';
      return serveFile(RENDERER_ROOT, rel, req);
    });
    protocol.handle('dl', (req) => {
      const u = new URL(req.url);
      if (u.host === 'shot') return serveShot(u.pathname.replace(/^\//, ''), u.searchParams);
      if (u.host === 'clip') return serveClip(u.pathname);
      const roots = { art: store.dirs.art, media: store.dirs.media };
      const root = roots[u.host];
      const rel = decodePath(u);
      if (!root || rel === null) return new Response('Not found', { status: 404 });
      return serveFile(root, rel, req);
    });

    registerIpc();
    wireEvents();
    createWindow();
    startTimers();
    setTimeout(() => { if (thumbs) thumbs.prune().catch(() => {}); }, 60000).unref();
    connectivity.start();
    updateDiscord();
    // Know online/offline before the first scan (at most a few seconds), so nothing that needs
    // the internet is attempted, and remembered as failed, while there is none.
    Promise.race([connectivity.check(), new Promise((r) => setTimeout(r, 3000))])
      .finally(() => library.scan('startup').catch((err) => log.error('startup scan failed', err)));
    setTimeout(() => refreshDevice().catch(() => {}), 2500);
  });

  app.on('window-all-closed', () => app.quit());

  app.on('will-quit', (e) => {
    if (quitting || !store) return;
    e.preventDefault();
    quitting = true;
    if (sessions) sessions.stopAll();
    if (discord) discord.stop();
    store.flush().finally(() => app.exit(0));
  });
}
