'use strict';
/** Version 2.5: emulator screenshots (Dolphin, PPSSPP, RPCS3) and the game IDs they're matched with. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { tmpDir } = require('./helpers');
const {
  emulatorKind, emulatorShots, shotsForGame, gameInfo, parseSfo, pspInfo, dolphinGameId, ps3Info, cleanId,
} = require('../src/main/emushots');
const { scanEmulator } = require('../src/main/sources/emulators');
const { PRESETS } = require('../src/main/emulator-presets');

// ---------------------------------------------------------------- builders

/** A PARAM.SFO with the given values (strings or numbers). */
function makeSfo(values) {
  const keys = Object.keys(values);
  const keyTable = Buffer.concat(keys.map((k) => Buffer.from(`${k}\0`, 'latin1')));
  const keyPad = Buffer.alloc((4 - (keyTable.length % 4)) % 4);
  const header = Buffer.alloc(0x14 + keys.length * 16);
  header.writeUInt32BE(0x00505346, 0);
  header.writeUInt32LE(0x101, 4);
  header.writeUInt32LE(0x14 + keys.length * 16, 8);
  header.writeUInt32LE(0x14 + keys.length * 16 + keyTable.length + keyPad.length, 12);
  header.writeUInt32LE(keys.length, 16);
  const data = [];
  let keyOff = 0;
  let dataOff = 0;
  keys.forEach((k, i) => {
    const v = values[k];
    let bytes;
    let fmt;
    if (typeof v === 'number') { bytes = Buffer.alloc(4); bytes.writeUInt32LE(v); fmt = 0x0404; } else { bytes = Buffer.from(`${v}\0`, 'utf8'); fmt = 0x0204; }
    const max = Math.ceil(bytes.length / 4) * 4;
    const e = 0x14 + i * 16;
    header.writeUInt16LE(keyOff, e);
    header.writeUInt16LE(fmt, e + 2);
    header.writeUInt32LE(bytes.length, e + 4);
    header.writeUInt32LE(max, e + 8);
    header.writeUInt32LE(dataOff, e + 12);
    data.push(Buffer.concat([bytes, Buffer.alloc(max - bytes.length)]));
    keyOff += k.length + 1;
    dataOff += max;
  });
  return Buffer.concat([header, keyTable, keyPad, ...data]);
}

function dirRecord(name, extent, size, folder) {
  const n = Buffer.from(name, 'latin1');
  const len = 33 + n.length + (n.length % 2 === 0 ? 1 : 0);
  const b = Buffer.alloc(len);
  b[0] = len;
  b.writeUInt32LE(extent, 2);
  b.writeUInt32BE(extent, 6);
  b.writeUInt32LE(size, 10);
  b.writeUInt32BE(size, 14);
  b[25] = folder ? 2 : 0;
  b[32] = n.length;
  n.copy(b, 33);
  return b;
}

/** A tiny PSP disc image: PSP_GAME/PARAM.SFO and UMD_DATA.BIN. */
function makePspIso({ sfo, umd = 'ULUS-10041|0000000000000001|0001|G' } = {}) {
  const S = 2048;
  const img = Buffer.alloc(S * 24);
  const pvd = img.subarray(16 * S);
  pvd[0] = 1;
  pvd.write('CD001', 1, 'latin1');
  dirRecord('\0', 18, S, true).copy(pvd, 156);
  const root = Buffer.concat([dirRecord('\0', 18, S, true), dirRecord('\x01', 18, S, true), dirRecord('PSP_GAME', 19, S, true), dirRecord('UMD_DATA.BIN;1', 21, umd.length, false)]);
  root.copy(img, 18 * S);
  const sfoBuf = sfo || makeSfo({ TITLE: 'Lumines', DISC_ID: 'ULUS10041', CATEGORY: 'UG' });
  Buffer.concat([dirRecord('\0', 19, S, true), dirRecord('\x01', 18, S, true), dirRecord('PARAM.SFO;1', 20, sfoBuf.length, false)]).copy(img, 19 * S);
  sfoBuf.copy(img, 20 * S);
  img.write(umd, 21 * S, 'latin1');
  return img;
}

