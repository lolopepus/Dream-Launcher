/*
 * Dream Launcher - hidden debug menu: type "debug" into the search.
 * For trying things that normally only happen in certain situations:
 *  - Pretend: offline, no API keys, an update available, a game running. Only the window
 *    pretends; nothing changes for real, and everything goes back with "Back to normal".
 *  - Show: the tour, the API keys window, the update notice and windows, the colour picker …
 *  - Tools: data folder, rescan, update check, artwork cache, reload.
 *  - Info: version, games per store, last update check, which keys are set.
 * Previews don't download, install or save anything. The menu is in English only on purpose.
 */
(function () {
  'use strict';
  const DL = (window.DL = window.DL || {});
  const { el } = DL;
  const t = (k, p) => DL.t(k, p);

  /** What is being pretended (read by net.js / app.js so real updates don't undo it). */
  const fakes = { offline: false, noKeys: false, update: false, gameRunning: false };
  let realSecrets = null;

  /** A version one step above the running one, for update previews. */
  function nextVersion() {
    const cur = (DL.state.update && DL.state.update.current) || (DL.state.system && DL.state.system.version) || '2.5.0';
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(cur));
    return m ? `${m[1]}.${Number(m[2]) + 1}.0` : '9.9.9';
  }

  const isDebug = (query) => String(query || '').trim().toLowerCase() === 'debug';
  const toast = (title, icon = 'check') => DL.toast({ title, icon, tone: 'good', duration: 2200 });

  // ---------------------------------------------------------------- pretending

  /** Fake update status (kept while "Update available" is on). */
  function fakeUpdate(real) {
    const v = nextVersion();
    return {
      ...(real || {}), status: 'available', error: null, progress: null,
      latest: { version: v, name: `Dream Launcher ${v}`, url: 'https://github.com/lolopepus/Dream-Launcher/releases', size: 125e6, publishedAt: new Date().toISOString() },
    };
  }
  /** net.js / app.js pass real updates through these while pretending. */
  const filterNet = (net) => (fakes.offline && net && net.online ? { ...net, online: false, reason: 'noInternet' } : net);
  const filterUpdate = (u) => (fakes.update ? fakeUpdate(u) : u);

  async function setFake(key, on) {
    fakes[key] = on;
    if (key === 'offline') {
      const real = await DL.api.netStatus().catch(() => null);
      if (real && !real.error) DL.net.apply(real);
    } else if (key === 'noKeys') {
      const s = DL.state.settings;
      if (on) { realSecrets = s.secrets; DL.state.settings = { ...s, secrets: {} }; } else if (realSecrets) { DL.state.settings = { ...s, secrets: realSecrets }; realSecrets = null; }
      DL.bus.emit('settings', {});
    } else if (key === 'update') {
      const real = await DL.api.updateStatus().catch(() => null);
      DL.state.update = filterUpdate(real && !real.error ? real : DL.state.update);
      DL.bus.emit('update', DL.state.update);
    } else if (key === 'gameRunning') {
      DL.state.gameRunning = on;
      if (on) { if (DL.state.settings.pauseMusicWhilePlaying) DL.music.pause('game'); } else DL.music.resume('game');
      DL.waves.refresh();
    }
  }

  async function backToNormal() {
    for (const key of Object.keys(fakes)) if (fakes[key]) await setFake(key, false);
  }

  // ---------------------------------------------------------------- the menu

  function info() {
    const s = DL.state.settings || {};
    const sec = s.secrets || {};
    const games = DL.state.games || [];
    const per = {};
    for (const g of games) per[g.sourceLabel || g.source] = (per[g.sourceLabel || g.source] || 0) + 1;
    const u = DL.state.update || {};
    const when = u.checkedAt ? DL.fmt.dateTime(u.checkedAt) : 'never';
    const yesNo = (v) => (v ? 'set' : 'not set');
    return [
      ['Version', `${(DL.state.system && DL.state.system.version) || u.current || '?'}${DL.state.system && DL.state.system.electron ? ` · Electron ${DL.state.system.electron}` : ''}`],
      ['Games', `${games.length} · ${Object.entries(per).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`],
      ['Last update check', `${when}${u.latest ? ` · newest ${u.latest.version}` : ''} · ${u.status || 'idle'}`],
      ['API keys', `Steam ${yesNo(sec.steamApiKey)} · SteamGridDB ${yesNo(sec.sgdbApiKey)} · XBOX ${yesNo(sec.xblApiKey)}`],
      ['Connection', DL.state.net && DL.state.net.online === false ? `offline (${DL.state.net.reason || '?'})` : 'online'],
      ['Screen', `${window.innerWidth}×${window.innerHeight} · scale ${DL.stage ? DL.stage.s.toFixed(2) : '?'} · ${(DL.stage && DL.stage.size) || ''} · theme ${s.theme || 'game'}`],
      ['Tour / API keys window', `tour seen: ${(() => { try { return localStorage.getItem('dl.tourSeen') || 'no'; } catch { return '?'; } })()} · keys window: ${DL.keysTip.isOff() ? 'turned off' : 'on'}`],
    ];
  }

  function open() {
    if (DL.nav.has('debug')) return;
    const { ui } = DL;
    let sheet;
    const infoBox = el('div', { class: 'debug-info' });
    const fillInfo = () => { infoBox.textContent = ''; for (const [label, value] of info()) infoBox.appendChild(DL.ui.infoRow({ label, value })); };
    const fake = (key) => (v) => setFake(key, v).then(fillInfo);
    const later = (fn) => () => { sheet.close(true); setTimeout(fn, 200); };
    const build = (body) => {
      body.textContent = '';
      fillInfo();
      const pretend = [
        ui.sectionTitle('Pretend (only this window, nothing changes for real)'),
        ui.toggleRow({ label: 'Offline', desc: 'Shows the launcher as if there were no internet.', get: () => fakes.offline, set: fake('offline') }),
        ui.toggleRow({ label: 'No API keys', desc: 'As if no keys were set, in the API keys window, the tour and Options.', get: () => fakes.noKeys, set: fake('noKeys') }),
        ui.toggleRow({ label: 'Update available', desc: `As if version ${nextVersion()} were out (dot on Options, Options › About). Nothing is downloaded.`, get: () => fakes.update, set: fake('update') }),
        ui.toggleRow({ label: 'Game running', desc: 'Music pauses and the waves rest, as while playing.', get: () => fakes.gameRunning, set: fake('gameRunning') }),
        ui.actionRow({ label: 'Back to normal', desc: 'Turns all of the above off.', icon: 'refresh', onClick: async () => { await backToNormal(); build(body); DL.nav.refresh(); toast('Back to normal'); } }),
        ui.sectionTitle('Show'),
        ui.actionRow({ label: 'Tour', desc: 'Runs the first-start tour now (it still counts as seen).', icon: 'chevron', onClick: later(() => DL.tour.start({ replay: true })) }),
        ui.actionRow({ label: 'API keys window', desc: 'As shown after start-up. Your choice is not saved.', icon: 'chevron', onClick: later(() => DL.keysTip.open({ fromStart: true, preview: true })) }),
        ui.actionRow({ label: 'Colour picker', icon: 'chevron', onClick: later(() => DL.theme.openPicker()) }),
        ui.actionRow({ label: 'Update notice', desc: 'The message shown when a new version is found.', icon: 'chevron', onClick: () => DL.toast({ title: t('update.toastTitle', { v: nextVersion() }), sub: t('update.toastText'), icon: 'download', duration: 6000 }) }),
        ui.actionRow({
          label: 'Install update window', desc: 'The question before installing. Nothing is installed.', icon: 'chevron',
          onClick: later(async () => {
            const v = nextVersion();
            const c = await DL.ui.confirm({ title: t('update.installTitle', { v }), message: t('update.installText'), buttons: [{ id: 'ok', label: t('update.installNow'), primary: true }, { id: 'later', label: t('update.later') }] });
            if (c === 'ok') DL.toast({ title: t('update.installing'), sub: t('update.installingText'), icon: 'download', duration: 4000 });
          }),
        }),
        ui.actionRow({ label: 'Options › About', desc: 'The update rows.', icon: 'chevron', onClick: later(() => DL.options.open('about')) }),
        ui.actionRow({ label: 'Connection panel', icon: 'chevron', onClick: later(() => DL.net.open()) }),
        ui.actionRow({ label: 'Error message', icon: 'chevron', onClick: () => DL.toast({ title: t('update.error.failed'), icon: 'warn', tone: 'error' }) }),
        ui.actionRow({
          label: 'First start again', desc: 'The tour and the API keys window appear at the next start, as for a new user.', icon: 'refresh',
          onClick: () => { DL.tour.reset(); DL.keysTip.reset(); try { localStorage.removeItem('dl.hubOpened'); } catch { /* not kept */ } toast('Tour and API keys window reset'); },
        }),
      ];
      const tools = [
        ui.sectionTitle('Info'),
        infoBox,
        ui.sectionTitle('Tools'),
        ui.actionRow({ label: 'Open data folder', desc: 'Settings, library cache, artwork and previews.', icon: 'folder', onClick: () => DL.api.openDataFolder() }),
        ui.actionRow({ label: 'Rescan library', icon: 'refresh', onClick: async () => { toast('Scanning …', 'refresh'); await DL.api.scanLibrary(); toast('Library scanned'); build(body); DL.nav.refresh(); } }),
        ui.actionRow({
          label: 'Check for updates now', desc: 'Asks GitHub right away.', icon: 'download',
          onClick: async () => {
            const res = await DL.api.updateCheck().catch(() => null);
            if (res && !res.error && res.status) { DL.state.update = filterUpdate(res); DL.bus.emit('update', DL.state.update); }
            toast(res && res.status ? `Update check: ${res.status}${res.latest ? ` (${res.latest.version})` : ''}` : `Update check failed${res && res.error ? `: ${res.error}` : ''}`, 'download');
            build(body);
            DL.nav.refresh();
          },
        }),
        ui.actionRow({
          label: 'Clear artwork cache', desc: 'Downloads all artwork again.', icon: 'trash', danger: true,
          onClick: async () => {
            const c = await ui.confirm({ title: t('options.clearArtwork'), message: t('options.clearArtworkText'), buttons: [{ id: 'cancel', label: t('common.cancel'), primary: true }, { id: 'ok', label: t('options.clear'), danger: true }] });
            if (c === 'ok') { await DL.api.clearArtworkCache(); toast(t('options.refreshingArtwork'), 'refresh'); }
          },
        }),
        ui.actionRow({ label: 'Reload window', desc: 'Starts the window again (plays the start-up animation).', icon: 'refresh', onClick: () => location.reload() }),
      ];
      body.appendChild(el('div', { class: 'debug-cols' },
        el('div', { class: 'form-list', attrs: { 'data-scroll': true } }, ...pretend),
        el('div', { class: 'form-list', attrs: { 'data-scroll': true } }, ...tools)));
    };
    sheet = DL.ui.openSheet({ id: 'debug', cls: 'options debug-sheet', title: 'Debug', subtitle: 'Try screens and states. Nothing here changes your library or settings unless it says so.', build });
  }

  /** In the search: one entry that opens the menu. */
  function render(results, close) {
    results.appendChild(el('button', {
      class: 'debug-item', nav: true,
      on: { click: () => { close(); setTimeout(open, 180); } },
    }, el('span', { class: 'debug-ic' }, DL.icon('options')), el('span', { class: 'debug-text' }, el('b', { text: 'Debug menu' }), el('span', { text: 'Pretend states (offline, update available …), show the tour and other windows, tools and info.' }))));
  }

  DL.debug = { isDebug, render, open, fakes, filterNet, filterUpdate, backToNormal };
})();
