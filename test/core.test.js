'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const { tmpDir, write } = require('./helpers');
const { Store } = require('../src/main/store');
const { Artwork, findSteamCached } = require('../src/main/artwork');
const { Library } = require('../src/main/library');
const { Sessions } = require('../src/main/sessions');
const { SteamWeb } = require('../src/main/steamweb');

function fakeResponse({ status = 200, type = 'image/jpeg', body = Buffer.alloc(4096, 1), json = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? type : null) },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    json: async () => { if (json === null) throw new Error('no json'); return json; },
  };
}

async function waitFor(fn, ms = 3000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

test('artwork: finds Steam cache files in flat, per-app and hashed layouts', async () => {
  const lc = tmpDir();
  write(path.join(lc, '10_library_600x900.jpg'), 'a');
  write(path.join(lc, '20', 'library_600x900.jpg'), 'b');
  write(path.join(lc, '30', 'a'.repeat(40), 'library_600x900.jpg'), 'c');
  write(path.join(lc, '30', 'not-a-hash', 'library_600x900.jpg'), 'd');
  const names = ['library_600x900_2x.jpg', 'library_600x900.jpg'];
  assert.equal(await findSteamCached(lc, 10, names), path.join(lc, '10_library_600x900.jpg'));
  assert.equal(await findSteamCached(lc, 20, names), path.join(lc, '20', 'library_600x900.jpg'));
  assert.equal(await findSteamCached(lc, 30, names), path.join(lc, '30', 'a'.repeat(40), 'library_600x900.jpg'));
  assert.equal(await findSteamCached(lc, 40, names), null);
  assert.equal(await findSteamCached(null, 40, names), null);
});

test('artwork: resolves Steam (local + CDN), GOG (API) and SteamGridDB fallback', async () => {
  const data = tmpDir();
  const store = new Store(data);
  await store.load();
  store.settings = { ...store.settings, sgdbApiKey: 'KEY' };
  const lc = tmpDir();
  write(path.join(lc, '570', 'library_600x900_2x.jpg'), Buffer.alloc(5000, 2));
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url, auth: opts && opts.headers && opts.headers.Authorization });
    if (url.includes('/steam/apps/570/library_hero.jpg')) return fakeResponse();
    if (url.includes('/steam/apps/570/logo.png')) return fakeResponse({ type: 'image/png' });
    if (url.startsWith('https://api.gog.com/v2/games/1207664663')) {
      return fakeResponse({ type: 'application/json', json: { _links: { boxArtImage: { href: 'https://images.gog-statics.com/box.jpg' }, galaxyBackgroundImage: { href: 'https://images.gog-statics.com/bg_{formatter}.jpg' } } } });
    }
    if (url === 'https://images.gog-statics.com/box.jpg' || url === 'https://images.gog-statics.com/bg.jpg') return fakeResponse();
    if (url.startsWith('https://www.steamgriddb.com/api/v2/search/autocomplete/')) return fakeResponse({ type: 'application/json', json: { success: true, data: [{ id: 99 }] } });
    if (url.startsWith('https://www.steamgriddb.com/api/v2/grids/game/99')) return fakeResponse({ type: 'application/json', json: { success: true, data: [{ url: 'https://cdn2.steamgriddb.com/grid/x.png', thumb: 't', mime: 'image/png' }] } });
    if (url.startsWith('https://www.steamgriddb.com/api/v2/heroes/game/99')) return fakeResponse({ type: 'application/json', json: { success: true, data: [{ url: 'https://cdn2.steamgriddb.com/hero/y.webp', mime: 'image/webp' }, { url: 'https://cdn2.steamgriddb.com/hero/z.jpg', mime: 'image/jpeg', nsfw: false }] } });
    if (url.startsWith('https://cdn2.steamgriddb.com/')) return fakeResponse({ type: url.endsWith('.png') ? 'image/png' : 'image/jpeg' });
    return fakeResponse({ status: 404, type: 'text/html' });
  };
  const art = new Artwork({ store, fetch, log: { warn() {}, error() {} } });
  const games = [
    { id: 'steam:570', source: 'steam', sourceId: '570', name: 'Dota 2' },
    { id: 'gog:1207664663', source: 'gog', sourceId: '1207664663', name: 'The Witcher 3' },
    { id: 'epic:Fortnite', source: 'epic', sourceId: 'Fortnite', name: 'Fortnite' },
  ];
  art.enqueue(games, { steamMeta: { libraryCache: lc }, settings: store.settings });
  assert.ok(await waitFor(() => Object.keys(store.artIndex).length === 3 && art.active === 0));
  const s = store.artIndex['steam:570'];
  assert.ok(s.cover && s.hero && s.logo, JSON.stringify(s));
  assert.equal(fs.readFileSync(path.join(store.dirs.art, s.cover)).length, 5000); // copied from local cache
  const g = store.artIndex['gog:1207664663'];
  assert.ok(g.cover && g.hero, JSON.stringify(g));
  const e = store.artIndex['epic:Fortnite'];
  assert.ok(e.cover && e.cover.endsWith('.png'), JSON.stringify(e));
  assert.ok(e.hero && e.hero.endsWith('.jpg'), 'webp hero skipped, jpg chosen');
  assert.ok(calls.filter((c) => c.url.includes('steamgriddb.com/api')).every((c) => c.auth === 'Bearer KEY'));
  assert.ok(!calls.some((c) => c.url.includes('/steam/apps/570/library_600x900')), 'local cover used, no CDN request');
  const urls = art.urlsFor('steam:570', {});
  assert.match(urls.cover, /^dl:\/\/art\/steam_570-[0-9a-f]{8}-cover\.jpg\?v=\d+$/);
  const custom = art.urlsFor('steam:570', { customArt: { cover: 'x.png' } });
  assert.equal(custom.cover, 'dl://art/x.png');
  // Nothing more to do now: no new work queued.
  assert.equal(art.needsWork('steam:570'), false);
});