/** The same image as a .cso (every other block stored uncompressed). */
function makeCso(iso) {
  const B = 2048;
  const blocks = Math.ceil(iso.length / B);
  const head = Buffer.alloc(0x18);
  head.write('CISO', 0, 'latin1');
  head.writeUInt32LE(0x18, 4);
  head.writeBigUInt64LE(BigInt(iso.length), 8);
  head.writeUInt32LE(B, 0x10);
  head[0x14] = 1;
  const index = Buffer.alloc((blocks + 1) * 4);
  const parts = [];
  let pos = 0x18 + index.length;
  for (let i = 0; i < blocks; i++) {
    const raw = iso.subarray(i * B, (i + 1) * B);
    const plain = i % 2 === 1;
    const stored = plain ? raw : zlib.deflateRawSync(raw);
    index.writeUInt32LE((pos | (plain ? 0x80000000 : 0)) >>> 0, i * 4);
    parts.push(stored);
    pos += stored.length;
  }
  index.writeUInt32LE(pos, blocks * 4);
  return Buffer.concat([head, index, ...parts]);
}

function gcHeader(id) {
  const b = Buffer.alloc(0x440);
  b.write(id, 0, 'latin1');
  b.writeUInt32BE(0xc2339f3d, 0x1c);
  return b;
}

// ---------------------------------------------------------------- game IDs

test('emushots: PARAM.SFO values', () => {
  const v = parseSfo(makeSfo({ TITLE: 'Uncharted\nDrake\'s Fortune', TITLE_ID: 'BCUS98103', CATEGORY: 'DG', RESOLUTION: 63 }));
  assert.equal(v.TITLE_ID, 'BCUS98103');
  assert.equal(v.CATEGORY, 'DG');
  assert.equal(v.RESOLUTION, 63);
  assert.equal(parseSfo(Buffer.from('nope')), null);
  assert.equal(cleanId('ULUS-10041'), 'ULUS10041');
  assert.equal(cleanId('x'), '');
});

test('emushots: PSP disc IDs from .iso, .cso and EBOOT.PBP', async () => {
  const dir = tmpDir('psp');
  const iso = makePspIso();
  fs.writeFileSync(path.join(dir, 'Lumines.iso'), iso);
  fs.writeFileSync(path.join(dir, 'Lumines.cso'), makeCso(iso));
  assert.deepEqual(await pspInfo(path.join(dir, 'Lumines.iso')), { id: 'ULUS10041', title: 'Lumines' });
  assert.deepEqual(await pspInfo(path.join(dir, 'Lumines.cso')), { id: 'ULUS10041', title: 'Lumines' });
  // Without PARAM.SFO the ID comes from UMD_DATA.BIN.
  const noSfo = makePspIso({ sfo: makeSfo({ TITLE: 'X' }) });
  fs.writeFileSync(path.join(dir, 'b.iso'), noSfo);
  assert.equal((await pspInfo(path.join(dir, 'b.iso'))).id, 'ULUS10041');
  // PSN game: EBOOT.PBP with PARAM.SFO as its first part.
  const sfo = makeSfo({ TITLE: 'Patapon\n2', DISC_ID: 'NPUH10001', CATEGORY: 'EG' });
  const pbp = Buffer.alloc(0x28 + sfo.length + 16);
  pbp.write('\0PBP', 0, 'latin1');
  pbp.writeUInt32LE(0x28, 0x08);
  pbp.writeUInt32LE(0x28 + sfo.length, 0x0c);
  sfo.copy(pbp, 0x28);
  fs.writeFileSync(path.join(dir, 'EBOOT.PBP'), pbp);
  assert.deepEqual(await pspInfo(path.join(dir, 'EBOOT.PBP')), { id: 'NPUH10001', title: 'Patapon 2' });
  fs.writeFileSync(path.join(dir, 'junk.iso'), Buffer.alloc(100));
  assert.equal(await pspInfo(path.join(dir, 'junk.iso')), null);
});

