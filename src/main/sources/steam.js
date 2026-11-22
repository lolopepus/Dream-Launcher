'use strict';
/**
 * Steam: finds the Steam folder, all library folders, installed games (appmanifest files),
 * the most recent user (playtime / last played from localconfig.vdf) and the profile name/avatar.
 */
const path = require('path');
const { parseVdf, vdfGet, toInt } = require('../util/vdf');
const { readText, listDir, isDir, exists, normKey } = require('../util/fsx');

const STEAM_ID64_BASE = 76561197960265728n;

// Tools and runtimes that are not games.
const EXCLUDED_APPIDS = new Set([
  228980, // Steamworks Common Redistributables
  250820, // SteamVR
  1070560, 1391110, 1628350, // Steam Linux Runtime
  1493710, 2180100, // Proton Experimental / Hotfix
  1826330, 1161040, // Proton EasyAntiCheat / BattlEye runtimes
]);
const EXCLUDED_NAME = /^(Steamworks Common Redistributables|Steam Linux Runtime|Proton\b|SteamVR\b)/i;

const FLAGS = {
  UPDATE_REQUIRED: 2,
  FULLY_INSTALLED: 4,
  UPDATE_RUNNING: 256,
  UPDATE_PAUSED: 512,
  UPDATE_STARTED: 1024,
  PREALLOCATING: 524288,
  DOWNLOADING: 1048576,
  STAGING: 2097152,
  COMMITTING: 4194304,
};
const ACTIVE_MASK = FLAGS.UPDATE_RUNNING | FLAGS.UPDATE_STARTED | FLAGS.PREALLOCATING | FLAGS.DOWNLOADING | FLAGS.STAGING | FLAGS.COMMITTING;

function statusFromFlags(flags) {
  const full = (flags & FLAGS.FULLY_INSTALLED) !== 0;
  if (flags & ACTIVE_MASK) return full ? 'updating' : 'installing';
  if (flags & (FLAGS.UPDATE_REQUIRED | FLAGS.UPDATE_PAUSED)) return full ? 'updateRequired' : 'installing';
  return full ? 'installed' : 'installing';
}

function progressFromManifest(state) {
  const toDl = toInt(vdfGet(state, 'BytesToDownload'));
  const dl = toInt(vdfGet(state, 'BytesDownloaded'));
  if (toDl > 0) return Math.max(0, Math.min(1, dl / toDl));
  const toStage = toInt(vdfGet(state, 'BytesToStage'));
  const staged = toInt(vdfGet(state, 'BytesStaged'));
  if (toStage > 0) return Math.max(0, Math.min(1, staged / toStage));
  return null;
}

