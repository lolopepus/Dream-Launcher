/*
 * Dream Launcher - "Best experience with API keys": what each free key adds (Steam Web API,
 * SteamGridDB, OpenXBL), how to get it in three steps, a button that opens the right page, and
 * the key can be pasted or typed right here (no trip to Options needed).
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

  /** The three keys: the setting they're saved in, where to get one, what a key looks like. */
  const KEYS = [
    { id: 'steam', setting: 'steamApiKey', icon: 'trophy', site: 'steamcommunity.com', url: 'https://steamcommunity.com/dev/apikey', pattern: /^[A-Za-z0-9]{20,64}$/, test: 'steam' },
    { id: 'sgdb', setting: 'sgdbApiKey', icon: 'image', site: 'steamgriddb.com', url: 'https://www.steamgriddb.com/profile/preferences/api', pattern: /^[A-Za-z0-9]{20,64}$/ },
    { id: 'xbox', setting: 'xblApiKey', icon: 'controller', site: 'xbl.io', url: 'https://xbl.io', pattern: /^[A-Za-z0-9._-]{16,128}$/, test: 'xbox' },
  ];
  // The debug menu's "No API keys" makes every key look missing.
  const isSet = (k) => !(DL.debug && DL.debug.fakes.noKeys) && !!(((DL.state.settings && DL.state.settings.secrets) || {})[k.setting]);

  /** The three keys and whether each is set (also used by the debug menu). */
  function keys() {
    return KEYS.map((k) => ({ id: k.id, title: t(`keysTip.${k.id}Title`), text: t(`keysTip.${k.id}Text`), icon: k.icon, set: isSet(k) }));
  }

  /** Saves a key and, for Steam and XBOX, checks it right away. */
  async function saveKey(k, value) {
    const v = String(value || '').trim();
    if (!v) return;
    await DL.saveSettings({ [k.setting]: v });
    const name = t(`keysTip.${k.id}Title`);
    let res = null;
    if (k.test === 'steam') res = await DL.api.testSteam().catch(() => null);
    if (k.test === 'xbox') res = await DL.api.testXbox().catch(() => null);
    if (res && res.ok) {
      DL.toast({ title: t('keysTip.savedAs', { name, account: res.name || '' }), icon: 'check', tone: 'good' });
    } else if (res && ['invalid', 'auth'].includes(res.error)) {
      DL.toast({ title: t('keysTip.savedCheck', { name }), sub: t('keysTip.savedCheckText'), icon: 'warn', tone: 'error' });
    } else {
      DL.toast({ title: t('keysTip.saved', { name }), icon: 'check', tone: 'good' });
    }
    if (k.test === 'xbox' && DL.api.netStatus) {
      const net = await DL.api.netStatus().catch(() => null);
      if (net && !net.error && DL.net) DL.net.apply(net, { quiet: true });
    }
  }

  /**
   * Opens the window. `fromStart`: shown by itself, so it offers "Later" / "Don't show again".
   * `preview` (debug menu): looks the same, but the choice isn't saved.
   * `onClose`: called once it's closed (the tour continues from there).
   */
  function open({ fromStart = false, preview = false, onClose } = {}) {
    if (DL.nav.has && DL.nav.has('keystip')) return null;
    let sheet;
    let closed = false;
    const close = (how, silent = false) => {
      if (closed) return;
      // "Later" only closes it (it comes back at the next start); "Don't show again" is kept.
      if (fromStart && !preview && how === 'never') writeState({ ...readState(), never: true });
      sheet.close(silent);
    };

    const card = (k) => {
      const set = isSet(k);
      const paste = async () => {
        const res = await DL.api.clipboardText().catch(() => null);
        const text = (res && res.text) || '';
        if (!k.pattern.test(text)) {
          DL.sound.play('error');
          DL.toast({ title: t('keysTip.noKeyInClipboard'), sub: t('keysTip.noKeyInClipboardText'), icon: 'warn' });
          return;
        }
        await saveKey(k, text);
        render(k.id, 'paste');
      };
      const type = async () => {
        const v = await DL.ui.editText({ title: t(`keysTip.${k.id}Title`), placeholder: t('accounts.notSet'), hint: t('accounts.keyHint') });
        if (v !== null && v.trim()) {
          await saveKey(k, v);
          render(k.id, 'type');
        }
      };
      const btn = (cls, icon, label, onClick, action) => el('button', { class: `btn keys-btn ${cls}`, nav: true, data: { key: k.id, action }, on: { click: onClick } },
        DL.icon(icon), el('span', { text: label }));
      return el('div', { class: `keys-card ${set ? 'is-set' : ''}` },
        el('div', { class: 'keys-card-head' },
          el('span', { class: 'keys-ic' }, DL.icon(k.icon)),
          el('div', { class: 'keys-titles' },
            el('b', { text: t(`keysTip.${k.id}Title`) }),
            el('span', { class: `keys-pill ${set ? 'set' : ''}` }, set ? DL.icon('check') : null, el('span', { text: set ? t('keysTip.isSet') : t('keysTip.notSet') })))),
        el('p', { class: 'keys-what', text: t(`keysTip.${k.id}Text`) }),
        el('ol', { class: 'keys-steps' }, ...[1, 2, 3].map((n) => el('li', { text: t(`keysTip.${k.id}Step${n}`) }))),
        // In the order of the steps: open the page, then paste (or type) the key.
        el('div', { class: 'keys-actions' },
          btn('keys-open', 'external', t('keysTip.open', { site: k.site }), () => DL.api.openExternal(k.url), 'open'),
          btn('', 'download', set ? t('keysTip.pasteNew') : t('keysTip.paste'), paste, 'paste'),
          btn('', 'edit', t('keysTip.type'), type, 'type')));
    };

    const build = (body) => {
      const allSet = KEYS.every(isSet);
      body.appendChild(el('p', { class: 'dialog-text keys-intro', text: allSet ? t('keysTip.allSet') : t('keysTip.intro') }));
      body.appendChild(el('div', { class: 'keys-cards' }, ...KEYS.map(card)));
      const row = el('div', { class: 'dialog-buttons keys-buttons' });
      if (fromStart && !allSet) {
        row.appendChild(el('button', { class: 'btn primary', nav: true, data: { action: 'later' }, text: t('keysTip.later'), on: { click: () => close('later') } }));
        row.appendChild(el('button', { class: 'btn', nav: true, data: { action: 'never' }, text: t('keysTip.never'), on: { click: () => close('never') } }));
      } else {
        row.appendChild(el('button', { class: 'btn primary', nav: true, data: { action: 'done' }, text: t('keysTip.done'), on: { click: () => close('done') } }));
      }
      body.appendChild(el('div', { class: 'keys-foot' }, el('p', { class: 'keys-note', text: t('keysTip.note') }), row));
    };

    /** Draws the window again (after a key was saved), keeping the focus where it was. */
    const render = (keyId, action) => {
      if (closed) return;
      sheet.body.textContent = '';
      build(sheet.body);
      DL.nav.refresh();
      const again = sheet.body.querySelector(`[data-key="${keyId}"][data-action="${action}"]`) || sheet.body.querySelector('.keys-buttons [data-nav]');
      if (again) DL.nav.focus(again, { sound: false, force: true });
    };

    sheet = DL.ui.openSheet({
      id: 'keystip',
      cls: 'wide-sheet keys-tip',
      title: t('keysTip.title'),
      build,
      initial: (panel) => {
        const firstMissing = KEYS.find((k) => !isSet(k));
        return (firstMissing && panel.querySelector(`[data-key="${firstMissing.id}"][data-action="open"]`)) || panel.querySelector('.keys-buttons [data-nav]');
      },
      hints: [['confirm', t('hints.select')], ['back', fromStart ? t('keysTip.later') : t('hints.close'), () => { DL.sound.play('back'); close('later', true); }]],
      onBack: () => { DL.sound.play('back'); close('later', true); },
      onClose: () => { closed = true; if (onClose) onClose(); },
    });
    return sheet;
  }

  let shownThisStart = false;

  /**
   * After start-up: shows the window on every start (the first one included) until "Don't show
   * again" was chosen, unless all three keys are already set. It waits until the home screen is
   * free (no other window open, no game running, the tour finished) and then appears.
   */
  function maybeShow() {
    if (readState().never) return;
    const attempt = () => {
      if (shownThisStart || readState().never || KEYS.every(isSet)) return;
      const top = DL.nav.top();
      const tourOn = !!(DL.tour && DL.tour.isRunning());
      const idle = !tourOn && top && top.id === 'dashboard' && !(DL.hub && DL.hub.isOpen()) && !DL.state.gameRunning;
      if (!idle) { setTimeout(attempt, 3000); return; }
      shownThisStart = true;
      open({ fromStart: true });
    };
    setTimeout(attempt, 2500);
  }

  /** The tour shows the window as its last step; then it isn't shown again this start. */
  function openFromTour(onClose, { replay = false } = {}) {
    // Always shown as the tour's last step, also when turned off or when every key is set
    // (then it shows them as set). A replay from the debug menu doesn't save the choice.
    shownThisStart = true;
    const sheet = open({ fromStart: true, preview: replay, onClose });
    if (!sheet && onClose) onClose();
    return sheet;
  }

  /** Forgets "Don't show again" (debug menu). */
  function reset() {
    try { localStorage.removeItem(STORE_KEY); } catch { /* not kept */ }
    shownThisStart = false;
  }

  DL.keysTip = { open, maybeShow, openFromTour, keys, reset, isOff: () => !!readState().never };
})();