test('library: merges sources, overrides, tracked playtime and Steam owned games', async () => {
  const data = tmpDir();
  const store = new Store(data);
  await store.load();
  const root = tmpDir();
  const exe = write(path.join(root, 'game.exe'), 'x');
  store.updateSettings({ manualGames: [{ id: 'm1', name: 'Manual One', path: exe }], steamApiKey: 'K', steamId: '76561198000000001', sources: { steam: true } });
  store.setOverride('manual:m1', { favorite: true, subscription: 'gamepass' });
  store.addPlaytime('manual:m1', 90, 1700000000000);
  const steamWeb = { ownedGames: async () => [{ appid: 10, name: 'Counter-Strike', playtime_forever: 600, rtime_last_played: 1600000000 }] };
  const probe = async () => ({ registry: {}, appx: [], battery: 1 });
  const lib = new Library({ store, probe, artwork: null, steamWeb, env: {}, log: { error() {}, warn() {} } });
  let updates = 0;
  lib.on('updated', () => updates++);
  const list = await lib.scan();
  assert.equal(lib.hasBattery, true);
  const manual = list.find((g) => g.id === 'manual:m1');
  assert.equal(manual.favorite, true);
  assert.equal(manual.subscription, 'gamepass');
  assert.equal(manual.playtimeMinutes, 90);
  assert.equal(manual.lastPlayed, 1700000000000);
  assert.equal(manual.actions.play, true);
  const cs = list.find((g) => g.id === 'steam:10');
  assert.equal(cs.status, 'notInstalled');
  assert.equal(cs.actions.install, true);
  assert.equal(cs.actions.play, false);
  assert.equal(cs.playtimeMinutes, 600);
  assert.ok(updates >= 1);
  lib.setRunning('manual:m1', true);
  assert.equal(lib.toPublic(lib.get('manual:m1')).status, 'running');
  // Owned list is cached.
  assert.equal(store.steamWeb.owned.games.length, 1);
  // Disabled source returns nothing.
  store.updateSettings({ sources: { manual: false } });
  const list2 = await lib.scan();
  assert.equal(list2.some((g) => g.source === 'manual'), false);
  assert.equal(lib.sourceStatus.manual.enabled, false);
});

test('sessions: url launch, poll detection and playtime', async () => {
  const data = tmpDir();
  const store = new Store(data);
  await store.load();
  const opened = [];
  let procs = [];
  const s = new Sessions({
    openExternal: async (u) => { opened.push(u); },
    openPath: async () => '',
    listProcesses: async () => procs,
    listProcessNames: async () => new Set(procs.map((p) => p.name)),
    findExecutables: async () => new Set(),
    timers: { setTimeout: () => null, clearTimeout: () => {} },
    store,
    log: { warn() {} },
  });
  const ended = [];
  s.on('ended', (id, info) => ended.push([id, info]));
  const game = { id: 'epic:X', installDir: 'C:\\Games\\X', launch: { type: 'url', url: 'com.epicgames.launcher://apps/X?action=launch&silent=true' }, tracksOwnPlaytime: false };
  await s.launch(game);
  assert.deepEqual(opened, [game.launch.url]);
  assert.equal(s.isRunning('epic:X'), true);
  // Simulate detection and time passing.
  procs = [{ name: 'x.exe', path: 'C:\\Games\\X\\Bin\\x.exe' }, { name: 'explorer.exe', path: 'C:\\Windows\\explorer.exe' }];
  await s._tick();
  const sess = s.sessions.get('epic:X');
  assert.ok(sess.detectedAt > 0);
  sess.detectedAt -= 30 * 60000; // pretend it started 30 minutes ago
  procs = [{ name: 'other.exe', path: 'C:\\Games\\XY\\other.exe' }];
  await s._tick();
  assert.equal(s.isRunning('epic:X'), false);
  assert.equal(ended[0][0], 'epic:X');
  assert.equal(ended[0][1].detected, true);
  assert.ok(Math.abs(store.playtime['epic:X'].minutes - 30) <= 1);
  s.stopAll();
});

