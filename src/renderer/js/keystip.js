/*
 * Dream Launcher - "Best experience with API keys": explains what each free key adds
 * (Steam Web API, SteamGridDB, OpenXBL) and leads to Options › Accounts & artwork.
 * Shown once after start-up while a useful key is missing; "Later" asks again in a week,
 * "Don't show again" never. It can always be opened from Options › Accounts & artwork.
 */
(function () {
  'use strict';
  const DL = (window.DL = window.DL || {});
  const { el } = DL;

  const STORE_KEY = 'dl.keysTip';
  const LATER_MS = 7 * 24 * 3600 * 1000;
  const t = (k, p) => DL.t(k, p);

  function readState() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch { return {}; }
  }
  function writeState(v) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(v)); } catch { /* not kept */ }
  }

  /** The keys worth having for this library, and whether each is set. */
  function keys() {
    const sec = (DL.state.settings && DL.state.settings.secrets) || {};
    const games = DL.state.games || [];
    const has = (src) => games.some((g) => g.source === src);
    const list = [
      {
        id: 'steam', title: t('keysTip.steamTitle'), text: t('keysTip.steamText'), icon: 'trophy',
        set: !!sec.steamApiKey, useful: has('steam'),
      },
      {
        id: 'sgdb', title: t('keysTip.sgdbTitle'), text: t('keysTip.sgdbText'), icon: 'image',
        set: !!sec.sgdbApiKey, useful: games.some((g) => g.source !== 'steam') || !games.length,
      },
      {
        id: 'xbox', title: t('keysTip.xboxTitle'), text: t('keysTip.xboxText'), icon: 'controller',
        set: !!sec.xblApiKey, useful: has('xbox'),
      },
    ];
    return list;
  }

  /**
   * Opens the explanation. `fromStart`: shown by itself, so it offers "Later" / "Don't show again".
   * `preview` (debug menu): looks the same, but the choice isn't saved.
   */
  function open({ fromStart = false, preview = false } = {}) {
    if (DL.nav.has && DL.nav.has('keystip')) return;
    const list = keys();
    let sheet;
    const close = (how) => {
      if (fromStart && !preview) {
        const st = readState();
        if (how === 'never') st.never = true;
        else st.laterUntil = Date.now() + LATER_MS;
        writeState(st);
      }
      sheet.close(how === 'setup');
    };
    const setup = () => {
      close('setup');
      setTimeout(() => DL.options.open('accounts'), 120);
    };
    sheet = DL.ui.openSheet({
      id: 'keystip',
      cls: 'dialog keys-tip',
      title: t('keysTip.title'),
      build(body) {
        body.appendChild(el('p', { class: 'dialog-text', text: t('keysTip.intro') }));
        const cards = el('div', { class: 'keys-cards' });
        for (const k of list) {
          cards.appendChild(el('div', { class: `keys-card ${k.set ? 'is-set' : ''}` },
            el('span', { class: 'keys-ic' }, DL.icon(k.icon)),
            el('div', { class: 'keys-text' },
              el('div', { class: 'keys-title' },
                el('b', { text: k.title }),
                el('span', { class: `keys-pill ${k.set ? 'set' : ''}`, text: k.set ? t('keysTip.isSet') : t('keysTip.notSet') })),
              el('p', { text: k.text }))));
        }
        body.appendChild(cards);
        body.appendChild(el('p', { class: 'keys-note', text: t('keysTip.note') }));
        const row = el('div', { class: 'dialog-buttons' });
        row.appendChild(el('button', { class: 'btn primary', nav: true, text: t('keysTip.setup'), on: { click: setup } }));
        row.appendChild(el('button', { class: 'btn', nav: true, text: fromStart ? t('keysTip.later') : t('hints.close'), on: { click: () => close('later') } }));
        if (fromStart) row.appendChild(el('button', { class: 'btn', nav: true, text: t('keysTip.never'), on: { click: () => close('never') } }));
        body.appendChild(row);
      },
      initial: (panel) => panel.querySelector('.dialog-buttons [data-nav]'),
      hints: [['confirm', t('hints.select')], ['back', fromStart ? t('keysTip.later') : t('hints.close'), () => close('later')]],
      onBack: () => { DL.sound.play('back'); close('later'); },
    });
  }

  /**
   * After start-up: shows the tip if a useful key is missing, once the home screen is idle
   * (no other window open). Not while offline: the keys only matter online.
   */
  function maybeShow() {
    const st = readState();
    if (st.never || (st.laterUntil && Date.now() < st.laterUntil)) return;
    let tries = 0;
    const attempt = () => {
      tries++;
      if (DL.state.net && DL.state.net.online === false) return;
      const missing = keys().filter((k) => k.useful && !k.set);
      if (!missing.length) return;
      const top = DL.nav.top();
      const idle = top && top.id === 'dashboard' && !(DL.hub && DL.hub.isOpen()) && !DL.state.gameRunning;
      if (!idle) { if (tries < 6) setTimeout(attempt, 20000); return; }
      open({ fromStart: true });
    };
    setTimeout(attempt, 2500);
  }

  /** Forgets "Later" / "Don't show again" (debug menu). */
  function reset() { try { localStorage.removeItem(STORE_KEY); } catch { /* not kept */ } }

  DL.keysTip = { open, maybeShow, keys, reset };
})();