test('emushots: GameCube / Wii IDs from .iso, .wbfs, .rvz and .ciso', async () => {
  const dir = tmpDir('gc');
  fs.writeFileSync(path.join(dir, 'zelda.iso'), gcHeader('GZLE01'));
  const wbfs = Buffer.alloc(0x400);
  wbfs.write('WBFS', 0, 'latin1');
  const wii = Buffer.alloc(0x40);
  wii.write('RMCP01', 0, 'latin1');
  wii.writeUInt32BE(0x5d1c9ea3, 0x18);
  wii.copy(wbfs, 0x200);
  fs.writeFileSync(path.join(dir, 'kart.wbfs'), wbfs);
  const rvz = Buffer.alloc(0x100);
  rvz.write('RVZ\x01', 0, 'latin1');
  gcHeader('GALE01').subarray(0, 0x80).copy(rvz, 0x58);
  fs.writeFileSync(path.join(dir, 'melee.rvz'), rvz);
  const ciso = Buffer.alloc(0x8100);
  ciso.write('CISO', 0, 'latin1');
  gcHeader('GM4E01').subarray(0, 0x40).copy(ciso, 0x8000);
  fs.writeFileSync(path.join(dir, 'mk.ciso'), ciso);
  fs.writeFileSync(path.join(dir, 'random.iso'), Buffer.from('ABCDEF not a disc'.padEnd(0x60, ' ')));
  assert.equal(await dolphinGameId(path.join(dir, 'zelda.iso')), 'GZLE01');
  assert.equal(await dolphinGameId(path.join(dir, 'kart.wbfs')), 'RMCP01');
  assert.equal(await dolphinGameId(path.join(dir, 'melee.rvz')), 'GALE01');
  assert.equal(await dolphinGameId(path.join(dir, 'mk.ciso')), 'GM4E01');
  assert.equal(await dolphinGameId(path.join(dir, 'random.iso')), '');
  assert.equal(await dolphinGameId(path.join(dir, 'missing.iso')), '');
  // Read once per file version.
  assert.deepEqual(await gameInfo('dolphin', path.join(dir, 'zelda.iso')), { id: 'GZLE01', title: '' });
});

test('emushots: which emulator it is', () => {
  assert.equal(emulatorKind({ preset: 'dolphin', exe: 'C:\\x\\a.exe' }), 'dolphin');
  assert.equal(emulatorKind({ preset: 'custom', exe: 'C:\\Emu\\PPSSPPWindows64.exe' }), 'ppsspp');
  assert.equal(emulatorKind({ preset: 'custom', exe: 'D:\\RPCS3\\rpcs3.exe' }), 'rpcs3');
  assert.equal(emulatorKind({ preset: 'custom', exe: 'C:\\Cemu\\Cemu.exe' }), 'cemu');
  assert.equal(emulatorKind({ preset: 'custom', exe: 'C:\\Dolphin-x64\\Dolphin.exe' }), 'dolphin');
  assert.equal(emulatorKind({ preset: 'pcsx2', exe: 'C:\\PCSX2\\pcsx2-qt.exe' }), null);
  assert.ok(PRESETS.some((p) => p.id === 'rpcs3' && p.args.includes('--no-gui')));
});

// ---------------------------------------------------------------- screenshots on disk

