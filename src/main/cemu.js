'use strict';
/**
 * Playtime recorded by Cemu (Wii U emulator).
 *
 * Cemu keeps the Wii U's own play log ("PDM") in its MLC folder:
 *   <mlc01>\usr\save\system\pdm\<user>\PlayStats.dat      (Cemu uses user 80000001)
 * Layout (big-endian, like the console): u32 entry count, then 256 entries of 20 bytes:
 *   u64 title id · u32 minutes played · u16 times played · u16 first played · u16 last played · u16 unused
 * Dates are days since 1 January 2000.
 *
 * The MLC folder is next to Cemu.exe (portable), in %APPDATA%\Cemu, or wherever settings.xml's
 * <mlc_path> points.
 */
const path = require('path');
const fsp = require('fs').promises;

const ENTRY_SIZE = 20;
const MAX_ENTRIES = 256;
const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_PLAUSIBLE_DAY = 4700; // late 2012 (Wii U launch)

/** Local midnight of "days since 1 January 2000". */
function dayToMs(days) {
  return new Date(2000, 0, 1 + days).getTime();
}

function plausibleDay(days, now = Date.now()) {
  if (!days || days < FIRST_PLAUSIBLE_DAY) return false;
  return dayToMs(days) <= now + 2 * DAY_MS;
}

/** Parses PlayStats.dat → Map(titleIdHex16 → { minutes, launches, firstPlayed, lastPlayed }). */
function parsePlayStats(buf, now = Date.now()) {
  const out = new Map();
  if (!Buffer.isBuffer(buf) || buf.length < 4 + ENTRY_SIZE) return out;
  const declared = buf.readUInt32BE(0);
  const fits = Math.floor((buf.length - 4) / ENTRY_SIZE);
  const count = Math.min(declared, MAX_ENTRIES, fits);
  for (let i = 0; i < count; i++) {
    const off = 4 + i * ENTRY_SIZE;
    const hi = buf.readUInt32BE(off);
    const lo = buf.readUInt32BE(off + 4);
    if (!hi && !lo) continue;
    const id = hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
    const minutes = buf.readUInt32BE(off + 8);
    const launches = buf.readUInt16BE(off + 12);
    const first = buf.readUInt16BE(off + 14);
    const last = buf.readUInt16BE(off + 16);
    const prev = out.get(id) || { minutes: 0, launches: 0, firstPlayed: 0, lastPlayed: 0 };
    prev.minutes += minutes;
    prev.launches += launches;
    if (plausibleDay(first, now)) {
      const t = dayToMs(first);
      prev.firstPlayed = prev.firstPlayed ? Math.min(prev.firstPlayed, t) : t;
    }
    if (plausibleDay(last, now)) prev.lastPlayed = Math.max(prev.lastPlayed, dayToMs(last));
    out.set(id, prev);
  }
  return out;
}

async function readText(p) {
  try { return await fsp.readFile(p, 'utf8'); } catch { return null; }
}

async function isDir(p) {
  try { return (await fsp.stat(p)).isDirectory(); } catch { return false; }
}

/** Folders that may hold Cemu's settings.xml and mlc01, most specific first. */
function dataDirs(exePath, env = process.env) {
  const exeDir = path.dirname(exePath || '');
  const dirs = [];
  if (exePath) dirs.push(path.join(exeDir, 'portable'), exeDir);
  if (env && env.APPDATA) dirs.push(path.join(env.APPDATA, 'Cemu'));
  return [...new Set(dirs)];
}

function mlcPathFromSettings(xml) {
  if (!xml) return '';
  const m = /<mlc_path>([^<]*)<\/mlc_path>/i.exec(xml);
  return m ? m[1].trim() : '';
}

/** All MLC folders that exist for this Cemu installation. */
async function findMlcDirs(exePath, env = process.env) {
  const out = [];
  for (const dir of dataDirs(exePath, env)) {
    const custom = mlcPathFromSettings(await readText(path.join(dir, 'settings.xml')));
    for (const cand of [custom, path.join(dir, 'mlc01')]) {
      if (cand && !out.some((x) => x.toLowerCase() === cand.toLowerCase()) && (await isDir(cand))) out.push(cand);
    }
  }
  return out;
}

/**
 * Cemu's playtime for all titles. Returns null when no play log was found at all (so the
 * launcher keeps counting itself), otherwise a Map (possibly empty: nothing played yet).
 */
async function readCemuPlaytime(exePath, env = process.env, now = Date.now()) {
  let found = false;
  const merged = new Map();
  for (const mlc of await findMlcDirs(exePath, env)) {
    const pdm = path.join(mlc, 'usr', 'save', 'system', 'pdm');
    let users = [];
    try { users = (await fsp.readdir(pdm, { withFileTypes: true })).filter((e) => e.isDirectory() && /^8[0-9a-f]{7}$/i.test(e.name)).map((e) => e.name); } catch { users = []; }
    for (const user of users) {
      let buf;
      try { buf = await fsp.readFile(path.join(pdm, user, 'PlayStats.dat')); } catch { continue; }
      found = true;
      for (const [id, st] of parsePlayStats(buf, now)) {
        const cur = merged.get(id);
        if (!cur) { merged.set(id, { ...st }); continue; }
        // The same log seen through two paths (e.g. portable + custom mlc) must not count twice.
        cur.minutes = Math.max(cur.minutes, st.minutes);
        cur.launches = Math.max(cur.launches, st.launches);
        cur.lastPlayed = Math.max(cur.lastPlayed, st.lastPlayed);
        if (st.firstPlayed) cur.firstPlayed = cur.firstPlayed ? Math.min(cur.firstPlayed, st.firstPlayed) : st.firstPlayed;
      }
    }
  }
  return found ? merged : null;
}

function isCemu(emu) {
  if (!emu) return false;
  if (emu.preset === 'cemu') return true;
  return /^cemu[^\\/]*\.exe$/i.test(path.basename(String(emu.exe || '')));
}

module.exports = { parsePlayStats, readCemuPlaytime, findMlcDirs, dataDirs, dayToMs, isCemu };
