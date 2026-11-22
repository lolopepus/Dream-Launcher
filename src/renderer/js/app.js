/* Dream Launcher - start-up: loads data, plays the intro and hands over to the dashboard. */
(function () {
  'use strict';
  const DL = (window.DL = window.DL || {});

  const STAGE_W = 1920;
  const STAGE_H = 1080;
  const INTRO_MIN_MS = 3300;
  const INTRO_MAX_WAIT_MS = 7000;
  const UI_SCALE = { normal: 1, large: 1.18, xlarge: 1.35 };

  /** Interface size: the chosen one, or "large" on handhelds when set to Automatic. */
  function uiSizeKey() {
    const s = DL.state.settings || {};
    const pick = s.uiSize || 'auto';
    if (pick !== 'auto') return UI_SCALE[pick] ? pick : 'normal';
    const dev = DL.state.system && DL.state.system.device;
    return dev && dev.handheld ? 'large' : 'normal';
  }

  // The interface is designed for 1920x1080. It is scaled to the window, and the stage grows
  // in width or height for other screen shapes (21:9, 16:10, 4:3) so nothing is letterboxed.
  // Larger interface sizes use a smaller stage, so everything is drawn bigger.
  function scaleStage() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const f = UI_SCALE[uiSizeKey()] || 1;
    const s = Math.min(w / STAGE_W, h / STAGE_H) * f;
    const stage = { w: Math.round(w / s), h: Math.round(h / s), s, size: uiSizeKey() };
    const root = document.documentElement.style;
    root.setProperty('--s', String(s));
    root.setProperty('--sw', `${stage.w}px`);
    root.setProperty('--sh', `${stage.h}px`);
    const prev = DL.stage;
    DL.stage = stage;
    document.body.dataset.uiSize = stage.size;
    if (!prev || prev.w !== stage.w || prev.h !== stage.h) DL.bus.emit('stage', stage);
  }

  function fatal(message) {
    const intro = document.getElementById('intro');
    if (intro) {
      const center = intro.querySelector('.intro-center');
      if (center) center.appendChild(DL.el('p', { class: 'intro-error', text: message }));
      intro.classList.add('play', 'failed');
      DL.state.inputBlockedUntil = 0;
    }
  }

  let resolveLibraryReady;
  const libraryReady = new Promise((r) => { resolveLibraryReady = r; });

  function wireApiEvents() {
    DL.api.on('library:updated', (snapshot) => {
      DL.setLibrary(snapshot);
      if (snapshot && snapshot.lastScanAt) resolveLibraryReady();
      if (DL.hub && DL.hub.retryIfMissing) DL.hub.retryIfMissing();
    });
    DL.api.on('game:started', () => {
      DL.state.gameRunning = true;
      if (DL.state.settings.pauseMusicWhilePlaying) DL.music.pause('game');
      DL.waves.refresh(); // the waves rest while a game runs
    });
    DL.api.on('game:ended', () => {
      DL.state.gameRunning = false;
      DL.waves.refresh();
      DL.music.resume('game');
      DL.actions.hideLaunching();
    });
    DL.api.on('profile:updated', (profile) => {
      if (profile && !profile.error) { DL.state.profile = profile; DL.bus.emit('profile'); }
    });
    DL.api.on('app:device', (device) => {
      if (!device || device.error) return;
      DL.state.system.device = device;
      scaleStage();
      DL.bus.emit('device', device);
    });
    // "Friends who played" for every Steam game at once, so the home screen shows it instantly.
    const loadFriends = () => DL.api.friendsSummary().then((sum) => {
      DL.state.friendsSummary = sum && typeof sum === 'object' && !sum.error ? sum : {};
      for (const f of Object.values(DL.state.friendsSummary)) for (const p of f.people || []) if (p.avatar && /^https:\/\//.test(p.avatar)) { const im = new Image(); im.referrerPolicy = 'no-referrer'; im.src = p.avatar; }
      if (DL.dashboard && DL.dashboard.refreshHero) DL.dashboard.refreshHero();
    }).catch(() => {});
    loadFriends();
    DL.app = { ...(DL.app || {}), loadFriends };
    DL.api.on('net:status', (net) => DL.net.apply(net));
    DL.api.on('update:status', (u) => { DL.state.update = u; DL.bus.emit('update', u); });
    DL.api.on('update:announce', (u) => {
      DL.state.update = u;
      DL.bus.emit('update', u);
      if (u && u.latest) DL.toast({ title: DL.t('update.toastTitle', { v: u.latest.version }), sub: DL.t('update.toastText'), icon: 'download', duration: 7000 });
    });
    DL.api.on('steam:friends', () => { DL.state.details.clear(); loadFriends(); if (DL.hub) { DL.hub.invalidate(); DL.hub.reload(); } });
    DL.api.on('app:focus', (focused) => { if (focused) DL.input.startPolling(); });
  }

  function wireSettings() {
    DL.bus.on('settings', (patch) => {
      if (!patch) return;
      const s = DL.state.settings;
      if ('language' in patch) {
        DL.i18n.set(s.language);
        DL.i18n.apply(document);
        DL.bus.emit('language');
      }
      if (patch.all || 'uiSounds' in patch || 'soundVolume' in patch) DL.sound.applySettings();
      if (patch.all || 'music' in patch || 'musicVolume' in patch || 'musicSpeed' in patch || 'customMusicFile' in patch) DL.music.apply();
      if ('pauseMusicWhilePlaying' in patch && !s.pauseMusicWhilePlaying) DL.music.resume('game');
      if (patch.all || 'uiSize' in patch) scaleStage();
      if (patch.all || 'reduceMotion' in patch) {
        applyMotionClasses();
        DL.waves.refresh();
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) DL.music.pause('hidden'); else DL.music.resume('hidden');
    });
  }

  function applyMotionClasses() {
    document.body.classList.toggle('reduce-motion', !!(DL.state.settings || {}).reduceMotion);
  }

  function globalAction(action) {
    if (action === 'view') { if (!DL.nav.has('search')) DL.search.open(); return; }
    if (action === 'options') { if (!DL.options.isOpen()) DL.options.open(); }
  }

  function buildWordmark(intro) {
    const name = intro.querySelector('.intro-name');
    name.textContent = '';
    [...'DREAM LAUNCHER'].forEach((ch, i) => {
      const span = DL.el('span', { text: ch === ' ' ? ' ' : ch });
      span.style.setProperty('--i', String(i));
      name.appendChild(span);
    });
  }

  function reveal(reduce) {
    DL.waves.setMode('dashboard');
    DL.dashboard.show();
    document.body.classList.add('revealed');
    setTimeout(() => document.body.classList.add('settled'), reduce ? 50 : 1700);
  }

  /**
   * Start-up animation: letterbox bars and darkness lift while the ribbons are drawn in, a light
   * blooms, the logo sharpens with a light sweep and the name rises letter by letter. Then the
   * logo zooms through and the dashboard slides in. Any button or click skips it.
   */
  async function playIntro(hasCachedGames) {
    const intro = document.getElementById('intro');
    const s = DL.state.settings;
    if (!s.playIntro) {
      reveal(true);
      intro.remove();
      DL.state.inputBlockedUntil = Date.now() + 350;
      return;
    }
    buildWordmark(intro);
    DL.waves.setMode('intro');
    await Promise.race([DL.sound.prepare(), DL.sleep(600)]);
    DL.sound.play('intro');
    requestAnimationFrame(() => {
      intro.classList.add('play');
      setTimeout(() => DL.waves.playIntro(), 150);
    });

    let skip;
    const skipped = new Promise((r) => { skip = r; });
    const offInput = DL.bus.on('input', () => skip());
    const onPointer = () => skip();
    window.addEventListener('pointerdown', onPointer, { once: true });

    const ready = hasCachedGames ? Promise.resolve() : Promise.race([libraryReady, DL.sleep(INTRO_MAX_WAIT_MS)]);
    const waitTimer = setTimeout(() => intro.classList.add('waiting'), INTRO_MIN_MS + 400);
    await Promise.race([Promise.all([DL.sleep(INTRO_MIN_MS), ready]), skipped]);
    clearTimeout(waitTimer);
    offInput();
    window.removeEventListener('pointerdown', onPointer);

    intro.classList.add('exit');
    DL.sound.play('whoosh');
    await DL.sleep(s.reduceMotion ? 0 : 260);
    reveal(!!s.reduceMotion);
    await DL.sleep(s.reduceMotion ? 150 : 1100);
    intro.remove();
    // A short pause after the dashboard is in place, so a held or repeated button press from
    // skipping the intro doesn't start a game.
    DL.state.inputBlockedUntil = Date.now() + 300;
  }

  async function boot() {
    scaleStage();
    window.addEventListener('resize', scaleStage);
    DL.waves.init(document.getElementById('waves'));
    if (!DL.api) { fatal('Dream Launcher must be started from its app.'); return; }
    let init;
    try {
      init = await DL.api.init();
    } catch (err) {
      console.error(err);
      fatal('Something went wrong while starting. Please restart Dream Launcher.');
      return;
    }
    DL.state.settings = init.settings;
    DL.state.system = init.system || {};
    DL.state.profile = init.profile || {};
    if (init.net && typeof init.net === 'object') DL.state.net = init.net;
    DL.state.update = init.update || null;
    DL.state.presets = init.presets || [];
    DL.i18n.set(DL.state.settings.language);
    DL.i18n.apply(document);
    applyMotionClasses();
    DL.waves.refresh();
    DL.sound.applySettings();
    scaleStage();

    DL.dashboard.init();
    DL.setLibrary(init.library);
    if (init.library && init.library.lastScanAt) resolveLibraryReady();
    wireApiEvents();
    wireSettings();
    DL.nav.setGlobalHandler(globalAction);
    DL.state.ready = true;
    await playIntro(init.library && init.library.games && init.library.games.length > 0);
    DL.music.apply();
    // Explains the free API keys (Steam, SteamGridDB, Xbox) if a useful one is missing.
    if (DL.keysTip) DL.keysTip.maybeShow();
  }

  DL.app = { uiSizeKey, scaleStage };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
