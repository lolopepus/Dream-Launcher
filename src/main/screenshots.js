'use strict';
/**
 * Steam screenshots of a game on this PC:
 *   <Steam>\userdata\<account id>\760\remote\<app id>\screenshots\*.jpg (+ thumbnails\)
 * Files are only listed here; the main process serves them to the interface by token.
 */
const path = require('path');
const fsp = require('fs').promises;

const IMAGE_RE = /\.(jpe?g|png)$/i;
const MAX_ITEMS = 400;

async function listImages(dir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !IMAGE_RE.test(e.name)) continue;
    const full = path.join(dir, e.name);
    let st;
    try { st = await fsp.stat(full); } catch { continue; }
    out.push({ path: full, name: e.name, time: st.mtimeMs });
    if (out.length >= MAX_ITEMS * 2) break;
  }
  return out;
}

/** Steam screenshots of an app for one Steam account, newest first. */
async function steamScreenshots(steamPath, accountId, appId) {
  if (!steamPath || !accountId || !appId) return [];
  const base = path.join(steamPath, 'userdata', String(accountId), '760', 'remote', String(appId), 'screenshots');
  const files = await listImages(base);
  const thumbs = new Set((await listImages(path.join(base, 'thumbnails'))).map((f) => f.name.toLowerCase()));
  return files
    .map((f) => ({ path: f.path, thumbPath: thumbs.has(f.name.toLowerCase()) ? path.join(base, 'thumbnails', f.name) : null, time: f.time }))
    .sort((a, b) => b.time - a.time)
    .slice(0, MAX_ITEMS);
}

module.exports = { steamScreenshots };
