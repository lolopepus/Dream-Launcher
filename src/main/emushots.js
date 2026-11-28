'use strict';
/**
 * Screenshots of emulator games, and the game IDs they are matched with.
 *
 *  Cemu     <data>\screenshots\Screenshot_2026-11-22_17-30-05[_GamePad][_2].png      no game in the name
 *  Dolphin  <User>\ScreenShots\GALE01\GALE01_2026-11-22_17-30-05[_2].png              (older: GALE01-1.png)
 *  PPSSPP   <memstick>\PSP\SCREENSHOT\ULUS10041_00000.png / .jpg
 *  RPCS3    <config>\screenshots\BLUS30443\BLUS30443_screenshot_2026_11_22_17_30_05.png
 *
 * Where these folders are and how the files are named was taken from each emulator's source code.
 * A screenshot belongs to a game when its ID matches the ID read from the game file (disc header,
 * PARAM.SFO). If a game's ID can't be read (compressed formats like CHD), the times it was played
 * through Dream Launcher tell which screenshots are its own.
 */
const path = require('path');
const zlib = require('zlib');
const fsp = require('fs').promises;
const { cemuScreenshots, matchShots, isCemu } = require('./cemu');

const MAX_FILES = 3000;
const SESSION_BEFORE_MS = 10 * 1000;
const SESSION_AFTER_MS = 60 * 1000;

/** Which emulator this is (for screenshots and game IDs), from its preset or the program's name. */
function emulatorKind(emu) {
  if (!emu) return null;
  if (isCemu(emu)) return 'cemu';
  const preset = String(emu.preset || '');
  if (['dolphin', 'ppsspp', 'rpcs3'].includes(preset)) return preset;
  const exe = path.win32.basename(String(emu.exe || '')).toLowerCase();
  if (/^dolphin[^\\/]*\.exe$/.test(exe)) return 'dolphin';
  if (/^ppsspp[^\\/]*\.exe$/.test(exe)) return 'ppsspp';
  if (/^rpcs3[^\\/]*\.exe$/.test(exe)) return 'rpcs3';
  return null;
}

// ---------------------------------------------------------------- small file helpers

