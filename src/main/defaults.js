'use strict';

const LANGUAGES = ['auto', 'en', 'de', 'pl'];
const SOURCES = ['steam', 'epic', 'gog', 'ubisoft', 'xbox', 'emulators', 'manual'];
const SUBSCRIPTIONS = ['gamepass', 'eaplay', 'ubisoftplus'];

const SETTINGS_VERSION = 3;

const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  // General
  language: 'auto',
  startWithWindows: false,
  startFullscreen: true,
  playIntro: true,
  minimizeOnLaunch: true,
  restoreAfterPlaying: true,
  confirmExit: true,
  // Online features: 'auto' = online when there is internet, 'offline' = never go online.
  onlineMode: 'auto',
  // Look for a newer version on GitHub (at most every 6 hours, only while online).
  checkForUpdates: true,
  // Home & display
  uiSize: 'auto',
  showClock: true,
  clockFormat: 'auto',
  showDate: true,
  showBattery: true,
  showGameInfo: true,
  // Only show playtime the store/emulator really knows (Steam, Cemu, Xbox). Other games show
  // when Dream Launcher last started them ("Last booted") instead.
  onlyKnownPlaytime: true,
  showLogos: true,
  showHeroArt: true,
  showStoreBadges: true,
  showSubscriptionBadges: true,
  homeOrder: 'recent',
  reduceMotion: false,
  // Sound & music
  uiSounds: true,
  soundVolume: 70,
  music: 'builtin',
  musicSpeed: 'slowed',
  musicVolume: 35,
  customMusicFile: '',
  customMusicName: '',
  pauseMusicWhilePlaying: true,
  // Controllers
  buttonGlyphs: 'auto',
  confirmButton: 'auto',
  vibration: true,
  showControllerToast: true,
  // Library
  sources: Object.freeze({ steam: true, epic: true, gog: true, ubisoft: true, xbox: true, emulators: true, manual: true }),
  showUninstalledSteam: true,
  // Xbox PC games from your Xbox history that are not installed (needs the OpenXBL key).
  // Off by default: that history comes from an outside service and is less reliable than Steam's list.
  showUninstalledXbox: false,
  showHiddenGames: false,
  launchGogViaGalaxy: false,
  // Accounts & artwork
  steamApiKey: '',
  steamId: '',
  sgdbApiKey: '',
  xblApiKey: '',
  // Data managed through the importer
  emulators: Object.freeze([]),
  manualGames: Object.freeze([]),
});

const ENUMS = {
  language: LANGUAGES,
  onlineMode: ['auto', 'offline'],
  uiSize: ['auto', 'normal', 'large', 'xlarge'],
  clockFormat: ['auto', '24h', '12h'],
  homeOrder: ['recent', 'mostPlayed', 'favorites', 'alphabetical'],
  music: ['off', 'builtin', 'custom'],
  musicSpeed: ['normal', 'slowed', 'slower'],
  buttonGlyphs: ['auto', 'xbox', 'playstation', 'nintendo'],
  confirmButton: ['auto', 'bottom', 'right'],
};

/** Settings shown on each Options tab (for "Reset this tab"). The chosen music file is kept. */
const SECTION_KEYS = Object.freeze({
  general: ['language', 'startWithWindows', 'startFullscreen', 'playIntro', 'minimizeOnLaunch', 'restoreAfterPlaying', 'confirmExit', 'onlineMode', 'checkForUpdates'],
  display: ['uiSize', 'showClock', 'clockFormat', 'showDate', 'showBattery', 'showGameInfo', 'onlyKnownPlaytime', 'showLogos', 'showHeroArt', 'showStoreBadges', 'showSubscriptionBadges', 'homeOrder', 'reduceMotion'],
  sound: ['uiSounds', 'soundVolume', 'music', 'musicSpeed', 'musicVolume', 'pauseMusicWhilePlaying'],
  controllers: ['buttonGlyphs', 'confirmButton', 'vibration', 'showControllerToast'],
  library: ['sources', 'showUninstalledSteam', 'showUninstalledXbox', 'showHiddenGames', 'launchGogViaGalaxy'],
  accounts: ['steamApiKey', 'steamId', 'sgdbApiKey', 'xblApiKey'],
});

/** Default values for one Options tab, or null for an unknown tab. */
function sectionDefaults(section) {
  const keys = Object.prototype.hasOwnProperty.call(SECTION_KEYS, section) ? SECTION_KEYS[section] : null;
  if (!keys) return null;
  const out = {};
  for (const k of keys) out[k] = k === 'sources' ? { ...DEFAULT_SETTINGS.sources } : DEFAULT_SETTINGS[k];
  return out;
}

const PERCENT_KEYS = ['soundVolume', 'musicVolume'];
const SECRET_KEYS = ['steamApiKey', 'sgdbApiKey', 'xblApiKey'];

function str(v, max = 1000) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function cleanId(v) {
  const s = str(v, 80).replace(/[^a-zA-Z0-9_-]/g, '');
  return s || null;
}

function sanitizeExtensions(v) {
  let list = [];
  if (Array.isArray(v)) list = v;
  else if (typeof v === 'string') list = v.split(/[\s,;]+/);
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const e = raw.trim().toLowerCase().replace(/^\*?\./, '').replace(/[^a-z0-9]/g, '');
    if (e && !out.includes(e)) out.push(e);
    if (out.length >= 30) break;
  }
  return out;
}

