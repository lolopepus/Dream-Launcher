/*
 * Browser preview: a fake window.dl API with sample games, so the interface can be developed and
 * tested in a normal browser (no Windows/Electron needed). Not used by the real app.
 * Start it with:  node dev/preview.js   then open http://localhost:5173
 */
(function () {
  'use strict';
  if (window.dl) return;

  const listeners = {};
  const emit = (ev, ...args) => (listeners[ev] || []).forEach((fn) => fn(...args));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function art(seed, w, h) {
    const hue = (seed * 47) % 360;
    const hue2 = (hue + 50) % 360;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice">
      <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue},60%,22%)"/><stop offset="1" stop-color="hsl(${hue2},70%,55%)"/></linearGradient></defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/>
      <circle cx="${w * 0.68}" cy="${h * 0.42}" r="${Math.min(w, h) * 0.28}" fill="hsl(${(hue + 180) % 360},80%,70%)" opacity=".55"/>
      <path d="M0 ${h * 0.72} L${w * 0.2} ${h * 0.55} L${w * 0.42} ${h * 0.68} L${w * 0.66} ${h * 0.48} L${w} ${h * 0.7} V${h} H0Z" fill="hsl(${hue},50%,12%)" opacity=".9"/>
    </svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  /** A transparent "logo" image with the game's name (tests trimming and dark-logo detection). */
  function logo(name, seed, dark) {
    const hue = (seed * 47 + 20) % 360;
    const fill = dark ? '#151520' : `hsl(${hue},85%,72%)`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="500" viewBox="0 0 1200 500">
      <text x="600" y="300" text-anchor="middle" font-family="Georgia,serif" font-weight="700" font-size="${name.length > 12 ? 92 : 130}" fill="${fill}" stroke="#ffffff" stroke-opacity="${dark ? 0 : 0.85}" stroke-width="4">${name.toUpperCase()}</text>
    </svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
  function icon(seed, locked) {
    const hue = (seed * 67) % 360;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="hsl(${hue},${locked ? 5 : 70}%,${locked ? 30 : 45}%)"/><path d="M32 12l6 13 14 2-10 10 2 14-12-7-12 7 2-14-10-10 14-2z" fill="hsl(${hue},${locked ? 0 : 90}%,${locked ? 55 : 80}%)"/></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
  function face(seed, letter) {
    const hue = (seed * 83) % 360;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="hsl(${hue},60%,50%)"/><text x="32" y="43" text-anchor="middle" font-family="Arial" font-weight="700" font-size="30" fill="#fff">${letter}</text></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  const now = Date.now();
  const DAY = 86400000;
  const SAMPLE = [
    ['Ember Hollow', 'steam', 5190, now - 3600e3, { status: 'installed', size: 48.2e9 }],
    ['Neon Drift 2088', 'xbox', 920, now - DAY, { subscription: 'gamepass', known: 'xbox', xboxTitleId: '1828326430', xboxAch: { unlocked: 12, total: 30 } }],
    ['Tidebreaker', 'gog', 2310, now - 3 * DAY, { status: 'updateRequired' }],
    ['Skyward Atlas', 'epic', 610, now - 6 * DAY, { darkLogo: true }],
    ['Frostline', 'steam', 0, 0, { status: 'installing', progress: 0.64, subscription: 'eaplay' }],
    ['Mosswood', 'ubisoft', 1280, now - 20 * DAY, { subscription: 'ubisoftplus' }],
    ['Iron Comet', 'emulators', 400, now - 2 * DAY, { platform: 'Wii U', emu: 'Cemu', known: 'cemu', dayOnly: true }],
    ['Lantern Keep', 'steam', 75, now - 60 * DAY, { noLogo: true }],
    ['Paper Planets', 'manual', 30, now - 90 * DAY],
    ['Harbor Lights', 'steam', 0, 0, { status: 'notInstalled' }],
    ['Quiet Orbit', 'epic', 0, 0],
    ['Cinder Road', 'gog', 1500, now - 200 * DAY],
    ['Forza Horizon 5', 'xbox', 1500, now - 50 * DAY, { status: 'notInstalled', known: 'xbox', xboxTitleId: '1551118141', xboxAch: { unlocked: 40, total: 200 } }],
  ];

  const labels = { steam: 'Steam', epic: 'Epic Games', gog: 'GOG', ubisoft: 'Ubisoft Connect', xbox: 'Xbox', emulators: 'PCSX2', manual: 'PC' };

  function makeGame([name, source, minutes, last, extra = {}], i) {
    const status = extra.status || 'installed';
    const installed = status !== 'notInstalled' && status !== 'installing';
    return {
      id: `${source}:${i}`,
      sourceId: String(1000 + i),
      source,
      sourceLabel: extra.emu || labels[source],
      name,
      sortName: name.toLowerCase(),
      installed,
      status,
      progress: extra.progress ?? null,
      sizeBytes: installed ? (extra.size || [12e9, 84e9, 3.2e9, 41e9, 0.9e9, 66e9, 7.5e9, 23e9][i % 8]) : 0,
      playtimeMinutes: minutes,
      lastPlayed: last,
      // Steam / Cemu / Xbox know the real playtime; others only what was counted here.
      playtimeKnown: source === 'steam' || !!extra.known,
      playtimeSource: source === 'steam' ? 'steam' : (extra.known || (minutes > 0 ? 'tracked' : null)),
      lastBooted: source === 'steam' || extra.known ? 0 : last,
      lastPlayedDayOnly: !!extra.dayOnly,
      firstPlayed: extra.known === 'cemu' ? now - 300 * DAY : 0,
      xboxTitleId: extra.xboxTitleId || '',
      xboxAchievements: extra.xboxAch || null,
      platform: extra.platform || '',
      installPath: installed ? `D:\\Games\\${name}` : '',
      favorite: i === 2,
      hidden: false,
      subscription: extra.subscription || null,
      art: extra.art || { cover: art(i + 1, 600, 900), hero: art(i + 1, 1920, 620), logo: extra.noLogo ? null : logo(name, i + 1, !!extra.darkLogo), coverFit: 'cover' },
      actions: {
        play: installed && status !== 'missing',
        install: status === 'notInstalled',
        update: status === 'updateRequired',
        checkUpdates: source === 'xbox',
        openClient: ['steam', 'epic', 'gog', 'ubisoft'].includes(source),
        showFolder: installed,
        editable: source === 'manual',
        removable: source === 'manual',
      },
    };
  }

  const custom = Array.isArray(window.DL_MOCK_GAMES) ? window.DL_MOCK_GAMES : null;
  let games = (custom || SAMPLE).map((g, i) => (Array.isArray(g) ? makeGame(g, i) : makeGame([g.name, g.source, g.minutes || 0, g.lastPlayed || 0, g], i)));
  if (window.DL_MOCK_EMPTY) games = [];

  let settings = {
    version: 1, language: window.DL_MOCK_LANG || 'auto', startWithWindows: false, startFullscreen: true, playIntro: true,
    minimizeOnLaunch: true, restoreAfterPlaying: true, confirmExit: true, onlineMode: window.DL_MOCK_OFFLINE === 'forced' ? 'offline' : 'auto', onlyKnownPlaytime: true, uiSize: window.DL_MOCK_UISIZE || 'auto', showClock: true, clockFormat: 'auto',
    showDate: true, showBattery: true, showGameInfo: true, showLogos: true, showHeroArt: true, showStoreBadges: true,
    showSubscriptionBadges: true, homeOrder: 'recent', reduceMotion: !!window.DL_MOCK_REDUCE, uiSounds: true, soundVolume: 70,
    music: window.DL_MOCK_MUSIC || 'builtin', musicSpeed: 'slowed', musicVolume: 35, customMusicFile: '', customMusicName: '', pauseMusicWhilePlaying: true,
    buttonGlyphs: 'auto', confirmButton: 'auto', vibration: true, showControllerToast: true,
    sources: { steam: true, epic: true, gog: true, ubisoft: true, xbox: true, emulators: true, manual: true },
    showUninstalledSteam: true, showHiddenGames: false, launchGogViaGalaxy: false, steamApiKey: '', steamId: '',
    sgdbApiKey: '', emulators: [{ id: 'e1', name: 'PCSX2', preset: 'pcsx2', exe: 'C:\\Emulators\\PCSX2\\pcsx2-qt.exe', args: '-fullscreen -batch -- "{rom}"', romDir: 'D:\\ROMs\\PS2', extensions: ['iso', 'chd'], platform: 'PlayStation 2' }],
    xblApiKey: '', manualGames: [], secrets: { steamApiKey: '•••• 1A2B', sgdbApiKey: '', xblApiKey: window.DL_MOCK_NOXBOX ? '' : '•••• 9f3c' },
  };
  let profile = { steamName: 'Lolo', steamId: '76561198000000001' };
  const device = window.DL_MOCK_HANDHELD
    ? { handheld: true, reason: 'model', name: 'ASUSTeK COMPUTER INC. ROG Xbox Ally RC73YA', screenInches: 7 }
    : { handheld: false, reason: null, name: 'Micro-Star International Co., Ltd. MS-7D25', screenInches: 27 };

  const sources = () => {
    const out = {};
    for (const s of ['steam', 'epic', 'gog', 'ubisoft', 'xbox', 'emulators', 'manual']) {
      out[s] = { enabled: settings.sources[s], available: true, count: games.filter((g) => g.source === s).length };
    }
    out.emulators.details = { e1: { count: games.filter((g) => g.source === 'emulators').length, error: null } };
    return out;
  };
  let lastScanAt = window.DL_MOCK_SLOW_SCAN ? 0 : Date.now();
  const snapshot = () => ({ games: games.filter((g) => settings.sources[g.source]), sources: sources(), scanning: false, lastScanAt, hasBattery: true });
  const push = () => emit('library:updated', snapshot());

  if (window.DL_MOCK_SLOW_SCAN) setTimeout(() => { lastScanAt = Date.now(); push(); }, typeof window.DL_MOCK_SLOW_SCAN === 'number' ? window.DL_MOCK_SLOW_SCAN : 5500);

  const ok = async () => ({ ok: true });
  let net = {
    online: !window.DL_MOCK_OFFLINE,
    mode: window.DL_MOCK_OFFLINE === 'forced' ? 'offline' : 'auto',
    reason: window.DL_MOCK_OFFLINE ? (window.DL_MOCK_OFFLINE === 'forced' ? 'forced' : 'noInternet') : null,
    services: { steam: { key: true, account: true }, xbox: { key: !window.DL_MOCK_NOXBOX, account: window.DL_MOCK_NOXBOX ? null : { gamertag: 'LoloPlays', gamerscore: 4820 } }, sgdb: { key: false } },
  };
  const isOffline = () => !net.online;
  window.dl = {
    init: async () => ({
      settings: { ...settings },
      library: snapshot(),
      profile,
      net: { ...net },
      presets: [
        { id: 'retroarch', name: 'RetroArch', platform: 'RetroArch', args: '-f -L "cores\\snes9x_libretro.dll" "{rom}"', extensions: ['zip', 'sfc'] },
        { id: 'dolphin', name: 'Dolphin', platform: 'GameCube / Wii', args: '-b -e "{rom}"', extensions: ['iso', 'rvz'] },
        { id: 'pcsx2', name: 'PCSX2', platform: 'PlayStation 2', args: '-fullscreen -batch -- "{rom}"', extensions: ['iso', 'chd'] },
        { id: 'custom', name: 'Custom', platform: '', args: '"{rom}"', extensions: [] },
      ],
      system: { platform: 'win32', version: '2.0.0', electron: '45.3.3', chrome: '156', locale: window.DL_MOCK_LOCALE || 'en-US', languages: [window.DL_MOCK_LOCALE || 'en-US'], fullscreen: true, device },
    }),
    setSettings: async (patch) => {
      const clean = { ...patch };
      delete clean.secrets;
      for (const k of ['steamApiKey', 'sgdbApiKey']) if (k in clean) { settings.secrets[k] = clean[k] ? `•••• ${clean[k].slice(-4)}` : ''; delete clean[k]; }
      settings = { ...settings, ...clean, sources: { ...settings.sources, ...(clean.sources || {}) } };
      if (patch.sources) setTimeout(push, 200);
      if ('onlineMode' in clean) {
        const off = clean.onlineMode === 'offline';
        net = { ...net, online: !off, mode: off ? 'offline' : 'auto', reason: off ? 'forced' : null };
        setTimeout(() => emit('net:status', { ...net }), 120);
      }
      return { ...settings };
    },
    resetSettings: async () => ({ ...settings }),
    resetSettingsSection: async (section) => {
      const d = { display: { uiSize: 'auto', showClock: true, clockFormat: 'auto', showDate: true, showBattery: true, showGameInfo: true, showLogos: true, showHeroArt: true, showStoreBadges: true, showSubscriptionBadges: true, homeOrder: 'recent', reduceMotion: false },
        sound: { uiSounds: true, soundVolume: 70, music: 'builtin', musicSpeed: 'slowed', musicVolume: 35, pauseMusicWhilePlaying: true } }[section] || {};
      Object.assign(settings, d);
      return { ...settings };
    },
    exportSettings: async () => ({ ok: true, path: 'C:\\Users\\Lolo\\Documents\\dream-launcher-settings.json' }),
    importSettings: async () => ({ canceled: true }),
    getLibrary: async () => snapshot(),
    scanLibrary: async () => { await wait(600); return snapshot(); },
    launch: async (id) => {
      const g = games.find((x) => x.id === id);
      await wait(300);
      if (!g) return { error: 'notFound' };
      setTimeout(() => { g.status = 'running'; push(); emit('game:started', id); }, 600);
      g._endTimer = setTimeout(() => { g.status = 'installed'; g.lastPlayed = Date.now(); push(); emit('game:ended', id); }, window.DL_MOCK_RUN_MS || 6000);
      return { ok: true };
    },
    stopTracking: async (id) => {
      const g = games.find((x) => x.id === id);
      if (!g || g.status !== 'running') return { ok: false };
      clearTimeout(g._endTimer);
      g.status = 'installed';
      g.lastPlayed = Date.now();
      setTimeout(() => { push(); emit('game:ended', id); }, 50);
      return { ok: true };
    },
    install: ok, update: ok, openClient: ok, showFolder: ok,
    setGameFlags: async (id, patch) => {
      const g = games.find((x) => x.id === id);
      Object.assign(g, patch);
      setTimeout(push, 50);
      return { ...g };
    },
    gameHub: async (id) => {
      await wait(window.DL_MOCK_HUB_DELAY ?? 350);
      const g = games.find((x) => x.id === id);
      if (!g) return { error: 'notFound' };
      const i = games.indexOf(g);
      if (g.source === 'xbox') {
        if (isOffline()) return { xbox: true, offline: true };
        if (window.DL_MOCK_NOXBOX) return { xbox: true, needsXboxKey: true };
        const xn = ['Night Runner', 'Chrome Heart', 'First Lap', 'Neon Sign', 'Overdrive', 'Skyline', 'Photo Finish', 'Underpass'];
        const xi = xn.map((n, k) => ({ id: `X${k}`, name: n, desc: `Win race ${k + 1} in ${g.name}.`, icon: icon(k + 3, k >= 5), hidden: false, achieved: k < 5, unlockTime: k < 5 ? now - k * 4 * DAY : 0, percent: Math.round((48 - k * 5) * 10) / 10, gamerscore: [10, 20, 15, 30, 50, 25, 40, 60][k] }));
        return { xbox: true, achievements: { unlocked: 5, total: xi.length, gamerscore: 125, gamerscoreTotal: 250, items: xi }, friends: { list: [
          { id: '2533274800000001', name: 'RacerMika', avatar: face(7, 'R'), minutes: 840, minutes2w: 0, lastPlayed: now - 5 * 3600e3, playingNow: true, achievements: { unlocked: 20, total: 30 }, profileUrl: 'https://account.xbox.com/profile?gamertag=RacerMika' },
          { id: '2533274800000002', name: 'Noa Drift', avatar: face(8, 'N'), minutes: 300, minutes2w: 0, lastPlayed: now - 4 * DAY, playingNow: false, achievements: { unlocked: 8, total: 30 } },
          { id: '2533274800000003', name: 'Kaito', avatar: '', minutes: 45, minutes2w: 0, lastPlayed: 0, playingNow: false, achievements: null },
        ] } };
      }
      if (g.source !== 'steam') return { steam: false };
      const shots = Array.from({ length: i % 3 === 2 ? 0 : 14 }, (_, k) => {
        const url = art(i * 7 + k + 2, 1920, 1080);
        return { id: `shot-${i}-${k}`, full: url, thumb: url, time: now - k * 3.7 * 3600e3 };
      });
      if (isOffline()) return { steam: true, offline: true, screenshots: shots };
      if (window.DL_MOCK_NOKEY) return { steam: true, needsKey: true, screenshots: shots };
      const names = ['First Light', 'Ember Walker', 'Hollow Heart', 'Night Owl', 'Collector', 'Speed Runner', 'No Damage', 'Treasure Hunter', 'Secret Path', 'Master of Embers', 'Explorer', 'Lore Keeper', 'Perfectionist', 'Beast Tamer', 'Old Friend', 'Final Ember'];
      const items = names.map((n, k) => ({
        id: `A${k}`, name: n, desc: k === 12 ? '' : `Complete challenge number ${k + 1} in ${g.name}.`,
        icon: icon(k + i, k >= 9), hidden: k === 12, achieved: k < 9,
        unlockTime: k < 9 ? now - k * 2.3 * DAY : 0, percent: Math.round((60 - k * 3.4) * 10) / 10,
      }));
      const friends = [
        { id: '76561198000000001', name: 'Sam', avatar: face(1, 'S'), minutes: 3460, minutes2w: 410, lastPlayed: now - 3600e3, playingNow: true, inGame: true, online: true, state: 1, achievements: { unlocked: 14, total: 16, firstUnlock: now - 410 * DAY } },
        { id: '76561198000000002', name: 'Jo', avatar: face(2, 'J'), minutes: 1220, minutes2w: 0, lastPlayed: now - 9 * DAY, playingNow: false, otherGame: 'Hollow Drift', inGame: true, online: true, state: 1, achievements: { unlocked: 7, total: 16, firstUnlock: now - 95 * DAY } },
        { id: '76561198000000003', name: 'Lea', avatar: face(3, 'L'), minutes: 640, minutes2w: 95, lastPlayed: 0, playingNow: false, inGame: false, online: true, state: 3, achievements: { unlocked: 5, total: 16, firstUnlock: now - 20 * DAY, lastUnlock: now - 3 * DAY } },
        { id: '76561198000000004', name: 'Mika', avatar: '', minutes: 75, minutes2w: 0, lastPlayed: now - 40 * DAY, playingNow: false, inGame: false, online: false, state: 0, lastOnline: now - 26 * 3600e3, achievements: null },
        { id: '76561198000000005', name: 'Noah', avatar: face(5, 'N'), minutes: 30, minutes2w: 0, lastPlayed: now - 120 * DAY, playingNow: false, inGame: false, online: false, state: 0, lastOnline: now - 5 * DAY, achievements: { unlocked: 1, total: 16, firstUnlock: now - 130 * DAY } },
        { id: '76561198000000006', name: 'Ava', avatar: face(6, 'A'), minutes: 12, minutes2w: 0, lastPlayed: 0, playingNow: false, inGame: false, online: false, state: 0, lastOnline: 0, achievements: null },
      ];
      return { steam: true, achievements: { unlocked: 9, total: items.length, items }, friends: { list: friends }, screenshots: shots };
    },
    showScreenshotInFolder: ok,
    netStatus: async () => ({ ...net }),
    netCheck: async () => { await wait(500); return { ...net }; },
    testXbox: async () => (isOffline() ? { error: 'offline' } : { ok: true, name: 'LoloPlays', gamerscore: 4820 }),
    friendsSummary: async () => {
      await wait(30);
      if (isOffline()) return {};
      const out = {};
      out['xbox:1828326430'] = { count: 3, people: [{ name: 'RacerMika', avatar: face(7, 'R') }, { name: 'Noa Drift', avatar: face(8, 'N') }, { name: 'Kaito', avatar: '' }] };
      games.filter((g) => g.source === 'steam').forEach((g, k) => { out[String(g.sourceId)] = { count: 2 + (k % 4), people: [{ name: 'Sam', avatar: face(1, 'S') }, { name: 'Jo', avatar: face(2, 'J') }, { name: 'Lea', avatar: face(3, 'L') }] }; });
      return out;
    },
    getDevice: async () => device,
    gameDetails: async (id) => {
      await wait(150);
      const g = games.find((x) => x.id === id);
      if (isOffline()) return { achievements: null, friends: null, offline: true };
      if (!g || g.source !== 'steam') return { achievements: null, friends: null };
      return { achievements: { unlocked: 38, total: 57 }, friends: null };
    },
    pickManualGame: async () => ({ canceled: true }),
    saveManualGame: ok, removeManualGame: ok, getManualGame: async () => null,
    pickArtwork: async () => ({ canceled: true }), resetArtwork: ok,
    artworkOptions: async (id, kind) => {
      await wait(400);
      if (!window.DL_MOCK_SGDB) return { needsKey: true, items: [] };
      const dims = { cover: [600, 900], hero: [1920, 620], logo: [800, 300] }[kind] || [600, 900];
      const items = Array.from({ length: 14 }, (_, i) => ({ id: i, url: `https://example.invalid/${kind}/${i}.png`, thumb: art(i + 3, dims[0], dims[1]), width: dims[0], height: dims[1] }));
      return { items };
    },
    applyArtwork: ok, refreshAllArtwork: ok, clearArtworkCache: ok,
    pickEmulatorExe: async () => ({ canceled: true }), pickRomFolder: async () => ({ canceled: true }),
    saveEmulator: async () => ({ ok: true, settings: { ...settings } }), removeEmulator: async () => ({ ok: true, settings: { ...settings } }),
    getProfile: async () => profile,
    pickMusic: async () => ({ canceled: true }),
    testSteam: async () => ({ ok: true, name: 'Lolo' }),
    openDataFolder: ok, openExternal: ok,
    quit: async () => { document.body.style.opacity = '0.3'; return { ok: true }; },
    minimize: ok, toggleFullscreen: async () => ({ fullscreen: true }),
    on: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); return () => {}; },
  };
})();