test('emushots: Dolphin, PPSSPP and RPCS3 screenshot folders and names', async () => {
  const docs = tmpDir('docs');
  const appdata = tmpDir('appdata');
  // Dolphin (AppData): one folder per game ID, the time in the name; an old-style file too.
  const dShots = path.join(appdata, 'Dolphin Emulator', 'ScreenShots');
  fs.mkdirSync(path.join(dShots, 'GZLE01'), { recursive: true });
  fs.writeFileSync(path.join(dShots, 'GZLE01', 'GZLE01_2026-11-20_18-30-05.png'), 'x');
  fs.writeFileSync(path.join(dShots, 'GZLE01', 'GZLE01_2026-11-20_18-30-05_1.png'), 'x');
  fs.writeFileSync(path.join(dShots, 'GALE01-1.png'), 'x');
  const dolphinExe = path.join(tmpDir('dolphin'), 'Dolphin.exe');
  const d = await emulatorShots('dolphin', dolphinExe, { APPDATA: appdata, DOCUMENTS: docs });
  assert.deepEqual(d.map((s) => s.key).sort(), ['GALE01', 'GZLE01', 'GZLE01']);
  assert.equal(d.find((s) => s.path.endsWith('_1.png')).time, new Date(2026, 10, 20, 18, 30, 5).getTime());

  // PPSSPP, portable: memstick next to the program; installed: installed.txt or Documents\PPSSPP.
  const pRoot = tmpDir('ppsspp');
  const pShots = path.join(pRoot, 'memstick', 'PSP', 'SCREENSHOT');
  fs.mkdirSync(pShots, { recursive: true });
  fs.writeFileSync(path.join(pShots, 'ULUS10041_00000.jpg'), 'x');
  fs.writeFileSync(path.join(pShots, 'ULUS10041_00001.png'), 'x');
  fs.writeFileSync(path.join(pShots, 'notes.txt'), 'x');
  const docShots = path.join(docs, 'PPSSPP', 'PSP', 'SCREENSHOT');
  fs.mkdirSync(docShots, { recursive: true });
  fs.writeFileSync(path.join(docShots, 'NPUH10001_00000.png'), 'x');
  const p = await emulatorShots('ppsspp', path.join(pRoot, 'PPSSPPWindows64.exe'), { DOCUMENTS: docs });
  assert.deepEqual(p.map((s) => s.key).sort(), ['NPUH10001', 'ULUS10041', 'ULUS10041']);
  const custom = tmpDir('stick');
  fs.mkdirSync(path.join(custom, 'PSP', 'SCREENSHOT'), { recursive: true });
  fs.writeFileSync(path.join(custom, 'PSP', 'SCREENSHOT', 'ULES00151_00000.png'), 'x');
  fs.writeFileSync(path.join(pRoot, 'installed.txt'), `\uFEFF${custom}\r\n`);
  const p2 = await emulatorShots('ppsspp', path.join(pRoot, 'PPSSPPWindows64.exe'), {});
  assert.ok(p2.some((s) => s.key === 'ULES00151'));

  // RPCS3: screenshots\<TITLE_ID>\<TITLE_ID>_screenshot_YYYY_MM_DD_HH_MM_SS.png
  const rRoot = tmpDir('rpcs3');
  fs.mkdirSync(path.join(rRoot, 'screenshots', 'BLUS30443'), { recursive: true });
  fs.writeFileSync(path.join(rRoot, 'screenshots', 'BLUS30443', 'BLUS30443_screenshot_2026_11_21_09_00_00.png'), 'x');
  fs.writeFileSync(path.join(rRoot, 'screenshots', 'screenshot_2026_11_21_10_00_00.png'), 'x');
  const r = await emulatorShots('rpcs3', path.join(rRoot, 'rpcs3.exe'), {});
  assert.deepEqual(r.map((s) => [s.key, s.time]), [
    ['', new Date(2026, 10, 21, 10, 0, 0).getTime()],
    ['BLUS30443', new Date(2026, 10, 21, 9, 0, 0).getTime()],
  ]);
  assert.deepEqual(await emulatorShots('rpcs3', path.join(tmpDir('none'), 'rpcs3.exe'), {}), []);
});

test('emushots: screenshots go to the game with that ID, or the one played at that time', () => {
  const at = (h) => new Date(2026, 10, 22, h, 0).getTime();
  const shots = [
    { path: 'a', key: 'GZLE01', time: at(9) },
    { path: 'b', key: 'GALE01', time: at(12) },
    { path: 'c', key: 'GALE01', time: at(1) }, // before any session: still Melee's (same ID)
    { path: 'd', key: 'GM4E01', time: at(15) },
  ];
  const zelda = { id: 'z', discId: 'GZLE01' };
  const melee = { id: 'm', discId: '' }; // ID unreadable (e.g. .gcz)
  const kart = { id: 'k', discId: 'GM4E01' };
  const siblings = [zelda, melee, kart];
  assert.deepEqual(shotsForGame('dolphin', zelda, shots, { siblings }).map((s) => s.path), ['a']);
  // Melee: learned from a session at 12:00, then all its screenshots belong to it.
  assert.deepEqual(shotsForGame('dolphin', melee, shots, { siblings, sessions: [[at(11.5), at(12.5)]] }).map((s) => s.path), ['b', 'c']);
  // A session that covers another game's ID doesn't steal its screenshots.
  assert.deepEqual(shotsForGame('dolphin', melee, shots, { siblings, sessions: [[at(14.5), at(15.5)]] }), []);
  // Nothing learned yet: nothing (no guessing between several games).
  assert.deepEqual(shotsForGame('dolphin', melee, shots, { siblings }), []);
  // The only game of this emulator with one ID in the folder: it's this game's.
  assert.deepEqual(shotsForGame('dolphin', melee, shots.slice(1, 3), { siblings: [melee] }).map((s) => s.path), ['b', 'c']);
});

// ---------------------------------------------------------------- library

