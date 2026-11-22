'use strict';
/**
 * Starts src/main/main.js with a simulated Electron module and exercises the IPC handlers
 * and the app:// / dl:// protocols. Catches wiring mistakes without a real Electron.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const { tmpDir, write } = require('./helpers');

function makeFakeElectron(userData) {
  const handlers = {};
  const protocols = {};
  const sent = [];
  const opened = [];
  let dialogResult = { canceled: true, filePaths: [] };
  let saveResult = { canceled: true };

  class FakeWebContents extends EventEmitter {
    send(ch, ...args) { sent.push([ch, ...args]); }
    setWindowOpenHandler() {}
    toggleDevTools() {}
  }
  class FakeWindow extends EventEmitter {
    constructor(opts) { super(); this.opts = opts; this.webContents = new FakeWebContents(); this.fs = !!opts.fullscreen; this.minimized = false; FakeWindow.last = this; }
    loadURL(u) { this.url = u; setTimeout(() => this.emit('ready-to-show'), 5); }
    isDestroyed() { return false; }
    isFullScreen() { return this.fs; }
    setFullScreen(v) { this.fs = v; }
    minimize() { this.minimized = true; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
    show() {}
    focus() {}
    isFocused() { return true; }
  }
  const app = new EventEmitter();
  Object.assign(app, {
    setName() {}, setAppUserModelId() {},
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    getPath: (n) => (n === 'userData' ? userData : path.join(userData, n)),
    isPackaged: false,
    getVersion: () => '0.1.0',
    getLocale: () => 'de-DE',
    getPreferredSystemLanguages: () => ['de-DE', 'en-US'],
    quit() {}, exit() {}, setLoginItemSettings() {},
  });
  const electron = {
    app,
    BrowserWindow: FakeWindow,
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    protocol: { registerSchemesAsPrivileged() {}, handle: (s, fn) => { protocols[s] = fn; } },
    shell: {
      openExternal: async (u) => { opened.push(u); },
      openPath: async (p) => { opened.push(p); return ''; },
      showItemInFolder: (p) => opened.push(p),
    },
    dialog: {
      showOpenDialog: async () => dialogResult,
      showSaveDialog: async () => saveResult,
    },
    net: { fetch: async () => ({ ok: false, status: 404, headers: { get: () => null }, json: async () => null, arrayBuffer: async () => new ArrayBuffer(0) }) },
    Menu: { setApplicationMenu() {} },
  };
  return {
    electron, handlers, protocols, sent, opened,
    setDialog: (r) => { dialogResult = r; },
    setSave: (r) => { saveResult = r; },
    win: () => FakeWindow.last,
  };
}

test('main process boots and answers IPC + protocol requests', async () => {
  const userData = tmpDir();
  const fake = makeFakeElectron(userData);
  const origLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') return fake.electron;
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    require('../src/main/main.js');
  } finally {
    Module._load = origLoad;
  }
  // Wait for whenReady chain (store load, window creation, first scan).
  for (let i = 0; i < 100 && !fake.handlers['app:init']; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(fake.handlers['app:init'], 'IPC registered');
  const ev = { sender: fake.win().webContents };
  const call = (ch, ...args) => fake.handlers[ch](ev, ...args);

  // Unauthorized sender is rejected.
  await assert.rejects(fake.handlers['app:init']({ sender: {} }));

  const init = await call('app:init');
  assert.equal(init.system.locale, 'de-DE');
  assert.equal(init.settings.steamApiKey, '');
  assert.ok(Array.isArray(init.library.games));
  assert.ok(init.presets.length > 5);
  assert.equal(fake.win().url, 'app://dream/index.html');

  // Secrets never go back to the interface in clear text.
  const s1 = await call('settings:set', { steamApiKey: 'ABCDEF123456', showDate: true, secrets: { x: 1 } });
  assert.equal(s1.steamApiKey, '');
  assert.equal(s1.secrets.steamApiKey, '•••• 3456');
  assert.equal(s1.showDate, true);
  const settingsFile = JSON.parse(await new Promise((r) => setTimeout(() => r(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')), 600)));
  assert.equal(settingsFile.steamApiKey, 'ABCDEF123456');

  // Fullscreen side effect.
  await call('settings:set', { startFullscreen: false });
  assert.equal(fake.win().isFullScreen(), false);

  // Unknown game -> error object, not a crash.
  const bad = await call('game:launch', 'steam:999999');
  assert.equal(bad.error, 'notFound');

  // Manual game: pick + save + launch flow.
  const exe = write(path.join(tmpDir(), 'My Game.exe'), 'x');
  fake.setDialog({ canceled: false, filePaths: [exe] });
  const picked = await call('manual:pick');
  assert.equal(picked.name, 'My Game');
  const saved = await call('manual:save', { path: picked.path, name: picked.name, args: '' });
  assert.ok(saved.ok);
  let lib;
  for (let i = 0; i < 100; i++) {
    lib = await call('library:get');
    if (lib.games.some((g) => g.id === saved.id)) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const g = lib.games.find((x) => x.id === saved.id);
  assert.ok(g, 'manual game appears in library');
  assert.equal(g.name, 'My Game');
  const flags = await call('game:setFlags', saved.id, { favorite: true, subscription: 'eaplay', evil: 1 });
  assert.equal(flags.favorite, true);
  assert.equal(flags.subscription, 'eaplay');

  // Export -> import round trip (secrets are not exported).
  const exportPath = path.join(tmpDir(), 'export.json');
  fake.setSave({ canceled: false, filePath: exportPath });
  assert.ok((await call('settings:export')).ok);
  const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  assert.equal(exported.app, 'Dream Launcher');
  assert.equal('steamApiKey' in exported.settings, false);
  assert.equal(exported.overrides[saved.id].favorite, true);
  exported.settings.showClock = false;
  fs.writeFileSync(exportPath, JSON.stringify(exported));
  fake.setDialog({ canceled: false, filePaths: [exportPath] });
  const imported = await call('settings:import');
  assert.ok(imported.ok, JSON.stringify(imported));
  assert.equal(imported.settings.showClock, false);
  assert.equal(imported.settings.secrets.steamApiKey, '•••• 3456', 'key kept after import');
  const badFile = write(path.join(tmpDir(), 'bad.json'), '{"hello":1}');
  fake.setDialog({ canceled: false, filePaths: [badFile] });
  assert.equal((await call('settings:import')).error, 'invalidFile');

  // Protocols: renderer files are served, path traversal is blocked.
  const appProto = fake.protocols.app;
  const ok = await appProto({ url: 'app://dream/img/logo.svg' });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/svg+xml');
  const trav = await appProto({ url: 'app://dream/..%2F..%2Fpackage.json' });
  assert.ok([403, 404].includes(trav.status));
  const trav2 = await appProto({ url: 'app://dream/%2e%2e/main/main.js' });
  assert.ok([403, 404].includes(trav2.status));
  const other = await appProto({ url: 'app://evil/index.html' });
  assert.equal(other.status, 404);
  write(path.join(userData, 'art', 'a.jpg'), 'img');
  const art = await fake.protocols.dl({ url: 'dl://art/a.jpg?v=1' });
  assert.equal(art.status, 200);
  assert.equal(art.headers.get('access-control-allow-origin'), '*');
  const artTrav = await fake.protocols.dl({ url: 'dl://art/..%2Fsettings.json' });
  assert.ok([403, 404].includes(artTrav.status));

  // External links: only https allowed.
  assert.equal((await call('app:openExternal', 'file:///C:/Windows')).error, 'invalid');
  assert.ok((await call('app:openExternal', 'https://steamcommunity.com/dev/apikey')).ok);

  // V2: device info, byte ranges for audio, hub data, logo artwork kind, screenshots, stop tracking.
  assert.equal(typeof init.system.device.handheld, 'boolean');
  assert.equal(typeof (await call('app:device')).handheld, 'boolean');
  const mp3 = await appProto({ url: 'app://dream/audio/memory-loop.mp3', headers: new Headers({ range: 'bytes=100-199' }) });
  assert.equal(mp3.status, 206);
  assert.equal(mp3.headers.get('content-range'), `bytes 100-199/${fs.statSync(path.join(__dirname, '..', 'src', 'renderer', 'audio', 'memory-loop.mp3')).size}`);
  assert.equal((await mp3.arrayBuffer()).byteLength, 100);
  const whole = await appProto({ url: 'app://dream/audio/memory-loop.mp3', headers: new Headers({}) });
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-type'), 'audio/mpeg');
  const past = await appProto({ url: 'app://dream/audio/memory-loop.mp3', headers: new Headers({ range: 'bytes=999999999-' }) });
  assert.equal(past.status, 416);
  const hub = await call('game:hub', saved.id, 'de');
  assert.equal(hub.steam, false);
  assert.equal('screenshots' in hub, false);
  assert.deepEqual(await call('steam:friendsSummary'), {});
  // Online status and the Xbox key test answer (the fake network has no internet: offline).
  const net = await call('net:status');
  assert.equal(typeof net.online, 'boolean');
  assert.ok(net.services && net.services.xbox && net.services.steam);
  const xt = await call('xbox:test');
  assert.ok(xt.error === 'offline' || xt.error === 'noKey');
  await call('settings:set', { onlineMode: 'offline' });
  const forced = await call('net:check');
  assert.equal(forced.online, false);
  assert.equal(forced.reason, 'forced');
  await call('settings:set', { onlineMode: 'auto' });
  // Update check: answers, refuses to install without a download.
  const up = await call('update:status');
  assert.equal(typeof up.status, 'string');
  assert.ok(up.current);
  assert.equal((await call('update:install')).error, 'notReady');
  const upCheck = await call('update:check');
  assert.ok(upCheck.error === 'offline' || upCheck.status);
  // Reset one Options tab only.
  await call('settings:set', { musicVolume: 90, reduceMotion: true });
  const afterReset = await call('settings:resetSection', 'sound');
  assert.equal(afterReset.musicVolume, 35);
  assert.equal(afterReset.reduceMotion, true, 'other tabs untouched');
  assert.equal((await call('settings:resetSection', 'nope')).error, 'invalid');
  assert.equal((await call('game:hub', 'steam:nope')).error, 'notFound');
  assert.equal((await call('art:reset', saved.id, 'logo')).ok, true);
  assert.equal((await call('art:reset', saved.id, 'evil')).error, 'invalid');
  assert.equal((await call('art:apply', saved.id, 'logo', 'file:///x.png')).error, 'invalid');
  assert.deepEqual(await call('game:stopTracking', saved.id), { ok: false });
  assert.equal((await call('shot:showInFolder', 'nope')).error, 'notFound');
  assert.equal((await fake.protocols.dl({ url: 'dl://shot/abcdef' })).status, 404);
  assert.equal((await fake.protocols.dl({ url: 'dl://shot/abcdef?thumb=1&w=640' })).status, 404);
  // Clips: unknown clips and paths outside a clip are refused.
  assert.equal((await call('clip:manifest', 'nope')).error, 'notFound');
  assert.equal((await call('clip:showInFolder', 'nope')).error, 'notFound');
  assert.equal((await fake.protocols.dl({ url: 'dl://clip/nope/0/init-stream0.m4s' })).status, 404);
  assert.equal((await fake.protocols.dl({ url: 'dl://clip/nope/thumb' })).status, 404);
  assert.equal(fake.handlers['profile:pickAvatar'], undefined, 'profile picture handlers removed');

  // Remove the manual game again.
  assert.ok((await call('manual:remove', saved.id)).ok);
});
