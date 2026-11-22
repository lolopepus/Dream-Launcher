'use strict';
/** Version 2.4: Cemu screenshots, play session times, SteamGridDB names. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers');
const { Store } = require('../src/main/store');
const { cemuScreenshots, matchShots } = require('../src/main/cemu');
const { sgdbName, Artwork } = require('../src/main/artwork');

test('cemu: screenshots from its data folder, newest first, with the time from the name', async () => {
  const root = tmpDir('cemu');
  const exe = path.join(root, 'Cemu.exe');
  fs.writeFileSync(exe, '');
  const appdata = tmpDir('appdata');
  const shots = path.join(appdata, 'Cemu', 'screenshots');
  fs.mkdirSync(shots, { recursive: true });
  for (const n of ['Screenshot_2026-11-20_18-30-05.png', 'Screenshot_2026-11-22_09-00-00_GamePad.png', 'Screenshot_2026-11-22_09-00-00_2.png', 'notes.txt', 'Screenshot_bad.png']) {
    fs.writeFileSync(path.join(shots, n), 'x');
  }
  const list = await cemuScreenshots(exe, { APPDATA: appdata });
  assert.deepEqual(list.map((s) => path.basename(s.path)).sort(), ['Screenshot_2026-11-20_18-30-05.png', 'Screenshot_2026-11-22_09-00-00_2.png', 'Screenshot_2026-11-22_09-00-00_GamePad.png']);
  assert.equal(list[list.length - 1].time, new Date(2026, 10, 20, 18, 30, 5).getTime());
  assert.ok(list[0].time >= list[1].time);
  // Portable Cemu: the "portable" folder next to the exe.
  fs.mkdirSync(path.join(root, 'portable', 'screenshots'), { recursive: true });
  fs.writeFileSync(path.join(root, 'portable', 'screenshots', 'Screenshot_2026-11-23_10-00-00.png'), 'x');
  assert.equal((await cemuScreenshots(exe, { APPDATA: appdata })).length, 4);
  assert.deepEqual(await cemuScreenshots(path.join(tmpDir('none'), 'Cemu.exe'), {}), []);
});

test('cemu: screenshots belong to the game played at that time', () => {
  const at = (h, m) => new Date(2026, 10, 22, h, m).getTime();
  const shots = [{ time: at(9, 5) }, { time: at(12, 0) }, { time: at(14, 31) }, { time: at(20, 0) }];
  const sessions = [[at(9, 0), at(10, 0)], [at(14, 0), at(14, 30)]];
  // 14:31 is just after the session ended (closing the game): still counts.
  assert.deepEqual(matchShots(shots, sessions).map((s) => s.time), [at(9, 5), at(14, 31)]);
  assert.deepEqual(matchShots(shots, []), []);
  assert.deepEqual(matchShots(shots, undefined), []);
  assert.equal(matchShots(shots, [], { onlyGame: true }).length, 4, 'the only Cemu game gets all of them');
});

test('sessions: start and end of each play are kept (newest 300)', async () => {
  const store = new Store(tmpDir());
  await store.load();
  store.addSession('emulators:zelda', 1000, 5000);
  store.addSession('emulators:zelda', 9000, 8000); // nonsense: ignored
  assert.deepEqual(store.playtime['emulators:zelda'].sessions, [[1000, 5000]]);
  for (let i = 0; i < 310; i++) store.addSession('g', i * 10 + 1, i * 10 + 5);
  assert.equal(store.playtime.g.sessions.length, 300);
  assert.deepEqual(store.playtime.g.sessions[0], [101, 105]);
});

test('artwork: Minecraft for Windows is searched as "Minecraft" on SteamGridDB, and looked up again', async () => {
  assert.equal(sgdbName('Minecraft for Windows'), 'Minecraft');
  assert.equal(sgdbName('Minecraft® for Windows'), 'Minecraft');
  assert.equal(sgdbName('Halo Infinite'), 'Halo Infinite');

  const store = new Store(tmpDir());
  await store.load();
  store.updateSettings({ sgdbApiKey: 'k' });
  const searched = [];
  const fetch = async (url) => {
    const m = /search\/autocomplete\/(.+)$/.exec(url);
    if (m) {
      searched.push(decodeURIComponent(m[1]));
      const hit = decodeURIComponent(m[1]) === 'Minecraft' || decodeURIComponent(m[1]) === 'Forza Horizon 5';
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ success: true, data: hit ? [{ id: 7 }] : [] }) };
    }
    return { ok: false, status: 404, headers: { get: () => 'text/html' }, json: async () => ({}) };
  };
  const art = new Artwork({ store, fetch, log: { warn() {}, error() {} } });
  art.ctx = { settings: store.settings };
  assert.equal(await art._sgdbGameId({ id: 'xbox:mc', source: 'xbox', name: 'Minecraft for Windows' }, 'k'), 7);
  assert.deepEqual(searched, ['Minecraft']);
  // Other "… for Windows" names: the plain name is tried when the full one finds nothing.
  searched.length = 0;
  assert.equal(await art._sgdbGameId({ id: 'xbox:fh5', source: 'xbox', name: 'Forza Horizon 5 for Windows' }, 'k'), 7);
  assert.deepEqual(searched, ['Forza Horizon 5 for Windows', 'Forza Horizon 5']);

  // Looked at before with SteamGridDB but without the new name: looked up again right away.
  store.artIndex['xbox:mc'] = { v: 3, cover: 'c.jpg', hero: null, logo: null, triedAt: Date.now(), withSgdb: true };
  store.artIndex['xbox:halo'] = { v: 3, cover: 'c.jpg', hero: null, logo: null, triedAt: Date.now(), withSgdb: true };
  assert.equal(art.needsWork('xbox:mc', false, { id: 'xbox:mc', name: 'Minecraft for Windows' }), true);
  assert.equal(art.needsWork('xbox:halo', false, { id: 'xbox:halo', name: 'Halo Infinite' }), false, 'other games wait as before');
  // Once looked up with the new name, it waits like any other game.
  store.artIndex['xbox:mc'].searchV = 2;
  assert.equal(art.needsWork('xbox:mc', false, { id: 'xbox:mc', name: 'Minecraft for Windows' }), false);
});