function findSteamPath(ctx) {
  const candidates = [];
  const hkcu = ctx.reg.value('HKEY_CURRENT_USER\\Software\\Valve\\Steam', 'SteamPath');
  if (typeof hkcu === 'string' && hkcu) candidates.push(hkcu);
  const hklm = ctx.reg.value('HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath');
  if (typeof hklm === 'string' && hklm) candidates.push(hklm);
  const hklm32 = ctx.reg.value('HKEY_LOCAL_MACHINE\\SOFTWARE\\Valve\\Steam', 'InstallPath');
  if (typeof hklm32 === 'string' && hklm32) candidates.push(hklm32);
  const pf86 = ctx.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  candidates.push(path.win32.join(pf86, 'Steam'));
  return candidates.map((p) => p.replace(/\//g, path.sep === '\\' ? '\\' : '/'));
}

async function resolveSteamPath(ctx) {
  for (const p of findSteamPath(ctx)) {
    if (await isDir(path.join(p, 'steamapps'))) return p;
  }
  return null;
}

function libraryPathsFromVdf(data) {
  const out = [];
  const root = vdfGet(data, 'libraryfolders') || vdfGet(data, 'LibraryFolders');
  if (!root || typeof root !== 'object') return out;
  for (const [key, val] of Object.entries(root)) {
    if (val && typeof val === 'object') {
      const p = vdfGet(val, 'path');
      if (typeof p === 'string' && p) out.push(p);
    } else if (/^\d+$/.test(key) && typeof val === 'string' && val) {
      out.push(val); // old format: "1" "D:\\SteamLibrary"
    }
  }
  return out;
}

async function readLibraryFolders(steamPath) {
  const result = [steamPath];
  for (const rel of [['steamapps', 'libraryfolders.vdf'], ['config', 'libraryfolders.vdf']]) {
    const text = await readText(path.join(steamPath, ...rel));
    if (!text) continue;
    try { result.push(...libraryPathsFromVdf(parseVdf(text))); } catch { /* ignore malformed */ }
  }
  const seen = new Set();
  const out = [];
  for (const p of result) {
    const k = normKey(p);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

async function readManifest(file, libraryPath) {
  const text = await readText(file);
  if (!text) return null;
  let data;
  try { data = parseVdf(text); } catch { return null; }
  const state = vdfGet(data, 'AppState');
  if (!state || typeof state !== 'object') return null;
  const appId = toInt(vdfGet(state, 'appid'), 0);
  const name = vdfGet(state, 'name');
  if (!appId || typeof name !== 'string' || !name.trim()) return null;
  if (EXCLUDED_APPIDS.has(appId) || EXCLUDED_NAME.test(name)) return null;
  const flags = toInt(vdfGet(state, 'StateFlags'), 0);
  const installdir = vdfGet(state, 'installdir');
  const status = statusFromFlags(flags);
  return {
    appId,
    name: name.trim(),
    flags,
    status,
    progress: status === 'installing' || status === 'updating' ? progressFromManifest(state) : null,
    installDir: typeof installdir === 'string' && installdir ? path.join(libraryPath, 'steamapps', 'common', installdir) : null,
    sizeBytes: toInt(vdfGet(state, 'SizeOnDisk'), 0),
    lastPlayedSec: toInt(vdfGet(state, 'LastPlayed'), 0),
    manifestPath: file,
  };
}

async function readUser(steamPath, preferredId64) {
  const text = await readText(path.join(steamPath, 'config', 'loginusers.vdf'));
  if (!text) return null;
  let users;
  try { users = vdfGet(parseVdf(text), 'users'); } catch { return null; }
  if (!users || typeof users !== 'object') return null;
  const entries = Object.entries(users).filter(([id]) => /^\d{17}$/.test(id));
  if (!entries.length) return null;
  let chosen = null;
  if (preferredId64) chosen = entries.find(([id]) => id === preferredId64) || null;
  if (!chosen) chosen = entries.find(([, u]) => String(vdfGet(u, 'MostRecent')) === '1') || null;
  if (!chosen) chosen = entries.slice().sort((a, b) => toInt(vdfGet(b[1], 'Timestamp')) - toInt(vdfGet(a[1], 'Timestamp')))[0];
  const [id64, info] = chosen;
  let accountId;
  try { accountId = (BigInt(id64) - STEAM_ID64_BASE).toString(); } catch { return null; }
  const avatar = path.join(steamPath, 'config', 'avatarcache', `${id64}.png`);
  return {
    id64,
    accountId,
    personaName: String(vdfGet(info, 'PersonaName') || vdfGet(info, 'AccountName') || ''),
    avatarPath: (await exists(avatar)) ? avatar : null,
  };
}

/** Reads per-game Playtime (minutes) and LastPlayed (unix seconds) from localconfig.vdf. */
async function readUserApps(steamPath, accountId) {
  const map = new Map();
  if (!accountId) return map;
  const text = await readText(path.join(steamPath, 'userdata', accountId, 'config', 'localconfig.vdf'));
  if (!text) return map;
  let apps;
  try { apps = vdfGet(parseVdf(text), 'UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps'); } catch { return map; }
  if (!apps || typeof apps !== 'object') return map;
  for (const [id, info] of Object.entries(apps)) {
    if (!/^\d+$/.test(id) || !info || typeof info !== 'object') continue;
    map.set(Number(id), {
      playtime: toInt(vdfGet(info, 'Playtime'), 0),
      lastPlayedSec: toInt(vdfGet(info, 'LastPlayed'), 0),
    });
  }
  return map;
}

async function scanSteam(ctx) {
  const steamPath = await resolveSteamPath(ctx);
  if (!steamPath) return { available: false, games: [], meta: null };
  const libraries = await readLibraryFolders(steamPath);
  const manifests = [];
  for (const lib of libraries) {
    const dir = path.join(lib, 'steamapps');
    const entries = await listDir(dir);
    for (const e of entries) {
      if (!e.isFile() || !/^appmanifest_\d+\.acf$/i.test(e.name)) continue;
      manifests.push(readManifest(path.join(dir, e.name), lib));
    }
  }
  const results = (await Promise.all(manifests)).filter(Boolean);
  const user = await readUser(steamPath, ctx.settings && ctx.settings.steamId);
  const userApps = await readUserApps(steamPath, user && user.accountId);

  const byId = new Map();
  for (const m of results) {
    if (byId.has(m.appId)) continue; // same app in two libraries: keep the first
    const u = userApps.get(m.appId);
    const lastSec = Math.max(m.lastPlayedSec || 0, (u && u.lastPlayedSec) || 0);
    byId.set(m.appId, {
      id: `steam:${m.appId}`,
      source: 'steam',
      sourceId: String(m.appId),
      name: m.name,
      installed: m.status !== 'installing',
      status: m.status,
      progress: m.progress,
      installDir: m.installDir,
      sizeBytes: m.sizeBytes,
      playtimeMinutes: u ? u.playtime : 0,
      lastPlayed: lastSec > 0 ? lastSec * 1000 : 0,
      launch: { type: 'url', url: `steam://rungameid/${m.appId}` },
      install: { type: 'url', url: `steam://install/${m.appId}` },
      update: { type: 'url', url: 'steam://open/downloads' },
      client: { type: 'url', url: `steam://nav/games/details/${m.appId}` },
      tracksOwnPlaytime: true,
      manifestPath: m.manifestPath,
    });
  }
  return {
    available: true,
    games: [...byId.values()],
    meta: {
      steamPath,
      libraryCache: path.join(steamPath, 'appcache', 'librarycache'),
      user,
      playtimeByApp: userApps,
    },
  };
}

/** Re-reads only the manifests of games that are currently downloading (cheap progress polling). */
async function refreshDownloading(games) {
  const updates = [];
  for (const g of games) {
    if (g.source !== 'steam' || !g.manifestPath || (g.status !== 'installing' && g.status !== 'updating')) continue;
    const libraryPath = path.dirname(path.dirname(g.manifestPath));
    const m = await readManifest(g.manifestPath, libraryPath);
    if (!m) { updates.push({ id: g.id, removed: true }); continue; }
    updates.push({ id: g.id, status: m.status, progress: m.progress, installed: m.status !== 'installing', sizeBytes: m.sizeBytes });
  }
  return updates;
}

module.exports = {
  scanSteam, refreshDownloading, statusFromFlags, libraryPathsFromVdf, readManifest, readUser, readUserApps, FLAGS,
};
