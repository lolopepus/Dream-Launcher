'use strict';
/**
 * Epic Games Store: reads the launcher's install manifests (*.item JSON files).
 * Launch URL format (from Epic's protocol documentation):
 *   com.epicgames.launcher://apps/<Namespace>%3A<CatalogItemId>%3A<AppName>?action=launch&silent=true
 */
const path = require('path');
const { readJson, listDir, isDir } = require('../util/fsx');

function manifestDir(ctx) {
  const fromReg = ctx.reg.value('HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Epic Games\\EpicGamesLauncher', 'AppDataPath');
  const dirs = [];
  if (typeof fromReg === 'string' && fromReg) dirs.push(path.join(fromReg, 'Manifests'));
  const programData = ctx.env.ProgramData || ctx.env.PROGRAMDATA || 'C:\\ProgramData';
  dirs.push(path.join(programData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests'));
  return dirs;
}

function launchUrl(m) {
  const enc = (s) => encodeURIComponent(String(s));
  if (m.CatalogNamespace && m.CatalogItemId) {
    return `com.epicgames.launcher://apps/${enc(m.CatalogNamespace)}%3A${enc(m.CatalogItemId)}%3A${enc(m.AppName)}?action=launch&silent=true`;
  }
  return `com.epicgames.launcher://apps/${enc(m.AppName)}?action=launch&silent=true`;
}

function isGame(m) {
  if (!m || typeof m !== 'object') return false;
  if (typeof m.AppName !== 'string' || !m.AppName) return false;
  if (typeof m.DisplayName !== 'string' || !m.DisplayName.trim()) return false;
  if (m.MainGameAppName && m.MainGameAppName !== m.AppName) return false; // DLC / add-on
  if (Array.isArray(m.AppCategories) && m.AppCategories.length && !m.AppCategories.includes('games')) return false;
  return true;
}

async function scanEpic(ctx) {
  let dir = null;
  for (const d of manifestDir(ctx)) {
    if (await isDir(d)) { dir = d; break; }
  }
  if (!dir) return { available: false, games: [] };
  const entries = await listDir(dir);
  const games = [];
  const seen = new Set();
  for (const e of entries) {
    if (!e.isFile() || !/\.item$/i.test(e.name)) continue;
    const m = await readJson(path.join(dir, e.name));
    if (!isGame(m) || seen.has(m.AppName)) continue;
    if (!m.InstallLocation || !(await isDir(m.InstallLocation))) continue;
    seen.add(m.AppName);
    const incomplete = m.bIsIncompleteInstall === true;
    games.push({
      id: `epic:${m.AppName}`,
      source: 'epic',
      sourceId: m.AppName,
      name: m.DisplayName.trim(),
      installed: !incomplete,
      status: incomplete ? 'installing' : 'installed',
      progress: null,
      installDir: m.InstallLocation,
      sizeBytes: Number(m.InstallSize) > 0 ? Number(m.InstallSize) : 0,
      playtimeMinutes: 0,
      lastPlayed: 0,
      launch: { type: 'url', url: launchUrl(m) },
      client: { type: 'url', url: 'com.epicgames.launcher://store' },
      tracksOwnPlaytime: false,
    });
  }
  return { available: true, games };
}

module.exports = { scanEpic, launchUrl, isGame };
