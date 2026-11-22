'use strict';
/** Version 2.2: offline mode, Cemu playtime, Xbox network data (OpenXBL), playtime sources. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers');
const { Connectivity, isNetworkError } = require('../src/main/connectivity');
const { parsePlayStats, readCemuPlaytime, dayToMs } = require('../src/main/cemu');
const { scanEmulator } = require('../src/main/sources/emulators');
const {
  XboxLive, unwrap, parseAccount, parseTitles, parseMinutes, parseAchievements, parseFriends, parsePresence, titleIdFromHex,
} = require('../src/main/xboxlive');
const { sanitizeSettings } = require('../src/main/defaults');
const { Store } = require('../src/main/store');
const { Library } = require('../src/main/library');

const manualTimers = () => ({ setTimeout: () => ({ unref() {} }), clearTimeout: () => {} });
const res = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

// ---------------------------------------------------------------- connectivity

test('connectivity: online with internet, offline without, forced offline, fetch refused offline', async () => {
  let mode = 'auto';
  let link = true;
  let internet = true;
  const seen = [];
  const c = new Connectivity({
    fetch: async (url) => {
      if (!internet) throw new Error('net::ERR_INTERNET_DISCONNECTED');
      return /msftconnecttest/.test(url) ? res(200, 'Microsoft Connect Test') : res(200, '{"servertime":1}');
    },
    getMode: () => mode,
    linkUp: () => link,
    timers: manualTimers(),
    log: { info() {} },
  });
  c.on('change', (s) => seen.push(`${s.online}:${s.reason}`));
  assert.equal((await c.check()).online, true);

  internet = false;
  let st = await c.check();
  assert.equal(st.online, false);
  assert.equal(st.reason, 'noInternet');
  await assert.rejects(() => c.onlineFetch()('https://api.steampowered.com/x'), (e) => e.offline === true);

  link = false;
  assert.equal((await c.check()).reason, 'noNetwork');

  link = true; internet = true; mode = 'offline';
  st = await c.check();
  assert.equal(st.online, false);
  assert.equal(st.reason, 'forced', 'offline mode wins even with internet');

  mode = 'auto';
  assert.equal((await c.check()).online, true);
  assert.deepEqual(seen, ['false:noInternet', 'false:noNetwork', 'false:forced', 'true:null']);
  // A captive portal answers, but not with the expected text: that is not "online".
  const portal = new Connectivity({ fetch: async () => res(200, '<html>Hotel Wi-Fi login</html>'), getMode: () => 'auto', timers: manualTimers(), log: {} });
  assert.equal((await portal.check()).online, false);
  assert.equal(isNetworkError(new Error('net::ERR_NAME_NOT_RESOLVED')), true);
  assert.equal(isNetworkError(new Error('HTTP 500')), false);
});

// ---------------------------------------------------------------- Cemu

function playStats(entries) {
  const buf = Buffer.alloc(4 + 256 * 20);
  buf.writeUInt32BE(entries.length, 0);
  entries.forEach((e, i) => {
    const off = 4 + i * 20;
    buf.writeUInt32BE(parseInt(e.id.slice(0, 8), 16), off);
    buf.writeUInt32BE(parseInt(e.id.slice(8), 16), off + 4);
    buf.writeUInt32BE(e.minutes, off + 8);
    buf.writeUInt16BE(e.launches || 1, off + 12);
    buf.writeUInt16BE(e.first || 0, off + 14);
    buf.writeUInt16BE(e.last || 0, off + 16);
  });
  return buf;
}

test('cemu: PlayStats.dat is read (big-endian, days since 2000)', () => {
  const now = new Date(2026, 10, 22).getTime();
  const map = parsePlayStats(playStats([
    { id: '0005000010176900', minutes: 754, launches: 12, first: 9000, last: 9821 },
    { id: '00050000101c9400', minutes: 5, first: 0, last: 0 },
  ]), now);
  const s = map.get('0005000010176900');
  assert.equal(s.minutes, 754);
  assert.equal(s.launches, 12);
  assert.equal(s.lastPlayed, dayToMs(9821));
  assert.equal(new Date(s.lastPlayed).getFullYear(), 2026);
  assert.equal(s.firstPlayed, dayToMs(9000));
  assert.equal(map.get('00050000101c9400').lastPlayed, 0, 'missing dates stay 0');
  assert.equal(parsePlayStats(Buffer.alloc(3)).size, 0);
  assert.equal(parsePlayStats(Buffer.alloc(4 + 256 * 20)).size, 0, 'all-zero file (Cemu "malformed") is empty');
});

test('cemu: play log found in a portable folder and via settings.xml <mlc_path>; Wii U games use it', async () => {
  const root = tmpDir();
  const exeDir = path.join(root, 'Cemu');
  fs.mkdirSync(path.join(exeDir, 'portable'), { recursive: true });
  fs.writeFileSync(path.join(exeDir, 'Cemu.exe'), 'x');
  const mlc = path.join(root, 'WiiU', 'mlc');
  fs.writeFileSync(path.join(exeDir, 'portable', 'settings.xml'), `<?xml version="1.0"?><content><mlc_path>${mlc}</mlc_path></content>`);
  const pdm = path.join(mlc, 'usr', 'save', 'system', 'pdm', '80000001');
  fs.mkdirSync(pdm, { recursive: true });
  fs.writeFileSync(path.join(pdm, 'PlayStats.dat'), playStats([{ id: '0005000010176900', minutes: 754, last: 9821 }]));
  const stats = await readCemuPlaytime(path.join(exeDir, 'Cemu.exe'), {});
  assert.equal(stats.get('0005000010176900').minutes, 754);
  assert.equal(await readCemuPlaytime(path.join(root, 'Other', 'Cemu.exe'), {}), null, 'no log → launcher keeps counting');

  // A Wii U game in folder format (code/meta) picks up Cemu's numbers.
  const games = path.join(root, 'games', 'Splatoon');
  fs.mkdirSync(path.join(games, 'code'), { recursive: true });
  fs.mkdirSync(path.join(games, 'meta'), { recursive: true });
  fs.writeFileSync(path.join(games, 'code', 'Gambit.rpx'), 'x');
  fs.writeFileSync(path.join(games, 'meta', 'meta.xml'), '<menu><title_id type="hexBinary" length="8">0005000010176900</title_id><shortname_en>Splatoon</shortname_en></menu>');
  const scan = await scanEmulator({ id: 'cemu1', name: 'Cemu', preset: 'cemu', exe: path.join(exeDir, 'Cemu.exe'), romDir: path.join(root, 'games'), extensions: ['rpx'], args: '-g "{rom}"' }, {});
  assert.equal(scan.games.length, 1);
  const g = scan.games[0];
  assert.equal(g.name, 'Splatoon');
  assert.equal(g.titleId, '0005000010176900');
  assert.equal(g.playtimeMinutes, 754);
  assert.equal(g.playtimeSource, 'cemu');
  assert.equal(g.tracksOwnPlaytime, true);
  assert.equal(g.lastPlayedDayOnly, true);
});

// ---------------------------------------------------------------- Xbox (OpenXBL)

test('xbox: OpenXBL answers are unwrapped and parsed', () => {
  assert.deepEqual(unwrap({ content: { a: 1 }, code: 200 }), { a: 1 });
  assert.throws(() => unwrap({ content: {}, code: 401 }), (e) => e.auth === true);
  assert.deepEqual(unwrap({ people: [] }), { people: [] });
  assert.deepEqual(parseAccount({ profileUsers: [{ id: '2533274800000000', settings: [{ id: 'Gamertag', value: 'Lolo' }, { id: 'Gamerscore', value: '4820' }, { id: 'GameDisplayPicRaw', value: 'https://images/x.png' }] }] }),
    { xuid: '2533274800000000', gamertag: 'Lolo', avatar: 'https://images/x.png', gamerscore: 4820 });
  const titles = parseTitles({ titles: [{ titleId: '1828326430', name: 'Minecraft', pfn: 'Microsoft.MinecraftUWP_8wekyb3d8bbwe', titleHistory: { lastTimePlayed: '2026-11-20T18:30:00.0000000Z' }, achievement: { currentAchievements: 12, totalAchievements: 120, currentGamerscore: 230, totalGamerscore: 1000, progressPercentage: 23 } }] });
  assert.equal(titles[0].lastPlayed, Date.UTC(2026, 10, 20, 18, 30));
  assert.equal(titles[0].ach.unlocked, 12);
  // userstats batch nesting
  const rows = parseMinutes({ statlistscollection: [{ arrangebyfield: 'xuid', arrangebyfieldid: '42', stats: [{ name: 'MinutesPlayed', titleid: '1828326430', value: '913' }, { name: 'Other', titleid: '1', value: '5' }] }] });
  assert.deepEqual(rows, [{ xuid: '42', titleId: '1828326430', minutes: 913 }]);
  const ach = parseAchievements({ achievements: [
    { id: '1', name: 'Taking Inventory', progressState: 'Achieved', progression: { timeUnlocked: '2026-01-02T10:00:00Z' }, description: 'Open your inventory.', mediaAssets: [{ type: 'Icon', url: 'https://img/1.png' }], rewards: [{ type: 'Gamerscore', value: '15' }], rarity: { currentPercentage: 80.5 } },
    { id: '2', name: 'Secret', progressState: 'NotStarted', progression: { timeUnlocked: '0001-01-01T00:00:00Z' }, isSecret: true, description: 'Spoiler', lockedDescription: '', rewards: [{ type: 'Gamerscore', value: '30' }], rarity: { currentPercentage: 3 } },
  ] });
  assert.equal(ach.unlocked, 1);
  assert.equal(ach.total, 2);
  assert.equal(ach.gamerscore, 15);
  assert.equal(ach.gamerscoreTotal, 45);
  assert.equal(ach.items[0].unlockTime, Date.UTC(2026, 0, 2, 10));
  assert.equal(ach.items[1].desc, '', 'secret achievements stay secret');
  assert.equal(ach.items[1].unlockTime, 0);
  const friends = parseFriends({ people: [{ xuid: '7', gamertag: 'RacerMika', displayPicRaw: 'https://p/7.png', presenceState: 'Online', presenceDetails: [{ IsGame: true, TitleId: '1828326430', State: 'Active' }] }] });
  assert.deepEqual(friends[0].playing, ['1828326430']);
  assert.deepEqual([...parsePresence([{ xuid: '7', devices: [{ titles: [{ id: '750323071', name: 'Home', state: 'Active' }, { id: '1828326430', name: 'Minecraft', state: 'Active' }] }] }])], [['7', ['1828326430']]]);
  assert.equal(titleIdFromHex('6CF8E31E'), '1828250398');
  assert.equal(titleIdFromHex('nope'), '');
});

test('xbox: library playtime by package name, cached, counted against the hourly limit', async () => {
  const store = new Store(tmpDir());
  await store.load();
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push(`${opts.method} ${url.replace(/^https:\/\/[^/]+(\/api)?\/v2/, '')}`);
    assert.equal(opts.headers['X-Authorization'], 'my-key-123');
    if (url.endsWith('/account')) return res(200, { content: { profileUsers: [{ id: '2533274800000000', settings: [{ id: 'Gamertag', value: 'Lolo' }] }] }, code: 200 });
    if (url.endsWith('/player/titleHistory')) return res(200, { xuid: '2533274800000000', titles: [{ titleId: '1828326430', name: 'Minecraft for Windows', pfn: 'Microsoft.MinecraftUWP_8wekyb3d8bbwe', titleHistory: { lastTimePlayed: '2026-11-20T18:30:00Z' }, achievement: { currentAchievements: 3, totalAchievements: 10 } }] });
    if (url.endsWith('/player/stats')) {
      const body = JSON.parse(opts.body);
      assert.deepEqual(body.stats, [{ name: 'MinutesPlayed', titleId: '1828326430' }]);
      return res(200, { statlistscollection: [{ arrangebyfield: 'xuid', arrangebyfieldid: '2533274800000000', stats: [{ name: 'MinutesPlayed', titleid: '1828326430', value: '913' }] }] });
    }
    return res(404, {});
  };
  const xbox = new XboxLive({ store, fetch, log: { warn() {} } });
  const local = [{ id: 'xbox:Microsoft.MinecraftUWP_8wekyb3d8bbwe', pfn: 'Microsoft.MinecraftUWP_8wekyb3d8bbwe', titleId: '', name: 'Minecraft' }];
  const info = await xbox.libraryInfo('my-key-123', local);
  const mc = info.get('xbox:Microsoft.MinecraftUWP_8wekyb3d8bbwe');
  assert.equal(mc.minutes, 913);
  assert.equal(mc.titleId, '1828326430');
  assert.equal(mc.ach.total, 10);
  assert.equal(calls.length, 3);
  await xbox.libraryInfo('my-key-123', local);
  assert.equal(calls.length, 3, 'second sync within the hour is served from the cache');
  assert.equal(xbox.remaining(), 137);
  // Offline: the last synced values, no requests.
  const offline = await xbox.libraryInfo('my-key-123', local, { refresh: false });
  assert.equal(offline.get(local[0].id).minutes, 913);
  assert.equal(calls.length, 3);
});

test('xbox: invalid key is reported, not retried forever', async () => {
  const store = new Store(tmpDir());
  await store.load();
  const xbox = new XboxLive({ store, fetch: async () => res(401, { code: 'ERROR', message: 'Invalid API key.' }), log: { warn() {} } });
  await assert.rejects(() => xbox.account('bad'), (e) => e.auth === true);
  assert.equal(xbox.status().authError, true);
});

// ---------------------------------------------------------------- library playtime sources

test('library: playtime source and "last booted" per game', async () => {
  const store = new Store(tmpDir());
  await store.load();
  const lib = new Library({ store, probe: async () => ({}), env: {}, log: { warn() {}, error() {}, info() {} } });
  store.playtime['epic:a'] = { minutes: 40, lastPlayed: 1700000000000 };
  store.playtime['emu:c'] = { minutes: 30, lastPlayed: dayToMs(9821) + 20 * 3600e3 };
  const epic = lib.toPublic({ id: 'epic:a', source: 'epic', name: 'A', installed: true, status: 'installed', playtimeMinutes: 0, lastPlayed: 0 });
  assert.equal(epic.playtimeKnown, false);
  assert.equal(epic.playtimeSource, 'tracked');
  assert.equal(epic.lastBooted, 1700000000000);
  const steam = lib.toPublic({ id: 'steam:1', source: 'steam', name: 'S', installed: true, status: 'installed', playtimeMinutes: 5, lastPlayed: 1, tracksOwnPlaytime: true });
  assert.equal(steam.playtimeKnown, true);
  const cemu = lib.toPublic({ id: 'emu:c', source: 'emulators', name: 'C', installed: true, status: 'installed', playtimeMinutes: 754, lastPlayed: dayToMs(9821), lastPlayedDayOnly: true, playtimeSource: 'cemu', tracksOwnPlaytime: true });
  assert.equal(cemu.playtimeMinutes, 754, 'Cemu counts our sessions itself: not added twice');
  assert.equal(cemu.playtimeSource, 'cemu');
  assert.equal(cemu.lastPlayedDayOnly, false, 'the exact start time from here replaces the day-only date');
});

test('settings: offline mode, known-playtime option and Xbox key', () => {
  const s = sanitizeSettings({ onlineMode: 'offline', onlyKnownPlaytime: false, xblApiKey: ' ab12-cd34-ef56 ' });
  assert.equal(s.onlineMode, 'offline');
  assert.equal(s.onlyKnownPlaytime, false);
  assert.equal(s.xblApiKey, 'ab12-cd34-ef56');
  const d = sanitizeSettings({ onlineMode: 'sometimes' });
  assert.equal(d.onlineMode, 'auto');
  assert.equal(d.onlyKnownPlaytime, true);
});

test('xbox: played-but-not-installed PC games appear in the library (Steam-style)', async () => {
  const store = new Store(tmpDir());
  await store.load();
  store.updateSettings({ xblApiKey: 'key-1', showUninstalledXbox: true });
  const titles = [
    { titleId: '1', name: 'Minecraft for Windows', pfn: 'Microsoft.MinecraftUWP_8wekyb3d8bbwe', type: 'Game', devices: ['PC'], titleHistory: { lastTimePlayed: '2026-11-20T10:00:00Z' } },
    { titleId: '2', name: 'Forza Horizon 5', pfn: 'Microsoft.624F8B84B80_8wekyb3d8bbwe', type: 'Game', devices: ['PC', 'XboxSeries'], productId: '9nkx70bbcdrn', displayImage: 'https://store-images.example/fh5.png', titleHistory: { lastTimePlayed: '2026-10-01T10:00:00Z' }, achievement: { currentAchievements: 40, totalAchievements: 200 } },
    { titleId: '3', name: 'Halo 5', type: 'Game', devices: ['XboxOne'], titleHistory: { lastTimePlayed: '2025-01-01T10:00:00Z' } },
    { titleId: '4', name: 'Netflix', type: 'App', devices: ['PC'] },
    { titleId: '5', name: 'Hollow Knight', type: 'Game', devices: ['PC'] },
  ];
  const fetch = async (url, opts) => {
    if (url.endsWith('/account')) return res(200, { profileUsers: [{ id: '2533274800000000', settings: [{ id: 'Gamertag', value: 'Lolo' }] }] });
    if (url.endsWith('/player/titleHistory')) return res(200, { titles });
    if (url.endsWith('/player/stats')) {
      const body = JSON.parse(opts.body);
      return res(200, { statlistscollection: [{ arrangebyfield: 'xuid', arrangebyfieldid: '2533274800000000', stats: body.stats.map((x) => ({ name: 'MinutesPlayed', titleid: x.titleId, value: x.titleId === '2' ? '1500' : '60' })) }] });
    }
    return res(404, {});
  };
  const xbox = new XboxLive({ store, fetch, log: { warn() {} } });
  const lib = new Library({ store, probe: async () => ({}), xbox, env: {}, log: { warn() {}, error() {}, info() {} } });
  const all = [
    { id: 'xbox:Microsoft.MinecraftUWP_8wekyb3d8bbwe', source: 'xbox', sourceId: 'Microsoft.MinecraftUWP_8wekyb3d8bbwe', name: 'Minecraft', installed: true, status: 'installed' },
    { id: 'steam:367520', source: 'steam', sourceId: '367520', name: 'Hollow Knight', installed: true, status: 'installed' },
  ];
  const status = { xbox: {} };
  await lib._mergeXbox(all, status);
  const ids = all.map((g) => g.id);
  assert.ok(ids.includes('xbox:title:2'), 'Forza (PC, not installed) is added');
  assert.ok(!ids.includes('xbox:title:1'), 'installed game is not added twice');
  assert.ok(!ids.includes('xbox:title:3'), 'console-only game is skipped');
  assert.ok(!ids.includes('xbox:title:4'), 'apps are skipped');
  assert.ok(!ids.includes('xbox:title:5'), 'already in the library from Steam');
  const fh5 = all.find((g) => g.id === 'xbox:title:2');
  assert.equal(fh5.status, 'notInstalled');
  assert.equal(fh5.playtimeMinutes, 1500);
  assert.equal(fh5.playtimeSource, 'xbox');
  assert.equal(fh5.install.url, 'ms-windows-store://pdp/?ProductId=9NKX70BBCDRN');
  assert.equal(fh5.remoteArt.square, 'https://store-images.example/fh5.png');
  assert.equal(fh5.xboxAchievements.total, 200);
  assert.equal(status.xbox.owned, 1);
  // Switched off: nothing added.
  store.updateSettings({ showUninstalledXbox: false });
  const again = [all[0]];
  await lib._mergeXbox(again, { xbox: {} });
  assert.equal(again.length, 1);
});
