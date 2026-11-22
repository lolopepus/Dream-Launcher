'use strict';
/** Games the user added by hand (any .exe, shortcut or file). */
const path = require('path');
const { isFile } = require('../util/fsx');
const { splitArgs } = require('../util/args');

async function scanManual(ctx) {
  const list = (ctx.settings && ctx.settings.manualGames) || [];
  const games = [];
  for (const m of list) {
    if (!m || !m.path) continue;
    const present = await isFile(m.path);
    const ext = path.extname(m.path).toLowerCase();
    const isExe = ext === '.exe';
    const name = (m.name && m.name.trim()) || path.basename(m.path, path.extname(m.path));
    games.push({
      id: `manual:${m.id}`,
      source: 'manual',
      sourceId: m.id,
      name,
      installed: present,
      status: present ? 'installed' : 'missing',
      progress: null,
      installDir: path.dirname(m.path),
      sizeBytes: 0,
      playtimeMinutes: 0,
      lastPlayed: 0,
      launch: isExe
        ? { type: 'exe', path: m.path, args: splitArgs(m.args || ''), cwd: path.dirname(m.path) }
        : { type: 'open', path: m.path },
      client: null,
      tracksOwnPlaytime: false,
      manualArgs: m.args || '',
      manualPath: m.path,
    });
  }
  return { available: list.length > 0, games };
}

module.exports = { scanManual };
