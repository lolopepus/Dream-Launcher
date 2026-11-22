'use strict';
/**
 * GOG: installed games are registered under HKLM\SOFTWARE\WOW6432Node\GOG.com\Games\<id>
 * by both GOG Galaxy and the offline installers. The game folder contains goggame-<id>.info
 * with the official launch task (exe, arguments, working dir).
 */
const path = require('path');
const { readJson, isDir, isFile } = require('../util/fsx');

const GAME_KEYS = [
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\GOG.com\\Games',
];

function galaxyExe(ctx) {
  const base = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\GalaxyClient';
  const dir = ctx.reg.value(`${base}\\paths`, 'client');
  const exe = ctx.reg.value(base, 'clientExecutable') || 'GalaxyClient.exe';
  if (typeof dir === 'string' && dir) return path.join(dir, String(exe));
  return null;
}

/** Picks the primary play task from a goggame-<id>.info file. */
function primaryTask(info) {
  if (!info || !Array.isArray(info.playTasks)) return null;
  const files = info.playTasks.filter((t) => t && t.type === 'FileTask' && typeof t.path === 'string' && t.path);
  return files.find((t) => t.isPrimary) || files.find((t) => t.category === 'game') || files[0] || null;
}

async function buildLaunch(installDir, id, regData, reg) {
  const info = await readJson(path.join(installDir, `goggame-${id}.info`));
  const task = primaryTask(info);
  if (task) {
    const exe = path.isAbsolute(task.path) ? task.path : path.join(installDir, task.path);
    const cwd = task.workingDir ? (path.isAbsolute(task.workingDir) ? task.workingDir : path.join(installDir, task.workingDir)) : path.dirname(exe);
    if (await isFile(exe)) return { type: 'exe', path: exe, args: typeof task.arguments === 'string' ? task.arguments : '', cwd };
  }
  const exe = reg.get(regData, 'exe');
  if (typeof exe === 'string' && exe && (await isFile(exe))) {
    const wd = reg.get(regData, 'workingDir');
    return {
      type: 'exe',
      path: exe,
      args: String(reg.get(regData, 'launchParam') || ''),
      cwd: typeof wd === 'string' && wd ? wd : path.dirname(exe),
    };
  }
  return null;
}

async function scanGog(ctx) {
  const seen = new Set();
  const games = [];
  let any = false;
  const galaxy = galaxyExe(ctx);
  for (const keyPath of GAME_KEYS) {
    const subs = ctx.reg.subkeys(keyPath);
    if (subs.length) any = true;
    for (const { name: keyName, data } of subs) {
      const id = String(ctx.reg.get(data, 'gameID') || keyName);
      if (!/^\d+$/.test(id) || seen.has(id)) continue;
      const dependsOn = ctx.reg.get(data, 'dependsOn');
      if (typeof dependsOn === 'string' && dependsOn.trim()) continue; // DLC
      const title = ctx.reg.get(data, 'gameName') || ctx.reg.get(data, 'GAMENAME');
      const installDir = ctx.reg.get(data, 'path') || ctx.reg.get(data, 'PATH');
      if (typeof title !== 'string' || !title.trim() || typeof installDir !== 'string' || !(await isDir(installDir))) continue;
      const launch = await buildLaunch(installDir, id, data, ctx.reg);
      if (!launch) continue;
      seen.add(id);
      const galaxyLaunch = galaxy ? { type: 'exe', path: galaxy, args: ['/command=runGame', `/gameId=${id}`, `/path=${installDir}`], cwd: path.dirname(galaxy) } : null;
      games.push({
        id: `gog:${id}`,
        source: 'gog',
        sourceId: id,
        name: title.trim(),
        installed: true,
        status: 'installed',
        progress: null,
        installDir,
        sizeBytes: 0,
        playtimeMinutes: 0,
        lastPlayed: 0,
        launch: ctx.settings && ctx.settings.launchGogViaGalaxy && galaxyLaunch ? galaxyLaunch : launch,
        client: galaxy ? { type: 'exe', path: galaxy, args: [], cwd: path.dirname(galaxy) } : null,
        tracksOwnPlaytime: false,
      });
    }
  }
  return { available: any || !!galaxy, games };
}

module.exports = { scanGog, primaryTask };
