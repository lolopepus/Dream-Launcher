/*
 * Dream Launcher - "Best experience with API keys": explains what each free key adds
 * (Steam Web API, SteamGridDB, OpenXBL) and leads to Options › Accounts & artwork.
 * Shown after every start while a key is missing; "Later" closes it until the next start,
 * "Don't show again" turns it off for good. It can always be opened from Options › Accounts & artwork.
 */
(function () {
  'use strict';
  const DL = (window.DL = window.DL || {});
  const { el } = DL;

  const STORE_KEY = 'dl.keysTip';
  const t = (k, p) => DL.t(k, p);

  function readState() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch { return {}; }
  }
  function writeState(v) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(v)); } catch { /* not kept */ }
  }

  /** The three keys and whether each is set. */
  function keys() {
    const sec = (DL.state.settings && DL.state.settings.secrets) || {};
    const list = [
      {
        id: 'steam', title: t('keysTip.steamTitle'), text: t('keysTip.steamText'), icon: 'trophy',
        set: !!sec.steamApiKey,
      },
      {
        id: 'sgdb', title: t('keysTip.sgdbTitle'), text: t('keysTip.sgdbText'), icon: 'image',
        set: !!sec.sgdbApiKey,
      },
      {
        id: 'xbox', title: t('keysTip.xboxTitle'), text: t('keysTip.xboxText'), icon: 'controller',
        set: !!sec.xblApiKey,
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
        // "Later" only closes it (it comes back at the next start); "Don't show again" is kept.
        if (how === 'never') writeState({ ...readState(), never: true });
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
   * After start-up: shows the tip on every start (the first one included) until "Don't show
   * again" was chosen, unless all three keys are already set. It waits until the home screen is
   * free (no other window open, no game running) and then appears.
   */
  function maybeShow() {
    if (readState().never) return;
    const attempt = () => {
      if (readState().never || !keys().some((k) => !k.set)) return;
      const top = DL.nav.top();
      const idle = top && top.id === 'dashboard' && !(DL.hub && DL.hub.isOpen()) && !DL.state.gameRunning;
      if (!idle) { setTimeout(attempt, 3000); return; }
      open({ fromStart: true });
    };
    setTimeout(attempt, 2500);
  }

  /** Forgets "Later" / "Don't show again" (debug menu). */
  function reset() { try { localStorage.removeItem(STORE_KEY); } catch { /* not kept */ } }

  DL.keysTip = { open, maybeShow, keys, reset };
})();
