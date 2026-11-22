'use strict';
/** Play session tracking: when does a game count as running, and when has it closed? */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { tmpDir } = require('./helpers');
const { Store } = require('../src/main/store');
const { Sessions, findExecutables, isHelperExe } = require('../src/main/sessions');

async function setup({ exes = new Set(), names = 'auto' } = {}) {
  const store = new Store(tmpDir());
  await store.load();
  const state = { procs: [], names, fullCalls: 0, nameCalls: 0 };
  let now = 1_000_000;
  const s = new Sessions({
    openExternal: async () => {},
    openPath: async () => '',
    listProcesses: async () => { state.fullCalls++; return state.procs; },
    listProcessNames: async () => {
      state.nameCalls++;
      if (state.names === 'fail') return null;
      return new Set(state.procs.map((p) => p.name));
    },
    findExecutables: async () => exes,
    spawnFn: () => { const c = new EventEmitter(); c.unref = () => {}; setTimeout(() => c.emit('spawn'), 1); return c; },
    timers: { setTimeout: () => null, clearTimeout: () => {} },
    now: () => now,
    store,
    log: { warn() {} },
  });
  const ended = [];
  s.on('ended', (id, info) => ended.push({ id, ...info }));
  return { s, store, state, ended, advance: (ms) => { now += ms; } };
}

test('xbox: recognised by its declared program name even outside the package folder', async () => {
  const { s, state, ended, advance, store } = await setup();
  await s.launch({ id: 'xbox:mc', installDir: 'C:\\Program Files\\WindowsApps\\Microsoft.MinecraftUWP_1', exeNames: ['Minecraft.Windows.exe', 'GameLaunchHelper.exe'], launch: { type: 'shell', target: 'shell:AppsFolder\\x!Game' } });
  assert.equal(s.sessions.get('xbox:mc').mode, 'poll');
  state.procs = [{ name: 'minecraft.windows.exe', path: 'C:\\XboxGames\\Minecraft for Windows\\Content\\Minecraft.Windows.exe' }];
  await s._tick();
  assert.ok(s.sessions.get('xbox:mc').detectedAt);
  advance(20 * 60000);
  await s._tick(); // still running (fast name check)
  assert.equal(s.isRunning('xbox:mc'), true);
  state.procs = [];
  await s._tick();
  assert.equal(s.isRunning('xbox:mc'), false);
  assert.equal(ended[0].detected, true);
  assert.equal(store.playtime['xbox:mc'].minutes, 20);
});

test('elevated game: no path visible, matched by program names found in its folder', async () => {
  const { s, state } = await setup({ exes: new Set(['game.exe']) });
  await s.launch({ id: 'steam:1', installDir: 'D:\\Steam\\steamapps\\common\\Game', tracksOwnPlaytime: true, launch: { type: 'url', url: 'steam://rungameid/1' } });
  await new Promise((r) => setImmediate(r)); // folder scan finishes
  state.procs = [{ name: 'game.exe', path: '' }, { name: 'other.exe', path: '' }];
  await s._tick();
  assert.ok(s.sessions.get('steam:1').detectedAt);
  // In the full list, a process with the same name but a visible path elsewhere does not count.
  const sess = s.sessions.get('steam:1');
  assert.equal(s._matches(sess, { name: 'game.exe', path: 'C:\\Elsewhere\\game.exe' }), false);
  assert.equal(s._matches(sess, { name: 'game.exe', path: 'D:\\Steam\\steamapps\\common\\Game\\game.exe' }), true);
  state.procs = [];
  await s._tick();
  assert.equal(s.isRunning('steam:1'), false);
});

test('closing is confirmed with the full list (the game may switch programs)', async () => {
  const { s, state } = await setup();
  await s.launch({ id: 'epic:a', installDir: 'C:\\Games\\A', launch: { type: 'url', url: 'x://a' } });
  state.procs = [{ name: 'launcher.exe', path: 'C:\\Games\\A\\launcher.exe' }];
  await s._tick();
  // The launcher closes and the real game starts from the same folder.
  state.procs = [{ name: 'game-win64.exe', path: 'C:\\Games\\A\\bin\\game-win64.exe' }];
  await s._tick();
  assert.equal(s.isRunning('epic:a'), true);
  assert.deepEqual([...s.sessions.get('epic:a').names], ['game-win64.exe']);
  state.procs = [];
  await s._tick();
  assert.equal(s.isRunning('epic:a'), false);
});

test('falls back to the full list when tasklist is unavailable', async () => {
  const { s, state } = await setup({ names: 'fail' });
  await s.launch({ id: 'ubi:1', installDir: 'C:\\U\\G', launch: { type: 'url', url: 'uplay://launch/1/0' } });
  state.procs = [{ name: 'g.exe', path: 'C:\\U\\G\\g.exe' }];
  await s._tick();
  await s._tick();
  assert.equal(s.isRunning('ubi:1'), true);
  state.procs = [];
  await s._tick();
  assert.equal(s.isRunning('ubi:1'), false);
});

test('never detected: session is dropped after the timeout without playtime', async () => {
  const { s, ended, advance, store } = await setup();
  await s.launch({ id: 'epic:b', installDir: 'C:\\Games\\B', launch: { type: 'url', url: 'x://b' } });
  await s._tick();
  assert.equal(s.isRunning('epic:b'), true);
  advance(5 * 60000);
  await s._tick();
  assert.equal(s.isRunning('epic:b'), false);
  assert.equal(ended[0].detected, false);
  assert.equal(store.playtime['epic:b'] && store.playtime['epic:b'].minutes, 0);
});

test('stop() ends a session by hand and keeps the playtime', async () => {
  const { s, state, ended, advance, store } = await setup();
  await s.launch({ id: 'gog:1', installDir: 'C:\\GOG\\G', launch: { type: 'url', url: 'x://g' } });
  state.procs = [{ name: 'g.exe', path: 'C:\\GOG\\G\\g.exe' }];
  await s._tick();
  advance(12 * 60000);
  assert.equal(s.stop('gog:1'), true);
  assert.equal(s.isRunning('gog:1'), false);
  assert.equal(ended[0].manual, true);
  assert.equal(store.playtime['gog:1'].minutes, 12);
  assert.equal(s.stop('gog:1'), false);
});

test('checkNow() runs a check right away, but not twice in a row', async () => {
  const { s } = await setup();
  const scheduled = [];
  s.timers = { setTimeout: (fn, ms) => { scheduled.push(ms); return { unref() {} }; }, clearTimeout: () => {} };
  s.checkNow(); // nothing to watch
  assert.deepEqual(scheduled, []);
  await s.launch({ id: 'epic:c', installDir: 'C:\\C', launch: { type: 'url', url: 'x://c' } });
  scheduled.length = 0;
  s.checkNow();
  s.checkNow();
  assert.deepEqual(scheduled, [0]);
});

test('findExecutables skips installers, crash reporters and redistributables', async () => {
  const dir = tmpDir();
  const mk = (rel) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), 'x'); };
  mk('Game.exe');
  mk('bin/Win64/Game-Win64-Shipping.exe');
  mk('unins000.exe');
  mk('UnityCrashHandler64.exe');
  mk('_CommonRedist/vcredist/vc_redist.x64.exe');
  mk('EasyAntiCheat/EasyAntiCheat_EOS_Setup.exe');
  mk('readme.txt');
  const names = await findExecutables(dir);
  assert.deepEqual([...names].sort(), ['game-win64-shipping.exe', 'game.exe']);
  assert.equal(isHelperExe('crashreportclient.exe'), true);
  assert.equal(isHelperExe('eldenring.exe'), false);
});
