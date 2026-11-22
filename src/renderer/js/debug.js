/*
 * Dream Launcher - hidden debug menu: type "debug" into the search.
 * Shows screens that normally only appear in certain situations (update available, API keys
 * reminder, connection panel …) so they can be checked at any time. Previews don't change
 * anything: no download, no install, no saved choice.
 */
(function () {
  'use strict';
  const DL = (window.DL = window.DL || {});
  const { el } = DL;
  const t = (k, p) => DL.t(k, p);

  /** A version one step above the running one, for update previews. */
  function nextVersion() {
    const cur = (DL.state.update && DL.state.update.current) || DL.state.version || '2.3.0';
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(cur));
    return m ? `${m[1]}.${Number(m[2]) + 1}.0` : '9.9.9';
  }

  const ITEMS = [
    {
      label: 'Update available (notice)', icon: 'download', desc: 'The message shown when a new version is found.',
      run: () => DL.toast({ title: t('update.toastTitle', { v: nextVersion() }), sub: t('update.toastText'), icon: 'download', duration: 7000 }),
    },
    {
      label: 'Install update (window)', icon: 'download', desc: 'The question before installing. Preview only: nothing is installed.',
      run: async () => {
        const v = nextVersion();
        const c = await DL.ui.confirm({
          title: t('update.installTitle', { v }),
          message: t('update.installText'),
          buttons: [{ id: 'ok', label: t('update.installNow'), primary: true }, { id: 'later', label: t('update.later') }],
        });
        if (c === 'ok') DL.toast({ title: t('update.installing'), sub: t('update.installingText'), icon: 'download', duration: 5000 });
      },
    },
    {
      label: 'Update in Options', icon: 'options', desc: 'Options › About with the update rows.',
      run: () => DL.options.open('about'),
    },
    {
      label: 'API keys reminder', icon: 'info', desc: 'The start-up window about the free keys. Preview only: your choice is not saved.',
      run: () => DL.keysTip.open({ fromStart: true, preview: true }),
    },
    {
      label: 'Show API keys reminder again', icon: 'refresh', desc: 'Forgets "Later" and "Don\'t show again", so it can appear at the next start.',
      run: () => { DL.keysTip.reset(); DL.toast({ title: 'API keys reminder reset', icon: 'check', tone: 'good' }); },
    },
    {
      label: 'Connection panel', icon: 'wifi', desc: 'Online / offline explanation (the Wi-Fi button).',
      run: () => DL.net.open(),
    },
    {
      label: 'Show "More below" text again', icon: 'chevronDown', desc: 'The arrow under the game row shows its text again.',
      run: () => {
        try { localStorage.removeItem('dl.hubOpened'); } catch { /* not kept */ }
        if (DL.dashboard) DL.dashboard.render();
        DL.toast({ title: '"More below" text reset', icon: 'check', tone: 'good' });
      },
    },
    {
      label: 'Error message', icon: 'warn', desc: 'How an error toast looks.',
      run: () => DL.toast({ title: t('update.error.failed'), icon: 'warn', tone: 'error' }),
    },
  ];

  const isDebug = (query) => String(query || '').trim().toLowerCase() === 'debug';

  /** Fills the search results with the debug entries. `close` closes the search first. */
  function render(results, close) {
    results.appendChild(el('div', { class: 'debug-head', text: 'Debug' }));
    for (const item of ITEMS) {
      results.appendChild(el('button', {
        class: 'debug-item', nav: true,
        on: { click: () => { close(); setTimeout(() => item.run(), 160); } },
      }, el('span', { class: 'debug-ic' }, DL.icon(item.icon)), el('span', { class: 'debug-text' }, el('b', { text: item.label }), el('span', { text: item.desc }))));
    }
  }

  DL.debug = { isDebug, render, items: ITEMS };
})();
