/*
 * Dream Launcher - online / offline mode.
 * The Wi-Fi button in the top bar opens this panel: it says whether the launcher is online or
 * offline (and why), what needs the internet, and lets you switch offline mode on or off.
 */
(function () {
  'use strict';
  const DL = (window.DL = window.DL || {});
  const { el, ui } = DL;
  const t = (k, p) => DL.t(k, p);

  DL.icons.wifi = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M2.5 9a14 14 0 0 1 19 0"/><path d="M5.8 12.6a9.2 9.2 0 0 1 12.4 0"/><path d="M9.1 16.1a4.4 4.4 0 0 1 5.8 0"/><circle cx="12" cy="19.4" r="1.2" fill="currentColor" stroke="none"/></svg>';
  DL.icons.wifiOff = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M2.5 9a14 14 0 0 1 5.2-3.3M12 4.4a14 14 0 0 1 9.5 4.6"/><path d="M5.8 12.6a9 9 0 0 1 3.4-2.1M15.5 10.9a9 9 0 0 1 2.7 1.7"/><path d="M9.1 16.1a4.4 4.4 0 0 1 5.8 0"/><circle cx="12" cy="19.4" r="1.2" fill="currentColor" stroke="none"/><path d="M3.5 3.5l17 17"/></svg>';
  DL.icons.checkCircle = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12.3l2.7 2.7L16.2 9.5"/></svg>';
  DL.icons.pause = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/></svg>';

  let sheet = null;

  const online = () => DL.state.net.online !== false;

  function reasonText(net) {
    if (online()) return t('net.onlineText');
    if (net.reason === 'forced') return t('net.forcedText');
    if (net.reason === 'noNetwork') return t('net.noNetworkText');
    return t('net.noInternetText');
  }

  function serviceRows(net) {
    const sv = net.services || {};
    const steam = sv.steam || {};
    const xbox = sv.xbox || {};
    const sgdb = sv.sgdb || {};
    const rows = [];
    const row = (label, value, good) => el('div', { class: `net-service ${good ? 'good' : ''}` },
      el('span', { class: 'net-service-name', text: label }),
      el('span', { class: 'net-service-value', text: value }));
    rows.push(row(t('net.svcSteam'), !steam.key ? t('net.svcNoKey') : (online() ? t('net.svcActive') : t('net.svcPaused')), steam.key && online()));
    let xboxValue;
    if (!xbox.key) xboxValue = t('net.svcNotSetUp');
    else if (xbox.authError) xboxValue = t('net.svcXboxRenew');
    else if (!online()) xboxValue = t('net.svcPaused');
    else if (xbox.account && xbox.account.gamertag) xboxValue = t('net.svcXboxAs', { name: xbox.account.gamertag });
    else xboxValue = t('net.svcActive');
    rows.push(row(t('net.svcXbox'), xboxValue, xbox.key && online() && !xbox.authError));
    rows.push(row(t('net.svcArt'), online() ? (sgdb.key ? t('net.svcArtSgdb') : t('net.svcActive')) : t('net.svcPaused'), online()));
    return rows;
  }

  function build(body) {
    const net = DL.state.net || {};
    body.textContent = '';
    const on = online();
    body.appendChild(el('div', { class: `net-hero ${on ? 'online' : 'offline'}` },
      el('span', { class: 'net-hero-icon' }, DL.icon(on ? 'wifi' : 'wifiOff')),
      el('div', { class: 'net-hero-text' },
        el('div', { class: 'net-hero-title', text: t(on ? 'net.onlineTitle' : 'net.offlineTitle') }),
        el('p', { class: 'net-hero-desc', text: reasonText(net) }))));

    const wrap = el('div', { class: 'menu-list net-list', attrs: { 'data-scroll': true } });
    wrap.appendChild(ui.toggleRow({
      label: t('net.offlineMode'),
      desc: t('net.offlineModeDesc'),
      get: () => DL.state.settings.onlineMode === 'offline',
      set: (v) => { DL.saveSettings({ onlineMode: v ? 'offline' : 'auto' }); },
    }));
    if (!on && net.reason !== 'forced') {
      wrap.appendChild(ui.actionRow({ label: t('net.checkAgain'), icon: 'refresh', onClick: (row) => checkAgain(row) }));
    }

    // What works without internet, and what is paused / needs it.
    const works = ['net.worksGames', 'net.worksPlaytime', 'net.worksShots', 'net.worksMusic', 'net.worksArt'];
    const needs = ['net.needsAch', 'net.needsFriends', 'net.needsArt', 'net.needsOwned', 'net.needsXbox', 'net.needsUpdates'];
    const col = (titleKey, keys, icon, cls) => el('div', { class: `net-col ${cls}` },
      el('div', { class: 'net-col-title', text: t(titleKey) }),
      ...keys.map((k) => el('div', { class: 'net-item' }, DL.icon(icon), el('span', { text: t(k) }))));
    wrap.appendChild(el('div', { class: 'net-cols' },
      col('net.worksTitle', works, 'checkCircle', 'works'),
      col(on ? 'net.usesTitle' : 'net.pausedTitle', needs, on ? 'wifi' : 'pause', on ? 'uses' : 'paused')));

    wrap.appendChild(ui.sectionTitle(t('net.servicesTitle')));
    for (const r of serviceRows(net)) wrap.appendChild(r);
    wrap.appendChild(ui.actionRow({ label: t('net.openAccounts'), onClick: () => { close(true); DL.options.open('accounts'); } }));
    if (!on) wrap.appendChild(el('p', { class: 'opt-note', text: t('net.offlineNote') }));
    body.appendChild(wrap);
  }

  async function checkAgain(row) {
    if (row) row._dlSetValue(t('net.checking'));
    const res = await DL.api.netCheck();
    if (res && !res.error) apply(res, { quiet: true });
    if (row && !sheet) return;
    if (!online()) DL.toast({ title: t('net.stillOffline'), icon: 'wifiOff' });
  }

  function rerender() {
    if (!sheet || sheet.closed) return;
    const focusedLabel = DL.nav.focused() && DL.nav.focused().querySelector && DL.nav.focused().querySelector('.row-label');
    const label = focusedLabel ? focusedLabel.textContent : null;
    sheet.title.textContent = t('net.title');
    build(sheet.body);
    DL.nav.refresh();
    const again = label && [...sheet.body.querySelectorAll('[data-nav]')].find((n) => (n.querySelector('.row-label') || {}).textContent === label);
    DL.nav.focus(again || sheet.body.querySelector('[data-nav]'), { sound: false, force: true });
  }

  function open() {
    if (sheet && !sheet.closed) return;
    sheet = ui.openSheet({
      id: 'net',
      cls: 'side',
      title: t('net.title'),
      build: (body) => build(body),
      initial: (panel) => panel.querySelector('[data-nav]'),
      hints: [['confirm', t('hints.select')], ['back', t('hints.close')]],
      onClose: () => { sheet = null; },
    });
  }

  function close(silent) { if (sheet && !sheet.closed) sheet.close(silent); }

  /** New status from the main process. Tells the user when the state changes by itself. */
  function apply(net, { quiet = false } = {}) {
    if (!net || typeof net !== 'object') return;
    const before = DL.state.net || {};
    DL.state.net = net;
    const changed = before.online !== net.online;
    if (changed) {
      // Online data shown before is no longer valid (or now available).
      DL.state.details.clear();
      if (DL.hub) { DL.hub.invalidate(); DL.hub.reload(); }
      if (DL.app && DL.app.loadFriends) DL.app.loadFriends();
      if (!quiet && DL.state.ready) {
        if (net.online) DL.toast({ title: t(before.reason === 'forced' ? 'net.toastModeOff' : 'net.toastOnline'), icon: 'wifi', tone: 'good' });
        else DL.toast({ title: t(net.reason === 'forced' ? 'net.toastModeOn' : 'net.toastOffline'), sub: net.reason === 'forced' ? '' : t('net.toastOfflineText'), icon: 'wifiOff', duration: 4200 });
      }
    }
    DL.bus.emit('net', net);
    rerender();
  }

  DL.net = { open, close, apply, isOnline: online };
})();