test('emulators: RPCS3 picks up EBOOT.BIN games with their title, not updates or data files', async () => {
  const root = tmpDir('ps3');
  const game = (folder, sfo) => {
    const usr = path.join(root, folder, 'USRDIR');
    fs.mkdirSync(path.join(usr, 'data'), { recursive: true });
    fs.writeFileSync(path.join(usr, 'EBOOT.BIN'), 'x');
    fs.writeFileSync(path.join(usr, 'data', 'level1.bin'), 'x');
    fs.writeFileSync(path.join(root, folder, 'PARAM.SFO'), makeSfo(sfo));
  };
  game('BLUS30443', { TITLE: 'Demon\'s Souls', TITLE_ID: 'BLUS30443', CATEGORY: 'HG' });
  game('BCUS98103', { TITLE: 'Uncharted: Update', TITLE_ID: 'BCUS98103', CATEGORY: 'GD' });
  game(path.join('Disc Game', 'PS3_GAME'), { TITLE: 'Journey', TITLE_ID: 'NPUA80068', CATEGORY: 'DG' });
  const exe = path.join(tmpDir('rpcs3exe'), 'rpcs3.exe');
  fs.writeFileSync(exe, '');
  const res = await scanEmulator({ id: 'ps3', preset: 'rpcs3', exe, romDir: root, extensions: ['bin'], args: '--no-gui --fullscreen "{rom}"', platform: 'PlayStation 3', name: 'RPCS3' });
  assert.equal(res.error, null);
  assert.deepEqual(res.games.map((g) => [g.name, g.discId, g.emuKind]).sort(), [['Demon\'s Souls', 'BLUS30443', 'rpcs3'], ['Journey', 'NPUA80068', 'rpcs3']]);
  assert.ok(res.games[0].launch.args.includes('--no-gui'));
});

test('emulators: PSP and GameCube games get their ID for screenshots', async () => {
  const root = tmpDir('roms');
  fs.writeFileSync(path.join(root, 'Lumines (USA).iso'), makePspIso());
  const exe = path.join(tmpDir('pp'), 'PPSSPPWindows64.exe');
  fs.writeFileSync(exe, '');
  const res = await scanEmulator({ id: 'psp', preset: 'ppsspp', exe, romDir: root, extensions: ['iso'], args: '"{rom}"' });
  assert.deepEqual(res.games.map((g) => [g.name, g.discId, g.emuKind]), [['Lumines', 'ULUS10041', 'ppsspp']]);
  const gc = tmpDir('gcroms');
  fs.writeFileSync(path.join(gc, 'Zelda.iso'), gcHeader('GZLE01'));
  const dexe = path.join(tmpDir('dl'), 'Dolphin.exe');
  fs.writeFileSync(dexe, '');
  const res2 = await scanEmulator({ id: 'gc', preset: 'dolphin', exe: dexe, romDir: gc, extensions: ['iso'], args: '-b -e "{rom}"' });
  assert.equal(res2.games[0].discId, 'GZLE01');
  assert.equal(res2.games[0].emuKind, 'dolphin');
});

test('emushots: PS3 game info from PARAM.SFO next to USRDIR', async () => {
  const root = tmpDir('ps3b');
  fs.mkdirSync(path.join(root, 'X', 'USRDIR'), { recursive: true });
  fs.writeFileSync(path.join(root, 'X', 'PARAM.SFO'), makeSfo({ TITLE: 'Flower', TITLE_ID: 'NPUA80083', CATEGORY: 'HG' }));
  assert.deepEqual(await ps3Info(path.join(root, 'X', 'USRDIR', 'EBOOT.BIN')), { id: 'NPUA80083', title: 'Flower', category: 'HG' });
  assert.equal(await ps3Info(path.join(root, 'none', 'USRDIR', 'EBOOT.BIN')), null);
});

test('discord: only "Dream Launcher", nothing while a game runs or when off', () => {
  const { buildActivity } = require('../src/main/discord');
  const a = buildActivity({ enabled: true, lang: 'de', playing: false, since: 1000.7, repo: 'me/repo' });
  assert.deepEqual(a.assets, { large_image: 'logo', large_text: 'Dream Launcher' });
  assert.equal(a.timestamps.start, 1000);
  assert.equal(a.details, undefined);
  assert.equal(a.state, undefined);
  assert.equal(a.buttons[0].url, 'https://github.com/me/repo');
  assert.equal(buildActivity({ enabled: true, playing: true }), null);
  assert.equal(buildActivity({ enabled: false }), null);
});