function sanitizeEmulator(e) {
  if (!e || typeof e !== 'object') return null;
  const id = cleanId(e.id);
  if (!id) return null;
  return {
    id,
    name: str(e.name, 120),
    preset: str(e.preset, 40) || 'custom',
    exe: str(e.exe, 1024),
    args: str(e.args, 1024),
    romDir: str(e.romDir, 1024),
    extensions: sanitizeExtensions(e.extensions),
    platform: str(e.platform, 80),
  };
}

function sanitizeManualGame(g) {
  if (!g || typeof g !== 'object') return null;
  const id = cleanId(g.id);
  const p = str(g.path, 1024);
  if (!id || !p) return null;
  return { id, name: str(g.name, 200), path: p, args: str(g.args, 1024) };
}

/**
 * Returns a complete, valid settings object. Unknown keys are dropped, wrong types fall
 * back to defaults. Used for loading, updating and importing settings.
 */
function sanitizeSettings(input, base = DEFAULT_SETTINGS) {
  const src = input && typeof input === 'object' ? { ...input } : {};
  // Older name of the built-in music setting.
  if (src.music === 'ambient') src.music = 'builtin';
  const out = {};
  for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) {
    const fallback = Object.prototype.hasOwnProperty.call(base, key) ? base[key] : def;
    const has = Object.prototype.hasOwnProperty.call(src, key);
    const v = has ? src[key] : fallback;
    if (key === 'sources') {
      const s = v && typeof v === 'object' ? v : {};
      const fb = fallback && typeof fallback === 'object' ? fallback : def;
      out.sources = {};
      for (const name of SOURCES) out.sources[name] = typeof s[name] === 'boolean' ? s[name] : (typeof fb[name] === 'boolean' ? fb[name] : true);
      continue;
    }
    if (key === 'emulators') {
      const list = Array.isArray(v) ? v : (Array.isArray(fallback) ? fallback : []);
      out.emulators = list.map(sanitizeEmulator).filter(Boolean).slice(0, 50);
      continue;
    }
    if (key === 'manualGames') {
      const list = Array.isArray(v) ? v : (Array.isArray(fallback) ? fallback : []);
      out.manualGames = list.map(sanitizeManualGame).filter(Boolean).slice(0, 2000);
      continue;
    }
    if (ENUMS[key]) {
      out[key] = ENUMS[key].includes(v) ? v : (ENUMS[key].includes(fallback) ? fallback : def);
      continue;
    }
    if (PERCENT_KEYS.includes(key)) {
      const n = Number(v);
      out[key] = Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : fallback;
      continue;
    }
    if (typeof def === 'boolean') { out[key] = typeof v === 'boolean' ? v : fallback; continue; }
    if (typeof def === 'number') { out[key] = Number.isFinite(Number(v)) ? Number(v) : fallback; continue; }
    if (typeof def === 'string') {
      let s = typeof v === 'string' ? v : fallback;
      s = String(s).slice(0, 2000);
      if (key === 'steamId') s = s.replace(/[^0-9]/g, '').slice(0, 20);
      // Keys are letters and digits; OpenXBL keys may also contain dashes.
      if (SECRET_KEYS.includes(key)) s = s.trim().replace(key === 'xblApiKey' ? /[^A-Za-z0-9._-]/g : /[^A-Za-z0-9]/g, '').slice(0, 128);
      out[key] = s;
      continue;
    }
    out[key] = fallback;
  }
  out.version = SETTINGS_VERSION;
  return out;
}

/**
 * One-time changes for settings saved by an older version (before sanitizing).
 * Returns { settings, changed }.
 *  v1 -> v2: the date is shown by default, and uninstalled Steam games are listed by default
 *            (they now appear only in the library, no longer on the home screen).
 *  v2 -> v3: uninstalled Xbox games are off by default (Xbox history is less reliable).
 */
function migrateSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { settings: raw, changed: false };
  const from = Number(raw.version) || 1;
  if (from >= SETTINGS_VERSION) return { settings: raw, changed: false };
  const next = { ...raw };
  if (from < 2) {
    next.showDate = true;
    next.showUninstalledSteam = true;
    if (next.music === 'ambient' || next.music === undefined) next.music = 'builtin';
    delete next.showGreeting;
    delete next.profileName;
    delete next.profileAvatar;
  }
  if (from < 3) next.showUninstalledXbox = false;
  next.version = SETTINGS_VERSION;
  return { settings: next, changed: true };
}

function sanitizeOverride(o) {
  if (!o || typeof o !== 'object') return null;
  const out = {};
  if (o.hidden === true) out.hidden = true;
  if (o.favorite === true) out.favorite = true;
  if (typeof o.subscription === 'string' && SUBSCRIPTIONS.includes(o.subscription)) out.subscription = o.subscription;
  if (o.customArt && typeof o.customArt === 'object') {
    const art = {};
    for (const k of ['cover', 'hero', 'logo']) {
      const f = o.customArt[k];
      if (typeof f === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(f)) art[k] = f;
    }
    if (Object.keys(art).length) out.customArt = art;
  }
  return Object.keys(out).length ? out : null;
}

function sanitizeOverrides(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [id, o] of Object.entries(input)) {
    if (typeof id !== 'string' || id.length > 300) continue;
    const clean = sanitizeOverride(o);
    if (clean) out[id] = clean;
  }
  return out;
}

module.exports = {
  DEFAULT_SETTINGS, SETTINGS_VERSION, SECTION_KEYS, sectionDefaults, LANGUAGES, SOURCES, SUBSCRIPTIONS, ENUMS, SECRET_KEYS,
  sanitizeSettings, migrateSettings, sanitizeOverride, sanitizeOverrides, sanitizeExtensions,
};
