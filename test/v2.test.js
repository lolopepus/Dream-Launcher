'use strict';
/** Version 2: handheld detection, screenshots, settings migration, process list parsing. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers');
const { classifyDevice } = require('../src/main/device');
const { Sizes, folderSize } = require('../src/main/sizes');
const { SteamWeb } = require('../src/main/steamweb');
const { migrateSettings, sanitizeSettings, DEFAULT_SETTINGS } = require('../src/main/defaults');
const { parseProcessList, parseTasklist } = require('../src/main/util/powershell');
const { Store } = require('../src/main/store');

test('handheld detection: known models, chassis, small battery screens', () => {
  const ally = classifyDevice({ manufacturer: 'ASUSTeK COMPUTER INC.', model: 'ROG Xbox Ally RC73YA_RC73YA', screens: [{ w: 15, h: 9 }] }, { hasBattery: true });
  assert.equal(ally.handheld, true);
  assert.equal(ally.reason, 'model');
  assert.equal(classifyDevice({ manufacturer: 'ASUSTeK COMPUTER INC.', model: 'RC71L' }).handheld, true);
  assert.equal(classifyDevice({ manufacturer: 'LENOVO', model: '83E1', family: 'Legion Go 8APU1' }).handheld, true);
  assert.equal(classifyDevice({ manufacturer: 'Valve', model: 'Jupiter' }).handheld, true);
  assert.equal(classifyDevice({ manufacturer: 'Micro-Star International Co., Ltd.', model: 'Claw A1M' }).handheld, true);
  assert.equal(classifyDevice({ manufacturer: 'AYANEO', model: 'AYANEO 2S' }).handheld, true);
  assert.equal(classifyDevice({ manufacturer: 'Unknown', model: 'X', chassis: [11] }).reason, 'chassis');
  const small = classifyDevice({ manufacturer: 'Generic', model: 'Box', screens: [{ w: 17, h: 11 }] }, { hasBattery: true });
  assert.equal(small.handheld, true);
  assert.equal(small.reason, 'screen');
  assert.equal(small.screenInches, 8);
  // Desktop PCs and laptops are not handhelds.
  assert.equal(classifyDevice({ manufacturer: 'Micro-Star International Co., Ltd.', model: 'MS-7D25', screens: [{ w: 60, h: 34 }] }, { hasBattery: false }).handheld, false);
  assert.equal(classifyDevice({ manufacturer: 'Dell Inc.', model: 'XPS 13 9340', chassis: [10], screens: [{ w: 29, h: 18 }] }, { hasBattery: true }).handheld, false);
  // A small screen on a PC without battery (e.g. a small monitor) is not a handheld.
  assert.equal(classifyDevice({ model: 'Desk', screens: [{ w: 17, h: 11 }] }, { hasBattery: false }).handheld, false);
  assert.equal(classifyDevice(null).handheld, false);
});

test('sizes: folders and emulator files are measured once and cached', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'Game', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Game', 'game.exe'), Buffer.alloc(1000));
  fs.writeFileSync(path.join(dir, 'Game', 'bin', 'data.pak'), Buffer.alloc(5000));
  fs.writeFileSync(path.join(dir, 'rom.iso'), Buffer.alloc(3000));
  assert.equal(await folderSize(path.join(dir, 'Game')), 6000);
  assert.equal(await folderSize(path.join(dir, 'missing')), 0);
  const store = new Store(tmpDir());
  await store.load();
  const sizes = new Sizes({ store });
  const games = [
    { id: 'gog:1', source: 'gog', installed: true, installDir: path.join(dir, 'Game'), sizeBytes: 0 },
    { id: 'emu:1', source: 'emulators', installed: true, installDir: dir, romPath: path.join(dir, 'rom.iso'), sizeBytes: 0 },
    { id: 'steam:1', source: 'steam', installed: true, installDir: path.join(dir, 'Game'), sizeBytes: 42 },
    { id: 'manual:1', source: 'manual', installed: true, installDir: dir, sizeBytes: 0 },
    { id: 'steam:2', source: 'steam', installed: false, sizeBytes: 0 },
  ];
  let updates = 0;
  await new Promise((resolve) => { sizes.refresh(games, () => { updates++; resolve(); }); });
  while (sizes.running) await new Promise((r) => setTimeout(r, 5));
  assert.equal(games[0].sizeBytes, 6000);
  assert.equal(games[1].sizeBytes, 3000);
  assert.equal(games[2].sizeBytes, 42, 'store-reported size is kept');
  assert.equal(games[3].sizeBytes, 0, 'games added by hand are not measured');
  assert.ok(updates >= 1);
  // Next start: known sizes are filled in right away, without measuring again.
  const fresh = [{ id: 'gog:1', source: 'gog', installed: true, installDir: path.join(dir, 'Game'), sizeBytes: 0 }];
  const sizes2 = new Sizes({ store, measureFolder: async () => { throw new Error('should not measure'); } });
  sizes2.apply(fresh);
  assert.equal(fresh[0].sizeBytes, 6000);
  sizes2.refresh(fresh, () => {});
  assert.equal(sizes2.queue.length, 0);
});

test('friends summary: counts for many games at once, instantly from the cache', async () => {
  const store = new Store(tmpDir());
  await store.load();
  const sw = new SteamWeb({ store, fetch: async () => { throw new Error('no network needed'); } });
  assert.deepEqual(sw.friendsSummary(['570']), {});
  store.steamWeb.friends = {
    steamId: '1', builtAt: Date.now(), format: 3,
    byApp: { 570: [['a', 600, 30, 1700000000], ['b', 1200, 0, 1690000000]], 620: [['a', 5, 0, 0]] },
    friends: { a: { name: 'Sam', avatar: 'https://x/a.jpg' }, b: { name: 'Jo', avatar: '' } },
  };
  const sum = sw.friendsSummary(['570', '620', '999']);
  assert.deepEqual(Object.keys(sum).sort(), ['570', '620']);
  assert.equal(sum['570'].count, 2);
  assert.equal(sum['570'].people[0].name, 'Jo', 'most played first');
});

test('settings v1 -> v2: date and uninstalled Steam games on, built-in music renamed', async () => {
  const v1 = { version: 1, showDate: false, showUninstalledSteam: false, music: 'ambient', showGreeting: true, profileName: 'Lolo', profileAvatar: 'a.png', musicVolume: 50 };
  const { settings, changed } = migrateSettings(v1);
  assert.equal(changed, true);
  const clean = sanitizeSettings(settings);
  assert.equal(clean.version, 2);
  assert.equal(clean.showDate, true);
  assert.equal(clean.showUninstalledSteam, true);
  assert.equal(clean.music, 'builtin');
  assert.equal(clean.musicVolume, 50);
  assert.equal(clean.musicSpeed, 'slowed');
  assert.equal(clean.uiSize, 'auto');
  assert.equal(clean.showLogos, true);
  assert.equal('showGreeting' in clean, false);
  assert.equal('profileAvatar' in clean, false);
  // v2 settings are left alone (the user may turn the date off again).
  const again = migrateSettings({ ...clean, showDate: false });
  assert.equal(again.changed, false);
  assert.equal(sanitizeSettings(again.settings).showDate, false);
  // Fresh installs use the v2 defaults.
  assert.equal(DEFAULT_SETTINGS.showDate, true);
  assert.equal(sanitizeSettings({ music: 'ambient' }).music, 'builtin');
  assert.equal(sanitizeSettings({ uiSize: 'huge' }).uiSize, 'auto');
});

test('store: migrates v1 settings on load and saves them', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ version: 1, showDate: false, showUninstalledSteam: false, language: 'pl' }));
  const store = new Store(dir);
  await store.load();
  assert.equal(store.settings.showDate, true);
  assert.equal(store.settings.language, 'pl');
  await store.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(saved.version, 2);
  assert.equal(saved.showUninstalledSteam, true);
});

test('process lists: PowerShell lines and tasklist CSV', () => {
  const list = parseProcessList(['Minecraft.Windows.exe|C:\\XboxGames\\Minecraft\\Content\\Minecraft.Windows.exe', 'eldenring.exe|', 'bad line', '|nothing']);
  assert.deepEqual(list, [
    { name: 'minecraft.windows.exe', path: 'C:\\XboxGames\\Minecraft\\Content\\Minecraft.Windows.exe' },
    { name: 'eldenring.exe', path: '' },
  ]);
  assert.deepEqual(parseProcessList('a.exe|C:\\a.exe'), [{ name: 'a.exe', path: 'C:\\a.exe' }]);
  const names = parseTasklist('"System Idle Process","0","Services","0","8 K"\r\n"eldenring.exe","4242","Console","1","2.345.678 K"\r\n\r\n');
  assert.equal(names.has('eldenring.exe'), true);
  assert.equal(names.has('system idle process'), true);
  assert.equal(names.size, 2);
});

test('library: Steam account from the last scan is known right after start-up', async () => {
  const { Library } = require('../src/main/library');
  const store = new Store(tmpDir());
  await store.load();
  store.libraryCache = { savedAt: 1, games: [], sourceStatus: {}, steamMeta: { steamPath: 'C:\\Steam', user: { id64: '76561198000000001', accountId: '39734273', personaName: 'Me' } } };
  const lib = new Library({ store, probe: async () => ({}), env: {}, log: { warn() {}, error() {}, info() {} } });
  assert.equal(lib.steamMeta.user.id64, '76561198000000001');
});

test('friends: a list saved by an older version is rebuilt (to get "last played")', async () => {
  const store = new Store(tmpDir());
  await store.load();
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const body = url.includes('GetFriendList') ? { friendslist: { friends: [{ steamid: '76561198000000002' }] } }
      : url.includes('GetOwnedGames') ? { response: { games: [{ appid: 570, playtime_forever: 90, playtime_2weeks: 0, rtime_last_played: 1700000000 }] } }
        : url.includes('GetPlayerSummaries') ? { response: { players: [{ steamid: '76561198000000002', personaname: 'Jo' }] } } : {};
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const sw = new SteamWeb({ store, fetch });
  store.steamWeb.friends = { steamId: '1', builtAt: Date.now(), format: 2, byApp: { 570: [['76561198000000002', 90, 0]] }, friends: { '76561198000000002': { name: 'Jo', avatar: '' } } };
  assert.equal(sw.friendsFor('570').people[0].name, 'Jo', 'old list is still shown meanwhile');
  assert.equal(sw.refreshFriendsIfStale('k', '1'), true);
  await sw.friendsBuilding;
  assert.equal(store.steamWeb.friends.format, 3);
  assert.equal(sw._friendEntries('570')[0].lastPlayed, 1700000000 * 1000);
  assert.equal(sw.refreshFriendsIfStale('k', '1'), false, 'fresh list is left alone');
});

test('screenshots: Steam folder, newest first, with thumbnails', async () => {
  const { steamScreenshots } = require('../src/main/screenshots');
  const steam = tmpDir();
  const base = path.join(steam, 'userdata', '123', '760', 'remote', '570', 'screenshots');
  fs.mkdirSync(path.join(base, 'thumbnails'), { recursive: true });
  fs.writeFileSync(path.join(base, 'a.jpg'), 'x');
  fs.writeFileSync(path.join(base, 'b.jpg'), 'x');
  fs.writeFileSync(path.join(base, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(base, 'thumbnails', 'b.jpg'), 'x');
  const old = new Date(Date.now() - 86400000);
  fs.utimesSync(path.join(base, 'a.jpg'), old, old);
  const list = await steamScreenshots(steam, '123', '570');
  assert.deepEqual(list.map((x) => path.basename(x.path)), ['b.jpg', 'a.jpg']);
  assert.ok(list[0].thumbPath && list[1].thumbPath === null);
  assert.deepEqual(await steamScreenshots(steam, '123', '999'), []);
  assert.deepEqual(await steamScreenshots('', '123', '570'), []);
});