async function isDir(p) {
  try { return (await fsp.stat(p)).isDirectory(); } catch { return false; }
}
async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}
async function listDir(p) {
  try { return await fsp.readdir(p, { withFileTypes: true }); } catch { return []; }
}
const uniq = (list) => {
  const seen = new Set();
  return list.filter((p) => {
    if (!p) return false;
    const k = path.resolve(p).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/** Opens a file for reading pieces at given positions. */
async function openReader(file) {
  const fh = await fsp.open(file, 'r');
  const { size } = await fh.stat();
  return {
    size,
    async read(pos, len) {
      if (pos < 0 || pos >= size) return Buffer.alloc(0);
      const buf = Buffer.alloc(Math.min(len, size - pos));
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      return buf.subarray(0, bytesRead);
    },
    close: () => fh.close().catch(() => {}),
  };
}

// ---------------------------------------------------------------- PARAM.SFO (PSP and PS3)

/** Reads the values of a PARAM.SFO file (TITLE, DISC_ID, TITLE_ID, CATEGORY …). */
function parseSfo(buf) {
  if (!buf || buf.length < 0x14 || buf.readUInt32BE(0) !== 0x00505346) return null;
  const keyStart = buf.readUInt32LE(0x08);
  const dataStart = buf.readUInt32LE(0x0c);
  const count = buf.readUInt32LE(0x10);
  if (count > 512) return null;
  const out = {};
  for (let i = 0; i < count; i++) {
    const e = 0x14 + i * 16;
    if (e + 16 > buf.length) break;
    const keyOff = keyStart + buf.readUInt16LE(e);
    const fmt = buf.readUInt16LE(e + 2);
    const len = buf.readUInt32LE(e + 4);
    const dataOff = dataStart + buf.readUInt32LE(e + 12);
    if (keyOff >= buf.length || dataOff > buf.length) continue;
    const keyEnd = buf.indexOf(0, keyOff);
    const key = buf.toString('latin1', keyOff, keyEnd < 0 ? buf.length : keyEnd);
    if (fmt === 0x0404) {
      if (dataOff + 4 <= buf.length) out[key] = buf.readUInt32LE(dataOff);
    } else {
      const raw = buf.subarray(dataOff, Math.min(buf.length, dataOff + len));
      const zero = raw.indexOf(0);
      out[key] = raw.toString('utf8', 0, zero < 0 ? raw.length : zero).trim();
    }
  }
  return out;
}

// ---------------------------------------------------------------- disc images

const SECTOR = 2048;

/**
 * Finds a file inside an ISO 9660 image (`read(pos, len)` reads the image) and returns its bytes
 * (at most `max`). Path parts are compared without letter case and without the ";1" ending.
 */
async function isoReadFile(read, parts, max = 64 * 1024) {
  const pvd = await read(16 * SECTOR, SECTOR);
  if (pvd.length < 190 || pvd[0] !== 1 || pvd.toString('latin1', 1, 6) !== 'CD001') return null;
  let extent = pvd.readUInt32LE(156 + 2);
  let size = pvd.readUInt32LE(156 + 10);
  let isFolder = true;
  for (const want of parts) {
    if (!isFolder || size > 512 * 1024) return null;
    const dir = await read(extent * SECTOR, size);
    let found = null;
    for (let p = 0; p < dir.length;) {
      const len = dir[p];
      if (!len) { p = (Math.floor(p / SECTOR) + 1) * SECTOR; continue; }
      if (p + 33 > dir.length) break;
      const nameLen = dir[p + 32];
      const name = dir.toString('latin1', p + 33, p + 33 + nameLen).replace(/;\d+$/, '').replace(/\.$/, '');
      if (name.toUpperCase() === want.toUpperCase()) {
        found = { extent: dir.readUInt32LE(p + 2), size: dir.readUInt32LE(p + 10), folder: (dir[p + 25] & 2) !== 0 };
        break;
      }
      p += len;
    }
    if (!found) return null;
    ({ extent, size } = found);
    isFolder = found.folder;
  }
  if (isFolder) return null;
  return read(extent * SECTOR, Math.min(size, max));
}

/** Reading inside a PSP .cso image (blocks compressed one by one with deflate). */
async function csoReadFn(r) {
  const head = await r.read(0, 0x18);
  if (head.length < 0x18 || head.toString('latin1', 0, 4) !== 'CISO') return null;
  const total = Number(head.readBigUInt64LE(8));
  const block = head.readUInt32LE(0x10);
  const version = head[0x14];
  const align = head[0x15];
  if (!(block >= 512 && block <= 1024 * 1024) || !(total > 0)) return null;
  const blocks = Math.ceil(total / block);
  const indexCache = new Map();
  const entry = async (i) => {
    if (!indexCache.has(i)) {
      const b = await r.read(0x18 + i * 4, 8);
      if (b.length < 8) return null;
      indexCache.set(i, [b.readUInt32LE(0), b.readUInt32LE(4)]);
    }
    return indexCache.get(i);
  };
  const readBlock = async (i) => {
    const e = await entry(i);
    if (!e) return null;
    const start = (e[0] & 0x7fffffff) * 2 ** align;
    const end = (e[1] & 0x7fffffff) * 2 ** align;
    const raw = await r.read(start, Math.max(0, end - start));
    const plainV1 = version < 2 && (e[0] & 0x80000000);
    if (plainV1 || (version >= 2 && raw.length >= block)) return raw.subarray(0, block);
    if (version >= 2 && (e[0] & 0x80000000)) return null; // LZ4 (CSO v2): not read
    try { return zlib.inflateRawSync(raw); } catch { return null; }
  };
  return async (pos, len) => {
    const parts = [];
    let p = pos;
    const end = Math.min(pos + len, total);
    while (p < end) {
      const i = Math.floor(p / block);
      if (i >= blocks) break;
      const data = await readBlock(i);
      if (!data) break;
      const from = p - i * block;
      const take = Math.min(end - p, data.length - from);
      if (take <= 0) break;
      parts.push(data.subarray(from, from + take));
      p += take;
    }
    return Buffer.concat(parts);
  };
}

/** PSP game: { id, title } from an .iso, .cso or EBOOT.PBP. */
async function pspInfo(file) {
  let r;
  try {
    r = await openReader(file);
    const magic = await r.read(0, 4);
    // PSN games (EBOOT.PBP): PARAM.SFO is the first part of the file.
    if (magic.length === 4 && magic.toString('latin1') === '\0PBP') {
      const head = await r.read(0, 0x28);
      const from = head.readUInt32LE(0x08);
      const to = head.readUInt32LE(0x0c);
      const sfo = parseSfo(await r.read(from, Math.min(64 * 1024, Math.max(0, to - from))));
      return sfo ? { id: cleanId(sfo.DISC_ID), title: cleanTitle(sfo.TITLE) } : null;
    }
    const read = magic.toString('latin1') === 'CISO' ? await csoReadFn(r) : (pos, len) => r.read(pos, len);
    if (!read) return null;
    const sfo = parseSfo(await isoReadFile(read, ['PSP_GAME', 'PARAM.SFO']));
    if (sfo && sfo.DISC_ID) return { id: cleanId(sfo.DISC_ID), title: cleanTitle(sfo.TITLE) };
    // Some discs only have the ID in UMD_DATA.BIN ("ULUS-10041|…").
    const umd = await isoReadFile(read, ['UMD_DATA.BIN'], 64);
    if (umd) return { id: cleanId(umd.toString('latin1').split('|')[0]), title: '' };
    return null;
  } catch {
    return null;
  } finally {
    if (r) await r.close();
  }
}

/** Titles in PARAM.SFO can contain line breaks ("Uncharted\nDrake's Fortune"). */
const cleanTitle = (t) => String(t || '').replace(/\s+/g, ' ').trim();

/** "ULUS-10041" → "ULUS10041"; nonsense → "". */
function cleanId(v) {
  const id = String(v || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return /^[A-Z0-9]{4,12}$/.test(id) ? id : '';
}

const GC_MAGIC = 0xc2339f3d;
const WII_MAGIC = 0x5d1c9ea3;

/** The six-letter game ID of a GameCube / Wii disc header at `off`, or "". */
function discHeaderId(buf, off) {
  if (buf.length < off + 0x20) return '';
  const id = buf.toString('latin1', off, off + 6);
  if (!/^[A-Z0-9]{6}$/.test(id)) return '';
  if (buf.readUInt32BE(off + 0x1c) !== GC_MAGIC && buf.readUInt32BE(off + 0x18) !== WII_MAGIC) return '';
  return id;
}

/** GameCube / Wii game ID from .iso/.gcm, .wbfs, .rvz/.wia and GameCube .ciso images. */
async function dolphinGameId(file) {
  let r;
  try {
    r = await openReader(file);
    const head = await r.read(0, 0x100);
    if (head.length < 0x20) return '';
    const magic = head.toString('latin1', 0, 4);
    if (magic === 'WIA\x01' || magic === 'RVZ\x01') return discHeaderId(head, 0x58);
    if (magic === 'WBFS') return discHeaderId(await r.read(0x200, 0x40), 0);
    if (magic === 'CISO') return discHeaderId(await r.read(0x8000, 0x40), 0);
    return discHeaderId(head, 0);
  } catch {
    return '';
  } finally {
    if (r) await r.close();
  }
}

/** PS3 game from its EBOOT.BIN: PARAM.SFO sits one folder up from USRDIR. */
async function ps3Info(ebootPath) {
  const sfoPath = path.join(path.dirname(path.dirname(ebootPath)), 'PARAM.SFO');
  try {
    const sfo = parseSfo(await fsp.readFile(sfoPath));
    if (!sfo) return null;
    return { id: cleanId(sfo.TITLE_ID), title: cleanTitle(sfo.TITLE), category: String(sfo.CATEGORY || '').toUpperCase() };
  } catch {
    return null;
  }
}

// Game IDs are read once per file version (path + size + modification time).
const idCache = new Map();

/** Game ID (and title where the file has one) for a game file of this kind of emulator. */
async function gameInfo(kind, file) {
  let st;
  try { st = await fsp.stat(file); } catch { return null; }
  const key = `${kind}|${file}|${st.size}|${Math.round(st.mtimeMs)}`;
  if (idCache.has(key)) return idCache.get(key);
  let info = null;
  if (kind === 'dolphin') {
    const id = await dolphinGameId(file);
    info = id ? { id, title: '' } : null;
  } else if (kind === 'ppsspp') {
    info = await pspInfo(file);
  } else if (kind === 'rpcs3') {
    info = await ps3Info(file);
  }
  if (idCache.size > 20000) idCache.clear();
  idCache.set(key, info);
  return info;
}

// ---------------------------------------------------------------- where the screenshots are

/** Dolphin's User folders: portable (portable.txt), Documents (older versions), AppData. */
function dolphinUserDirs(exe, env = process.env) {
  const exeDir = path.dirname(exe || '');
  return uniq([
    exe ? path.join(exeDir, 'User') : '',
    env.DOCUMENTS ? path.join(env.DOCUMENTS, 'Dolphin Emulator') : '',
    env.APPDATA ? path.join(env.APPDATA, 'Dolphin Emulator') : '',
  ]);
}

/** PPSSPP's memory stick folders: installed.txt's path or Documents\PPSSPP, else "memstick". */
async function ppssppMemstickDirs(exe, env = process.env) {
  const exeDir = path.dirname(exe || '');
  const out = [];
  if (exe) {
    try {
      const text = (await fsp.readFile(path.join(exeDir, 'installed.txt'), 'utf8')).replace(/^﻿/, '');
      const first = text.split(/\r?\n/)[0].trim();
      if (first) out.push(first);
    } catch { /* not installed: portable */ }
    out.push(path.join(exeDir, 'memstick'));
  }
  if (env.DOCUMENTS) out.push(path.join(env.DOCUMENTS, 'PPSSPP'));
  return uniq(out);
}

/** RPCS3's folders: "portable" next to the program, RPCS3_CONFIG_DIR, or the program's folder. */
function rpcs3ConfigDirs(exe, env = process.env) {
  const exeDir = path.dirname(exe || '');
  return uniq([exe ? path.join(exeDir, 'portable') : '', env.RPCS3_CONFIG_DIR || '', exe ? exeDir : '']);
}

const DOLPHIN_TIME = /_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:_\d+)?\.png$/i;
const RPCS3_FILE = /^(?:([A-Za-z0-9]+)_)?screenshot_(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})\.png$/i;
const PPSSPP_FILE = /^([A-Za-z0-9]{4,12})_\d{5}\.(?:png|jpe?g)$/i;

const localTime = (m, i) => new Date(+m[i], +m[i + 1] - 1, +m[i + 2], +m[i + 3], +m[i + 4], +m[i + 5]).getTime();

async function mtime(file) {
  try { return (await fsp.stat(file)).mtimeMs; } catch { return 0; }
}

/**
 * All screenshots of an emulator installation: [{ path, key, time }], key = game ID ("" if the
 * file name doesn't say). Newest first, at most a few thousand.
 */
async function emulatorShots(kind, exe, env = process.env) {
  const out = [];
  const add = (item) => { if (out.length < MAX_FILES) out.push(item); };
  if (kind === 'cemu') {
    for (const s of await cemuScreenshots(exe, env)) add({ path: s.path, key: '', time: s.time });
  } else if (kind === 'dolphin') {
    for (const user of dolphinUserDirs(exe, env)) {
      const root = path.join(user, 'ScreenShots');
      for (const e of await listDir(root)) {
        if (e.isDirectory()) {
          for (const f of await listDir(path.join(root, e.name))) {
            if (!f.isFile() || !/\.png$/i.test(f.name)) continue;
            const file = path.join(root, e.name, f.name);
            const m = DOLPHIN_TIME.exec(f.name);
            add({ path: file, key: e.name.toUpperCase(), time: m ? localTime(m, 1) : await mtime(file) });
          }
        } else if (e.isFile() && /\.png$/i.test(e.name)) {
          // Very old Dolphin: "GALE01-1.png" right in ScreenShots.
          const file = path.join(root, e.name);
          const m = DOLPHIN_TIME.exec(e.name);
          add({ path: file, key: e.name.split(/[-_]/)[0].toUpperCase(), time: m ? localTime(m, 1) : await mtime(file) });
        }
      }
    }
  } else if (kind === 'ppsspp') {
    for (const stick of await ppssppMemstickDirs(exe, env)) {
      const dir = path.join(stick, 'PSP', 'SCREENSHOT');
      for (const f of await listDir(dir)) {
        const m = f.isFile() && PPSSPP_FILE.exec(f.name);
        if (!m) continue;
        const file = path.join(dir, f.name);
        add({ path: file, key: m[1].toUpperCase(), time: await mtime(file) });
      }
    }
  } else if (kind === 'rpcs3') {
    for (const conf of rpcs3ConfigDirs(exe, env)) {
      const root = path.join(conf, 'screenshots');
      if (!(await isDir(root))) continue;
      const files = [];
      for (const e of await listDir(root)) {
        if (e.isFile()) {
          files.push([path.join(root, e.name), e.name, '']);
        } else if (e.isDirectory()) {
          for (const f of await listDir(path.join(root, e.name))) {
            if (f.isFile()) files.push([path.join(root, e.name, f.name), f.name, e.name]);
          }
        }
      }
      for (const [file, name, folder] of files) {
        const m = RPCS3_FILE.exec(name);
        if (!m) continue;
        add({ path: file, key: (m[1] || folder || '').toUpperCase(), time: localTime(m, 2) });
      }
    }
  }
  out.sort((a, b) => b.time - a.time);
  return out;
}

function inSessions(time, sessions) {
  return (sessions || []).some(([a, b]) => time >= a - SESSION_BEFORE_MS && time <= b + SESSION_AFTER_MS);
}

/**
 * The screenshots of one game.
 *  game      { id, discId }   (discId: ID read from the game file, if any)
 *  siblings  the library games of the same emulator installation (the game included)
 *  sessions  play times of this game: [[start, end], …]
 */
function shotsForGame(kind, game, shots, { siblings = [], sessions = [] } = {}) {
  if (kind === 'cemu') return matchShots(shots, sessions, { onlyGame: siblings.length === 1 });
  const id = String(game.discId || '').toUpperCase();
  if (id) return shots.filter((s) => s.key === id);
  // ID unknown: the IDs whose screenshots were taken while this game was played (unless another
  // game of this emulator has that ID).
  const others = new Set(siblings.filter((g) => g.id !== game.id && g.discId).map((g) => String(g.discId).toUpperCase()));
  const keys = new Set();
  for (const s of shots) if (s.key && !others.has(s.key) && inSessions(s.time, sessions)) keys.add(s.key);
  // The only game of this emulator, and all screenshots are of one game: they're this game's.
  if (!keys.size && siblings.length === 1) {
    const all = new Set(shots.map((s) => s.key));
    if (all.size === 1 && !all.has('')) keys.add([...all][0]);
  }
  return shots.filter((s) => (s.key ? keys.has(s.key) : inSessions(s.time, sessions)));
}

module.exports = {
  emulatorKind, emulatorShots, shotsForGame, gameInfo,
  parseSfo, isoReadFile, csoReadFn, pspInfo, dolphinGameId, ps3Info, cleanId,
  dolphinUserDirs, ppssppMemstickDirs, rpcs3ConfigDirs,
};
