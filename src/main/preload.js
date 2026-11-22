'use strict';
/**
 * Bridge between the interface and the main process. Only these functions are exposed
 * (window.dl); the interface has no direct access to Node.js or the file system.
 */
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

const EVENTS = new Set([
  'library:updated', 'game:started', 'game:ended', 'profile:updated', 'app:focus', 'app:fullscreen', 'app:device', 'steam:friends', 'net:status', 'update:status', 'update:announce',
]);

contextBridge.exposeInMainWorld('dl', {
  init: () => invoke('app:init'),

  setSettings: (patch) => invoke('settings:set', patch),
  resetSettings: () => invoke('settings:reset'),
  resetSettingsSection: (section) => invoke('settings:resetSection', section),
  exportSettings: () => invoke('settings:export'),
  importSettings: () => invoke('settings:import'),

  getLibrary: () => invoke('library:get'),
  scanLibrary: () => invoke('library:scan'),

  launch: (id) => invoke('game:launch', id),
  install: (id) => invoke('game:install', id),
  update: (id) => invoke('game:update', id),
  openClient: (id) => invoke('game:openClient', id),
  showFolder: (id) => invoke('game:showFolder', id),
  setGameFlags: (id, patch) => invoke('game:setFlags', id, patch),
  gameDetails: (id, lang) => invoke('game:details', id, lang),
  gameHub: (id, lang) => invoke('game:hub', id, lang),
  stopTracking: (id) => invoke('game:stopTracking', id),
  showScreenshotInFolder: (token) => invoke('shot:showInFolder', token),
  clipManifest: (token) => invoke('clip:manifest', token),
  showClipInFolder: (token) => invoke('clip:showInFolder', token),
  friendsSummary: () => invoke('steam:friendsSummary'),
  netStatus: () => invoke('net:status'),
  netCheck: () => invoke('net:check'),
  testXbox: () => invoke('xbox:test'),
  updateStatus: () => invoke('update:status'),
  updateCheck: () => invoke('update:check'),
  updateDownload: () => invoke('update:download'),
  updateInstall: () => invoke('update:install'),

  pickManualGame: () => invoke('manual:pick'),
  saveManualGame: (entry) => invoke('manual:save', entry),
  removeManualGame: (id) => invoke('manual:remove', id),
  getManualGame: (id) => invoke('manual:get', id),

  pickArtwork: (id, kind) => invoke('art:pickFile', id, kind),
  resetArtwork: (id, kind) => invoke('art:reset', id, kind),
  artworkOptions: (id, kind) => invoke('art:options', id, kind),
  applyArtwork: (id, kind, url) => invoke('art:apply', id, kind, url),
  refreshAllArtwork: () => invoke('art:refreshAll'),
  clearArtworkCache: () => invoke('art:clearCache'),

  pickEmulatorExe: () => invoke('emu:pickExe'),
  pickRomFolder: () => invoke('emu:pickFolder'),
  saveEmulator: (emu) => invoke('emu:save', emu),
  removeEmulator: (id) => invoke('emu:remove', id),

  getProfile: () => invoke('profile:get'),
  getDevice: () => invoke('app:device'),

  pickMusic: () => invoke('music:pick'),
  testSteam: () => invoke('steam:test'),

  openDataFolder: () => invoke('app:openDataFolder'),
  openExternal: (url) => invoke('app:openExternal', url),
  quit: () => invoke('app:quit'),
  minimize: () => invoke('app:minimize'),
  toggleFullscreen: () => invoke('app:toggleFullscreen'),

  on: (event, fn) => {
    if (!EVENTS.has(event) || typeof fn !== 'function') return () => {};
    const handler = (_e, ...args) => fn(...args);
    ipcRenderer.on(event, handler);
    return () => ipcRenderer.removeListener(event, handler);
  },
});
