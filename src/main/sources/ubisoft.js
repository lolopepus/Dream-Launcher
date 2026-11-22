'use strict';
/**
 * Ubisoft Connect: installs are listed under HKLM\SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs\<id>
 * (value InstallDir). The display name comes from the uninstall entry "Uplay Install <id>".
 * Launch: uplay://launch/<id>/0
 */
const path = require('path');
const { isDir, isFile } = require('../util/fsx');

const INSTALLS = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs';
const UNINSTALL = [
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

function displayName(ctx, id) {
  for (const base of UNINSTALL) {
    const name = ctx.reg.value(`${base}\\Uplay Install ${id}`, 'DisplayName');
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return null;
}

async function findClient(launcherDir) {
  if (typeof launcherDir !== 'string' || !launcherDir) return null;
  for (const exe of ['UbisoftConnect.exe', 'upc.exe']) {
    const p = path.join(launcherDir, exe);
    if (await isFile(p)) return { type: 'exe', path: p, args: [], cwd: launcherDir };
  }
  return null;
}

async function scanUbisoft(ctx) {
  const subs = ctx.reg.subkeys(INSTALLS);
  const launcherDir = ctx.reg.value('HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher', 'InstallDir');
  const client = await findClient(launcherDir);
  const games = [];
  for (const { name: id, data } of subs) {
    if (!/^\d+$/.test(id)) continue;
    let dir = ctx.reg.get(data, 'InstallDir');
    if (typeof dir !== 'string' || !dir) continue;
    dir = path.normalize(dir);
    if (!(await isDir(dir))) continue;
    const name = displayName(ctx, id) || path.basename(dir.replace(/[\\/]+$/, ''));
    games.push({
      id: `ubisoft:${id}`,
      source: 'ubisoft',
      sourceId: id,
      name,
      installed: true,
      status: 'installed',
      progress: null,
      installDir: dir,
      sizeBytes: 0,
      playtimeMinutes: 0,
      lastPlayed: 0,
      launch: { type: 'url', url: `uplay://launch/${id}/0` },
      client,
      tracksOwnPlaytime: false,
    });
  }
  return { available: subs.length > 0 || (typeof launcherDir === 'string' && !!launcherDir), games };
}

module.exports = { scanUbisoft };
