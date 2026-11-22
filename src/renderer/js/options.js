/* Dream Launcher - Options. */
(function () {
  'use strict';
  const DL = (window.DL = window.DL || {});
  const { el, ui } = DL;

  DL.icons.speaker = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.5L12 5v14l-4.5-4.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>';
  DL.icons.key = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2 2M14 9l2 2"/></svg>';
  DL.icons.display = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2.5"/><path d="M9 20h6M12 16v4"/></svg>';
  DL.icons.data = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></svg>';

  const SECTIONS = [
    { id: 'general', icon: 'options' },
    { id: 'display', icon: 'display' },
    { id: 'sound', icon: 'speaker' },
    { id: 'controllers', icon: 'controller' },
    { id: 'library', icon: 'library' },
    { id: 'accounts', icon: 'key' },
    { id: 'data', icon: 'data' },
    { id: 'about', icon: 'info' },
  ];

  const S = () => DL.state.settings;
  const set = (patch) => DL.saveSettings(patch);
  const t = (k, p) => DL.t(k, p);

  function sourceDesc(id) {
    const st = DL.state.sources[id];
    if (!S().sources[id]) return t('options.sourceOff');
    if (!st) return '';
    if (st.error) return t('options.sourceError');
    if (id === 'emulators') return t('options.sourceEmulators', { n: st.count, count: st.count });
    if (id === 'manual') return t('home.gamesCount', { n: st.count, count: st.count });
    if (!st.available && !st.count) return t('options.sourceMissing');
    return t('home.gamesCount', { n: st.count, count: st.count });
  }

  const BUILDERS = {
    general() {
      return [
        ui.choiceRow({
          label: t('options.language'), list: true,
          options: () => [{ value: 'auto', label: t('options.languageAuto') }, ...DL.i18n.supported.map((l) => ({ value: l, label: DL.i18n.names[l] }))],
          get: () => S().language, set: (v) => set({ language: v }),
        }),
        ui.toggleRow({ label: t('options.startWithWindows'), desc: t('options.startWithWindowsDesc'), get: () => S().startWithWindows, set: (v) => set({ startWithWindows: v }) }),
        ui.toggleRow({ label: t('options.startFullscreen'), desc: t('options.startFullscreenDesc'), get: () => S().startFullscreen, set: (v) => set({ startFullscreen: v }) }),
        ui.toggleRow({ label: t('options.playIntro'), get: () => S().playIntro, set: (v) => set({ playIntro: v }) }),
        ui.toggleRow({ label: t('options.minimizeOnLaunch'), get: () => S().minimizeOnLaunch, set: (v) => set({ minimizeOnLaunch: v }) }),
        ui.toggleRow({ label: t('options.restoreAfterPlaying'), desc: t('options.restoreAfterPlayingDesc'), get: () => S().restoreAfterPlaying, set: (v) => set({ restoreAfterPlaying: v }) }),
        ui.toggleRow({ label: t('options.confirmExit'), get: () => S().confirmExit, set: (v) => set({ confirmExit: v }) }),
        ui.toggleRow({ label: t('net.offlineMode'), desc: t('net.offlineModeDesc'), get: () => S().onlineMode === 'offline', set: (v) => set({ onlineMode: v ? 'offline' : 'auto' }) }),
        ui.actionRow({ label: t('options.quit'), icon: 'quit', danger: true, onClick: () => DL.api.quit() }),
      ];
    },
    display() {
      const dev = DL.state.system.device || {};
      const autoLabel = () => t(dev.handheld ? 'options.uiSizeAutoHandheld' : 'options.uiSizeAutoPc');
      const rows = [
        ui.sectionTitle(t('options.interface')),
        ui.choiceRow({
          label: t('options.uiSize'), desc: t(dev.handheld ? 'options.uiSizeDescHandheld' : 'options.uiSizeDesc', { device: dev.name || '' }), list: true,
          options: () => [
            { value: 'auto', label: autoLabel() },
            { value: 'normal', label: t('options.uiSizeNormal') },
            { value: 'large', label: t('options.uiSizeLarge') },
            { value: 'xlarge', label: t('options.uiSizeXLarge') },
          ],
          get: () => S().uiSize, set: (v) => set({ uiSize: v }),
        }),
        ui.sectionTitle(t('options.topBar')),
        ui.toggleRow({ label: t('options.showClock'), get: () => S().showClock, set: (v) => set({ showClock: v }) }),
        ui.choiceRow({
          label: t('options.clockFormat'),
          options: [{ value: 'auto', label: t('options.clockAuto') }, { value: '24h', label: t('options.clock24') }, { value: '12h', label: t('options.clock12') }],
          get: () => S().clockFormat, set: (v) => set({ clockFormat: v }),
        }),
        ui.toggleRow({ label: t('options.showDate'), get: () => S().showDate, set: (v) => set({ showDate: v }) }),
      ];
      if (DL.state.hasBattery) rows.push(ui.toggleRow({ label: t('options.showBattery'), get: () => S().showBattery, set: (v) => set({ showBattery: v }) }));
      rows.push(
        ui.sectionTitle(t('options.home')),
        ui.toggleRow({ label: t('options.showGameInfo'), desc: t('options.showGameInfoDesc'), get: () => S().showGameInfo, set: (v) => set({ showGameInfo: v }) }),
        ui.toggleRow({ label: t('options.onlyKnownPlaytime'), desc: t('options.onlyKnownPlaytimeDesc'), get: () => S().onlyKnownPlaytime, set: (v) => set({ onlyKnownPlaytime: v }) }),
        ui.toggleRow({ label: t('options.showLogos'), desc: t('options.showLogosDesc'), get: () => S().showLogos, set: (v) => set({ showLogos: v }) }),
        ui.toggleRow({ label: t('options.showHeroArt'), get: () => S().showHeroArt, set: (v) => set({ showHeroArt: v }) }),
        ui.toggleRow({ label: t('options.showStoreBadges'), desc: t('options.showStoreBadgesDesc'), get: () => S().showStoreBadges, set: (v) => set({ showStoreBadges: v }) }),
        ui.toggleRow({ label: t('options.showSubscriptionBadges'), get: () => S().showSubscriptionBadges, set: (v) => set({ showSubscriptionBadges: v }) }),
        ui.choiceRow({
          label: t('options.homeOrder'), list: true,
          options: () => ['recent', 'mostPlayed', 'favorites', 'alphabetical'].map((v) => ({ value: v, label: t(`options.order.${v}`) })),
          get: () => S().homeOrder, set: (v) => set({ homeOrder: v }),
        }),
        ui.toggleRow({ label: t('options.reduceMotion'), desc: t('options.reduceMotionDesc'), get: () => S().reduceMotion, set: (v) => set({ reduceMotion: v }) }),
      );
      return rows;
    },
    sound() {
      const musicFile = ui.actionRow({
        label: t('options.chooseMusic'), value: S().customMusicName || t('options.noFile'), icon: 'folder',
        onClick: async (row) => {
          const res = await DL.api.pickMusic();
          if (res && res.settings) {
            DL.state.settings = res.settings;
            DL.bus.emit('settings', { music: 'custom' });
            row._dlSetValue(res.settings.customMusicName);
          } else if (res && res.error) DL.showError(res);
        },
      });
      return [
        ui.toggleRow({ label: t('options.uiSounds'), get: () => S().uiSounds, set: (v) => set({ uiSounds: v }) }),
        ui.sliderRow({ label: t('options.soundVolume'), get: () => S().soundVolume, set: (v) => { set({ soundVolume: v }); setTimeout(() => DL.sound.play('select'), 30); } }),
        ui.sectionTitle(t('options.music')),
        ui.choiceRow({
          label: t('options.backgroundMusic'),
          options: () => [
            { value: 'off', label: t('options.musicOff') },
            { value: 'builtin', label: t('options.musicBuiltin') },
            ...(S().customMusicFile ? [{ value: 'custom', label: t('options.musicCustom') }] : []),
          ],
          get: () => S().music, set: (v) => set({ music: v }),
        }),
        ui.choiceRow({
          label: t('options.musicSpeed'), desc: t('options.musicSpeedDesc'),
          options: [
            { value: 'normal', label: t('options.speedNormal') },
            { value: 'slowed', label: t('options.speedSlowed') },
            { value: 'slower', label: t('options.speedSlower') },
          ],
          get: () => S().musicSpeed, set: (v) => set({ musicSpeed: v }),
        }),
        ui.sliderRow({ label: t('options.musicVolume'), get: () => S().musicVolume, set: (v) => set({ musicVolume: v }) }),
        musicFile,
        ui.toggleRow({ label: t('options.pauseMusic'), get: () => S().pauseMusicWhilePlaying, set: (v) => set({ pauseMusicWhilePlaying: v }) }),
      ];
    },
    controllers() {
      const rows = [
        ui.choiceRow({
          label: t('options.buttonGlyphs'),
          options: [{ value: 'auto', label: t('options.glyphsAuto') }, { value: 'xbox', label: 'Xbox' }, { value: 'playstation', label: 'PlayStation' }, { value: 'nintendo', label: 'Nintendo' }],
          get: () => S().buttonGlyphs, set: (v) => set({ buttonGlyphs: v }),
        }),
        ui.choiceRow({
          label: t('options.confirmButton'), desc: t('options.confirmButtonDesc'),
          options: [{ value: 'auto', label: t('options.confirmAuto') }, { value: 'bottom', label: t('options.confirmBottom') }, { value: 'right', label: t('options.confirmRight') }],
          get: () => S().confirmButton, set: (v) => set({ confirmButton: v }),
        }),
        ui.toggleRow({ label: t('options.vibration'), get: () => S().vibration, set: (v) => { set({ vibration: v }); if (v) setTimeout(() => DL.input.rumble(0.5, 0.8, 180), 50); } }),
        ui.toggleRow({ label: t('options.controllerToast'), get: () => S().showControllerToast, set: (v) => set({ showControllerToast: v }) }),
        ui.sectionTitle(t('options.connected')),
      ];
      const pads = DL.input.connected();
      if (!pads.length) rows.push(ui.infoRow({ label: t('options.noControllers'), value: '' }));
      for (const p of pads) rows.push(ui.infoRow({ label: p.name, value: t('controller.player', { n: p.index + 1 }) }));
      rows.push(el('p', { class: 'opt-note', text: t('options.controllersNote') }));
      return rows;
    },
    library() {
      const rows = [ui.sectionTitle(t('options.sources'))];
      for (const id of ['steam', 'epic', 'gog', 'ubisoft', 'xbox', 'emulators', 'manual']) {
        const row = ui.toggleRow({ label: t(`sources.${id}`), desc: sourceDesc(id), get: () => S().sources[id], set: (v) => set({ sources: { [id]: v } }) });
        row._dlSource = id;
        rows.push(row);
      }
      rows.push(
        ui.sectionTitle(t('options.libraryOptions')),
        ui.toggleRow({ label: t('options.showUninstalledSteam'), desc: t('options.showUninstalledSteamDesc'), get: () => S().showUninstalledSteam, set: (v) => set({ showUninstalledSteam: v }) }),
        ui.toggleRow({ label: t('options.showUninstalledXbox'), desc: t('options.showUninstalledXboxDesc'), get: () => S().showUninstalledXbox, set: (v) => set({ showUninstalledXbox: v }) }),
        ui.toggleRow({ label: t('options.showHidden'), get: () => S().showHiddenGames, set: (v) => set({ showHiddenGames: v }) }),
        ui.toggleRow({ label: t('options.gogGalaxy'), desc: t('options.gogGalaxyDesc'), get: () => S().launchGogViaGalaxy, set: (v) => set({ launchGogViaGalaxy: v }) }),
        ui.actionRow({ label: t('options.rescan'), icon: 'refresh', onClick: rescan }),
        ui.actionRow({ label: t('importer.title'), onClick: () => DL.importer.open() }),
      );
      return rows;
    },
    accounts() {
      const sec = () => S().secrets || {};
      return [
        ui.sectionTitle('Steam'),
        ui.textRow({
          label: t('accounts.steamKey'), desc: t('accounts.steamKeyDesc'),
          get: () => '', display: () => sec().steamApiKey || '', placeholder: t('accounts.notSet'),
          hint: t('accounts.keyHint'),
          set: async (v) => { await set({ steamApiKey: v }); DL.toast({ title: t(v ? 'accounts.saved' : 'accounts.removed'), icon: 'check', tone: 'good' }); },
        }),
        ui.textRow({
          label: t('accounts.steamId'), desc: t('accounts.steamIdDesc'),
          get: () => S().steamId,
          display: () => S().steamId || (DL.state.profile.steamId ? t('accounts.detected', { id: DL.state.profile.steamId }) : ''),
          placeholder: t('accounts.notSet'),
          set: (v) => set({ steamId: v }),
        }),
        ui.actionRow({ label: t('accounts.test'), icon: 'check', onClick: testSteam }),
        ui.actionRow({ label: t('accounts.getSteamKey'), value: 'steamcommunity.com', onClick: () => DL.api.openExternal('https://steamcommunity.com/dev/apikey') }),
        ui.sectionTitle('SteamGridDB'),
        ui.textRow({
          label: t('accounts.sgdbKey'), desc: t('accounts.sgdbKeyDesc'),
          get: () => '', display: () => sec().sgdbApiKey || '', placeholder: t('accounts.notSet'),
          hint: t('accounts.keyHint'),
          set: async (v) => { await set({ sgdbApiKey: v }); DL.toast({ title: t(v ? 'accounts.saved' : 'accounts.removed'), icon: 'check', tone: 'good' }); },
        }),
        ui.actionRow({ label: t('accounts.getSgdbKey'), value: 'steamgriddb.com', onClick: () => DL.api.openExternal('https://www.steamgriddb.com/profile/preferences/api') }),
        ui.sectionTitle('Xbox'),
        ui.textRow({
          label: t('accounts.xboxKey'), desc: t('accounts.xboxKeyDesc'),
          get: () => '', display: () => sec().xblApiKey || '', placeholder: t('accounts.notSet'),
          hint: t('accounts.xboxKeyHint'),
          set: async (v) => { await set({ xblApiKey: v }); DL.toast({ title: t(v ? 'accounts.saved' : 'accounts.removed'), icon: 'check', tone: 'good' }); if (v) setTimeout(testXbox, 400); },
        }),
        ui.actionRow({ label: t('accounts.testXbox'), icon: 'check', onClick: testXbox }),
        ui.actionRow({ label: t('accounts.getXboxKey'), value: 'xbl.io', onClick: () => DL.api.openExternal('https://xbl.io') }),
        el('p', { class: 'opt-note', text: t('accounts.xboxNote') }),
        ui.sectionTitle(t('options.artwork')),
        ui.actionRow({ label: t('options.refreshArtwork'), desc: t('options.refreshArtworkDesc'), icon: 'refresh', onClick: async () => { await DL.api.refreshAllArtwork(); DL.toast({ title: t('options.refreshingArtwork'), icon: 'refresh' }); } }),
        ui.actionRow({
          label: t('options.clearArtwork'), icon: 'trash', danger: true,
          onClick: async () => {
            const c = await ui.confirm({ title: t('options.clearArtwork'), message: t('options.clearArtworkText'), buttons: [{ id: 'cancel', label: t('common.cancel'), primary: true }, { id: 'ok', label: t('options.clear'), danger: true }] });
            if (c === 'ok') { await DL.api.clearArtworkCache(); DL.toast({ title: t('options.refreshingArtwork'), icon: 'refresh' }); }
          },
        }),
      ];
    },
    data() {
      return [
        ui.actionRow({ label: t('data.export'), desc: t('data.exportDesc'), icon: 'chevron', onClick: async () => {
          const res = await DL.api.exportSettings();
          if (res && res.ok) DL.toast({ title: t('data.exported'), icon: 'check', tone: 'good' });
          else if (res && res.error) DL.showError(res);
        } }),
        ui.actionRow({ label: t('data.import'), desc: t('data.importDesc'), icon: 'chevron', onClick: async () => {
          const res = await DL.api.importSettings();
          if (res && res.ok) { applyFreshSettings(res.settings); DL.toast({ title: t('data.imported'), icon: 'check', tone: 'good' }); }
          else if (res && res.error) DL.showError(res);
        } }),
        ui.actionRow({ label: t('data.openFolder'), icon: 'folder', onClick: () => DL.api.openDataFolder() }),
        ui.actionRow({ label: t('data.reset'), desc: t('data.resetDesc'), icon: 'trash', danger: true, onClick: async () => {
          const c = await ui.confirm({ title: t('data.reset'), message: t('data.resetText'), buttons: [{ id: 'cancel', label: t('common.cancel'), primary: true }, { id: 'ok', label: t('data.resetConfirm'), danger: true }] });
          if (c === 'ok') { applyFreshSettings(await DL.api.resetSettings()); DL.toast({ title: t('data.resetDone'), icon: 'check' }); }
        } }),
      ];
    },
    about() {
      const sys = DL.state.system;
      return [
        el('div', { class: 'about' },
          el('img', { class: 'about-logo', attrs: { src: 'img/logo.svg', alt: '' } }),
          el('div', { class: 'about-name', text: 'Dream Launcher' }),
          el('div', { class: 'about-version', text: t('about.version', { v: sys.version || '0.1.0' }) })),
        ui.infoRow({ label: t('about.device'), value: (sys.device && sys.device.name) || '-' }),
        ui.infoRow({ label: 'Electron', value: sys.electron || '-' }),
        ui.infoRow({ label: 'Chromium', value: sys.chrome || '-' }),
        el('p', { class: 'opt-note', text: t('about.music') }),
        el('p', { class: 'opt-note', text: t('about.credits') }),
        el('p', { class: 'opt-note', text: t('about.keys') }),
      ];
    },
  };

  async function rescan() {
    DL.toast({ title: t('options.scanning'), icon: 'refresh', duration: 1600 });
    const lib = await DL.api.scanLibrary();
    if (lib && lib.games) {
      DL.setLibrary(lib);
      DL.toast({ title: t('options.scanDone'), sub: t('home.gamesCount', { n: lib.games.length, count: lib.games.length }), icon: 'check', tone: 'good' });
    }
  }

  async function testSteam() {
    const res = await DL.api.testSteam();
    if (res && res.ok) DL.toast({ title: t('accounts.testOk', { name: res.name }), icon: 'check', tone: 'good' });
    else if (res && res.error === 'offline') DL.toast({ title: t('accounts.xboxTestError.offline'), icon: 'wifiOff', tone: 'error' });
    else DL.toast({ title: t(`accounts.testError.${res && res.error === 'noKey' ? 'noKey' : res && res.error === 'noSteamId' ? 'noSteamId' : 'invalid'}`), icon: 'warn', tone: 'error' });
  }

  async function testXbox() {
    const res = await DL.api.testXbox();
    if (res && res.ok) DL.toast({ title: t('accounts.xboxTestOk', { name: res.name }), icon: 'check', tone: 'good' });
    else {
      const code = res && ['offline', 'noKey', 'auth', 'rateLimited'].includes(res.error) ? res.error : 'failed';
      DL.toast({ title: t(`accounts.xboxTestError.${code}`), icon: 'warn', tone: 'error' });
    }
    const net = await DL.api.netStatus();
    if (net && !net.error) DL.net.apply(net, { quiet: true });
  }

  async function refreshProfile() {
    const p = await DL.api.getProfile();
    if (p && !p.error) { DL.state.profile = p; DL.bus.emit('profile'); }
  }

  function applyFreshSettings(settings) {
    if (!settings || settings.error) return;
    const prevLang = DL.state.settings.language;
    DL.state.settings = settings;
    DL.bus.emit('settings', settings.language !== prevLang ? { language: settings.language, all: true } : { all: true });
    refreshProfile();
  }

  const RESETTABLE = ['general', 'display', 'sound', 'controllers', 'library', 'accounts'];

  /** "Reset this tab": puts only the settings of this tab back to their defaults. */
  function resetSectionRow(section, rerender) {
    const name = t(`options.sections.${section}`);
    return ui.actionRow({
      label: t('options.resetSection'), desc: t(section === 'accounts' ? 'options.resetSectionKeysDesc' : 'options.resetSectionDesc', { section: name }),
      icon: 'refresh', danger: true,
      onClick: async () => {
        const c = await ui.confirm({
          title: t('options.resetSectionTitle', { section: name }),
          message: t(section === 'accounts' ? 'options.resetSectionKeysText' : 'options.resetSectionText', { section: name }),
          buttons: [{ id: 'cancel', label: t('common.cancel'), primary: true }, { id: 'ok', label: t('options.resetSectionConfirm'), danger: true }],
        });
        if (c !== 'ok') return;
        const res = await DL.api.resetSettingsSection(section);
        if (!res || res.error) { DL.showError(res); return; }
        applyFreshSettings(res);
        rerender();
        DL.nav.refresh();
        DL.toast({ title: t('options.resetSectionDone', { section: name }), icon: 'check' });
      },
    });
  }

  let current = null;

  function open(sectionId) {
    if (DL.nav.has('options')) return;
    let section = SECTIONS.some((s) => s.id === sectionId) ? sectionId : 'general';
    let navList;
    let content;
    let sheet;

    const renderContent = () => {
      content.textContent = '';
      content.scrollTop = 0;
      content.appendChild(el('h3', { class: 'opt-title', text: t(`options.sections.${section}`) }));
      for (const row of BUILDERS[section]()) content.appendChild(row);
      if (RESETTABLE.includes(section)) content.appendChild(resetSectionRow(section, renderContent));
      for (const b of navList.children) b.classList.toggle('active', b.dataset.section === section);
    };
    const renderNav = () => {
      navList.textContent = '';
      for (const s of SECTIONS) {
        navList.appendChild(el('button', {
          class: 'opt-nav', nav: true, data: { section: s.id, sound: 'move' },
          on: { click: () => { const first = content.querySelector('[data-nav]'); if (first) DL.nav.focus(first); } },
        }, DL.icon(s.icon), el('span', { text: t(`options.sections.${s.id}`) })));
      }
    };
    const switchTo = (id, focusNav) => {
      if (id === section && content.children.length) return;
      section = id;
      renderContent();
      if (focusNav) {
        const b = navList.querySelector(`[data-section="${id}"]`);
        if (b) DL.nav.focus(b, { sound: false });
      }
    };
    const activeNav = () => navList.querySelector(`[data-section="${section}"]`);

    sheet = ui.openSheet({
      id: 'options',
      cls: 'options',
      title: t('options.title'),
      build(body, s) {
        sheet = s;
        navList = el('div', { class: 'opt-navlist' });
        content = el('div', { class: 'opt-content', attrs: { 'data-scroll': true } });
        body.appendChild(el('div', { class: 'opt-layout' }, navList, content));
        renderNav();
        renderContent();
      },
      initial: () => activeNav(),
      onFocus(node) {
        if (node.classList.contains('opt-nav') && node.dataset.section !== section) switchTo(node.dataset.section, false);
      },
      onMove(dir, focused) {
        if (!focused) return false;
        if (focused.classList.contains('opt-nav') && dir === 'right') {
          const first = content.querySelector('[data-nav]');
          if (first) DL.nav.focus(first);
          return true;
        }
        if (!focused.classList.contains('opt-nav') && dir === 'left') {
          DL.nav.focus(activeNav());
          return true;
        }
        return false;
      },
      onAction(action) {
        if (action === 'lb' || action === 'rb') {
          const i = SECTIONS.findIndex((s) => s.id === section);
          const next = SECTIONS[(i + (action === 'rb' ? 1 : -1) + SECTIONS.length) % SECTIONS.length];
          DL.sound.play('toggle');
          switchTo(next.id, true);
          return true;
        }
        return false;
      },
      onBack() {
        const f = DL.nav.focused();
        if (f && !f.classList.contains('opt-nav')) { DL.sound.play('back'); DL.nav.focus(activeNav(), { sound: false }); return; }
        DL.sound.play('back');
        sheet.close(true);
      },
      hints: [['confirm', t('hints.select')], ['lb', t('hints.sections')], ['back', t('hints.back')]],
      onClose: () => { current = null; offSettings(); offLib(); offPads(); offLang(); offDevice(); },
    });
    current = sheet;

    const rerender = () => {
      // Update values in place; rebuild only when the row set can change.
      for (const row of content.querySelectorAll('.opt-row')) {
        if (row._dlRender) row._dlRender();
        if (row._dlSource) {
          const d = row.querySelector('.row-desc');
          if (d) d.textContent = sourceDesc(row._dlSource);
        }
      }
    };
    const offSettings = DL.bus.on('settings', (patch) => {
      if (sheet.closed) return;
      if (patch && (patch.all || 'customMusicFile' in patch)) { renderContent(); DL.nav.refresh(); } else rerender();
    });
    const offLib = DL.bus.on('library', () => { if (!sheet.closed) rerender(); });
    const offPads = DL.bus.on('gamepads', () => { if (!sheet.closed && section === 'controllers') { renderContent(); DL.nav.refresh(); } });
    const offDevice = DL.bus.on('device', () => { if (!sheet.closed && (section === 'display' || section === 'about')) { renderContent(); DL.nav.refresh(); } });
    const offLang = DL.bus.on('language', () => {
      if (sheet.closed) return;
      sheet.title.textContent = t('options.title');
      const focusedSection = DL.nav.focused() && DL.nav.focused().dataset.section;
      renderNav();
      renderContent();
      sheet.setHints([['confirm', t('hints.select')], ['lb', t('hints.sections')], ['back', t('hints.back')]]);
      const target = focusedSection ? navList.querySelector(`[data-section="${focusedSection}"]`) : content.querySelector('.choice-row');
      DL.nav.focus(target || activeNav(), { sound: false, force: true });
    });
  }

  DL.options = { open, isOpen: () => !!current };
})();
