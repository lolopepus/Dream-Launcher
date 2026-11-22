'use strict';
/**
 * Emulators: scans each configured ROM folder (up to 4 levels deep) for the configured file types.
 * Every file becomes a game that is started with the emulator's argument template.
 */
const path = require('path');
const crypto = require('crypto');
const fsp = require('fs').promises;
const { splitArgs, fillArgs } = require('../util/args');
const { isDir, isFile } = require('../util/fsx');
const { readCemuPlaytime, isCemu } = require('../cemu');

const MAX_DEPTH = 4;
const MAX_FILES = 5000;

function cleanRomName(fileName) {
  const base = fileName.replace(/\.[^.]+$/, '');
  let name = base.replace(/\s*[([][^)\]]*[)\]]/g, ' ');
  if (!/\s/.test(name.trim()) && /[_.]/.test(name)) name = name.replace(/[_.]+/g, ' ');
  name = name.replace(/\s+/g, ' ').trim();
  return name || base;
}

function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
}

/**
 * Wii U games in folder format (code/xxx.rpx + meta/meta.xml): the .rpx file has an internal
 * name (Splatoon is "Gambit.rpx"), so the real title is read from meta.xml instead.
 * Returns { name, skip } - skip is true for update and DLC folders.
 */
async function wiiuInfo(rpxPath) {
  const codeDir = path.dirname(rpxPath);
  const gameDir = path.dirname(codeDir);
  let xml = '';
  try { xml = await fsp.readFile(path.join(gameDir, 'meta', 'meta.xml'), 'utf8'); } catch { /* no meta */ }
  const tag = (t) => {
    const m = xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i'));
    return m ? decodeXml(m[1]).replace(/\s*[\r\n]+\s*/g, ' ').trim() : '';
  };
  const titleId = tag('title_id').toLowerCase();
  const skip = /^0005000[ec]/.test(titleId);
  let name = tag('shortname_en') || tag('longname_en');
  if (!name && path.basename(codeDir).toLowerCase() === 'code') name = cleanRomName(path.basename(gameDir) + '.x');
  return { name: name || cleanRomName(path.basename(rpxPath)), skip, titleId: /^[0-9a-f]{16}$/.test(titleId) ? titleId : '' };
}

function shortHash(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

async function walk(dir, exts, depth, out) {
  if (out.length >= MAX_FILES) return;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  const names = new Set(entries.map((e) => e.name.toLowerCase()));
  const hasCue = exts.has('cue') && entries.some((e) => e.isFile() && /\.cue$/i.test(e.name));
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH && !e.name.startsWith('.')) await walk(full, exts, depth + 1, out);
      continue;
    }
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).slice(1).toLowerCase();
    if (!exts.has(ext)) continue;
    // A .bin next to a .cue is a track of that disc, not a separate game.
    if (ext === 'bin' && hasCue) continue;
    // Skip multi-disc members when a .m3u playlist exists in the same folder.
    if (ext !== 'm3u' && exts.has('m3u') && /\((disc|disk|cd)\s*\d+\)/i.test(e.name) && [...names].some((n) => n.endsWith('.m3u'))) continue;
    out.push(full);
  }
}

async function scanEmulator(emu, env = process.env) {
  const games = [];
  if (!emu || !emu.exe || !emu.romDir) return { emulator: emu, games, error: 'incomplete' };
  if (!(await isFile(emu.exe))) return { emulator: emu, games, error: 'exeMissing' };
  if (!(await isDir(emu.romDir))) return { emulator: emu, games, error: 'folderMissing' };
  const exts = new Set((emu.extensions || []).map((e) => String(e).toLowerCase()));
  if (!exts.size) return { emulator: emu, games, error: 'noExtensions' };
  const files = [];
  await walk(emu.romDir, exts, 0, files);
  const template = splitArgs(emu.args || '"{rom}"');
  const hasRom = template.some((a) => a.includes('{rom}'));
  for (const file of files) {
    let name = cleanRomName(path.basename(file));
    let titleId = '';
    if (/\.rpx$/i.test(file)) {
      const info = await wiiuInfo(file);
      if (info.skip) continue;
      name = info.name;
      titleId = info.titleId;
    }
    const rel = path.relative(emu.romDir, file);
    let args = fillArgs(template, { rom: file });
    if (!hasRom) args = [...args, file];
    games.push({
      id: `emu:${emu.id}:${shortHash(rel.toLowerCase())}`,
      source: 'emulators',
      sourceId: rel,
      name,
      installed: true,
      status: 'installed',
      progress: null,
      installDir: path.dirname(file),
      romPath: file,
      sizeBytes: 0,
      playtimeMinutes: 0,
      lastPlayed: 0,
      platform: emu.platform || emu.name || '',
      emulatorId: emu.id,
      emulatorName: emu.name || '',
      titleId,
      launch: { type: 'exe', path: emu.exe, args, cwd: path.dirname(emu.exe), trackChild: true },
      client: null,
      tracksOwnPlaytime: false,
    });
  }
  if (isCemu(emu)) {
    for (const g of games) g.cemu = true;
    await applyCemuPlaytime(emu, games, env);
  }
  return { emulator: emu, games, error: null };
}

/** Uses Cemu's own play log for Wii U games (it also counts play started outside the launcher). */
async function applyCemuPlaytime(emu, games, env) {
  let stats = null;
  try { stats = await readCemuPlaytime(emu.exe, env); } catch { stats = null; }
  if (!stats) return;
  for (const g of games) {
    if (!g.titleId) continue;
    const st = stats.get(g.titleId);
    g.playtimeMinutes = st ? st.minutes : 0;
    g.lastPlayed = st ? st.lastPlayed : 0;
    g.firstPlayed = st ? st.firstPlayed : 0;
    g.lastPlayedDayOnly = true;
    g.playtimeSource = 'cemu';
    g.tracksOwnPlaytime = true;
  }
}

async function scanEmulators(ctx) {
  const list = (ctx.settings && ctx.settings.emulators) || [];
  const results = await Promise.all(list.map((e) => scanEmulator(e, ctx.env || process.env)));
  const games = [];
  const status = {};
  for (const r of results) {
    games.push(...r.games);
    if (r.emulator && r.emulator.id) status[r.emulator.id] = { count: r.games.length, error: r.error };
  }
  return { available: list.length > 0, games, status };
}

module.exports = { scanEmulators, scanEmulator, cleanRomName };