test('sessions: exe spawn failure is reported; emulator child exit ends session', async () => {
  const data = tmpDir();
  const store = new Store(data);
  await store.load();
  const children = [];
  const spawnFn = (file, args) => {
    const child = new EventEmitter();
    child.unref = () => {};
    child.file = file; child.args = args;
    children.push(child);
    setTimeout(() => (file === 'missing.exe' ? child.emit('error', new Error('ENOENT')) : child.emit('spawn')), 5);
    return child;
  };
  const s = new Sessions({ openExternal: async () => {}, openPath: async () => '', listProcesses: async () => [], findExecutables: async () => new Set(), timers: { setTimeout: () => null, clearTimeout: () => {} }, store, spawnFn, log: { warn() {} } });
  await assert.rejects(s.launch({ id: 'manual:a', installDir: 'C:\\x', launch: { type: 'exe', path: 'missing.exe', args: [] } }));
  await s.launch({ id: 'emu:1', installDir: 'C:\\roms', launch: { type: 'exe', path: 'pcsx2.exe', args: ['-batch', 'C:\\roms\\a b.iso'], cwd: 'C:\\pcsx2', trackChild: true } });
  assert.deepEqual(children[1].args, ['-batch', 'C:\\roms\\a b.iso']);
  assert.equal(s.isRunning('emu:1'), true);
  s.sessions.get('emu:1').detectedAt -= 10 * 60000;
  children[1].emit('exit', 0);
  assert.equal(s.isRunning('emu:1'), false);
  assert.ok(store.playtime['emu:1'].minutes >= 9);
  // GOG-style string args are split.
  await s.launch({ id: 'gog:1', installDir: 'C:\\g', launch: { type: 'exe', path: 'g.exe', args: '-a "b c"' } });
  assert.deepEqual(children[2].args, ['-a', 'b c']);
  s.stopAll();
});

test('steam web: achievements and friends index', async () => {
  const data = tmpDir();
  const store = new Store(data);
  await store.load();
  const fetch = async (url) => {
    if (url.includes('GetPlayerAchievements')) return fakeResponse({ type: 'application/json', json: { playerstats: { success: true, achievements: [{ apiname: 'A', achieved: 1, unlocktime: 100 }, { apiname: 'B', achieved: 0 }, { apiname: 'C', achieved: 1, unlocktime: 200 }] } } });
    if (url.includes('GetSchemaForGame')) return fakeResponse({ type: 'application/json', json: { game: { availableGameStats: { achievements: [{ name: 'A', displayName: 'First', description: 'd', icon: 'https://i/a.jpg', icongray: 'https://i/ag.jpg' }] } } } });
    if (url.includes('GetGlobalAchievementPercentages')) return fakeResponse({ type: 'application/json', json: { achievementpercentages: { achievements: [{ name: 'A', percent: '50.04' }, { name: 'B', percent: 3.2 }] } } });
    if (url.includes('GetFriendList')) return fakeResponse({ type: 'application/json', json: { friendslist: { friends: [{ steamid: '76561198000000002' }, { steamid: '76561198000000003' }] } } });
    if (url.includes('GetPlayerSummaries')) return fakeResponse({ type: 'application/json', json: { response: { players: [{ steamid: '76561198000000002', personaname: 'Sam', avatarmedium: 'https://a/s.jpg' }, { steamid: '76561198000000003', personaname: 'Jo' }] } } });
    if (url.includes('GetOwnedGames') && url.includes('76561198000000002')) return fakeResponse({ type: 'application/json', json: { response: { games: [{ appid: 570, playtime_forever: 10 }, { appid: 620, playtime_forever: 0 }] } } });
    if (url.includes('GetOwnedGames')) return fakeResponse({ status: 401, type: 'application/json', json: {} });
    return fakeResponse({ status: 404 });
  };
  const sw = new SteamWeb({ store, fetch });
  assert.deepEqual(await sw.achievements('K', '1', 570), { unlocked: 2, total: 3 });
  const full = await sw.achievementsFull('K', '1', 570, 'de');
  assert.deepEqual(full.items.map((i) => i.id), ['C', 'A', 'B']); // newest unlock first, then locked
  assert.equal(full.items[1].name, 'First');
  assert.equal(full.items[1].icon, 'https://i/a.jpg');
  assert.equal(full.items[1].percent, 50);
  assert.equal(full.items[2].icon, '');
  assert.equal(full.items[2].achieved, false);
  await sw.buildFriendsIndex('K', '76561198000000001');
  assert.deepEqual(sw.friendsFor(570), { count: 1, people: [{ name: 'Sam', avatar: 'https://a/s.jpg' }] });
  assert.deepEqual(sw.friendsFor(620), { count: 0, people: [] });
  const detail = await sw.friendsDetail('K', '76561198000000001', 570);
  assert.equal(detail.list.length, 1);
  assert.equal(detail.list[0].name, 'Sam');
  assert.equal(detail.list[0].minutes, 10);
  assert.equal(detail.list[0].playingNow, false);
  const t = await sw.test('K', '76561198000000002');
  assert.equal(t.ok, true);
  assert.equal(t.name, 'Sam');
});
