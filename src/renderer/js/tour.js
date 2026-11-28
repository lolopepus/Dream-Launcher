/*
 * Dream Launcher - the tour: a short walk through the launcher on the first start (and once after
 * updating to a version with a new tour). Each step lights up a part of the real screen and
 * explains it. The tour can't be skipped: it is short, and if the launcher is closed halfway it
 * starts again next time. One step lets you pick the colours (shown live on the whole launcher),
 * and the last one is the API keys window.
 */
(function () {
  'use strict';
  const DL = (window.DL = window.DL || {});
  const { el } = DL;
  const t = (k, p) => DL.t(k, p);

  // Raised when the tour changes enough that everyone should see it again.
  const TOUR_VERSION = '2.5';
  const STORE_KEY = 'dl.tourSeen';

  const seenVersion = () => { try { return localStorage.getItem(STORE_KEY) || ''; } catch { return ''; } };
  const markSeen = () => { try { localStorage.setItem(STORE_KEY, TOUR_VERSION); } catch { /* not kept */ } };

  const $ = (sel) => document.querySelector(sel);
  const visible = (node) => {
    if (!node) return false;
    const r = node.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).opacity !== '0';
  };

  /** The steps. `target` finds the part of the screen to light up (none: no light, card only). */
  const STEPS = [
    { id: 'games', target: () => $('#row'), place: 'above', pad: 18 },
    { id: 'more', target: () => $('#hub-peek'), place: 'above', pad: 12, needs: () => (DL.state.games || []).length > 0 },
    { id: 'library', target: () => $('#row .library-tile'), place: 'above-right', pad: 14 },
    { id: 'top', target: () => $('#dashboard .top-right'), place: 'below-right', pad: 14 },
    { id: 'colours', place: 'side' },
    { id: 'keys', place: 'keys' },
  ];

  let running = false;

  /** Where an element is on the stage (the interface is drawn on a scaled 1920×1080 stage). */
  function stageRect(node) {
    const stage = document.getElementById('stage');
    const sr = stage.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    const s = (DL.stage && DL.stage.s) || 1;
    return { x: (r.left - sr.left) / s, y: (r.top - sr.top) / s, w: r.width / s, h: r.height / s };
  }

  /**
   * Runs the tour. `replay` (debug menu): shows it again without changing whether it was seen.
   * `onDone` runs when it is over (after the API keys window).
   */
  function start({ replay = false, onDone } = {}) {
    if (running) return;
    running = true;
    const stage = document.getElementById('stage');
    const steps = STEPS.filter((s) => (!s.needs || s.needs()) && (!s.target || visible(s.target())));
    const total = steps.length;
    let index = 0;
    let scope = null;

    const hole = el('div', { class: 'tour-hole' });
    const stepNo = el('div', { class: 'tour-stepno' });
    const title = el('h3', { class: 'tour-title' });
    const text = el('p', { class: 'tour-text' });
    const extra = el('div', { class: 'tour-extra' });
    const back = el('button', { class: 'btn tour-back', nav: true, data: { sound: 'back' }, on: { click: () => go(-1) } });
    const next = el('button', { class: 'btn primary tour-next', nav: true, on: { click: () => go(1) } });
    const card = el('div', { class: 'tour-card' }, stepNo, title, text, extra, el('div', { class: 'tour-buttons' }, back, next));
    const layer = el('div', { class: 'tour', attrs: { role: 'dialog', 'aria-modal': 'true' } }, hole, card);
    stage.appendChild(layer);
    document.body.classList.add('touring');

    const finish = () => {
      if (!running) return;
      running = false;
      document.body.classList.remove('touring');
      if (scope) DL.nav.pop(scope);
      scope = null;
      layer.classList.remove('show');
      setTimeout(() => layer.remove(), 260);
      DL.theme.endPreview();
      if (onDone) onDone();
    };

    /** Places the light and the card for the current step. */
    const layout = () => {
      const step = steps[index];
      const node = step.target ? step.target() : null;
      layer.dataset.place = step.place;
      if (node && visible(node)) {
        const r = stageRect(node);
        const pad = step.pad || 12;
        Object.assign(hole.style, { left: `${r.x - pad}px`, top: `${r.y - pad}px`, width: `${r.w + pad * 2}px`, height: `${r.h + pad * 2}px` });
        layer.classList.add('has-hole');
        const sw = (DL.stage && DL.stage.w) || 1920;
        const sh = (DL.stage && DL.stage.h) || 1080;
        const cw = 640;
        const ch = card.offsetHeight || 260;
        let x;
        let y;
        if (step.place === 'below-right') {
          x = r.x + r.w - cw;
          y = r.y + r.h + pad + 26;
        } else if (step.place === 'above-right') {
          x = r.x + r.w - cw;
          y = r.y - pad - 26 - ch;
        } else {
          x = r.x + Math.min(40, r.w / 2);
          y = r.y - pad - 26 - ch;
        }
        x = Math.max(48, Math.min(sw - cw - 48, x));
        y = Math.max(40, Math.min(sh - ch - 40, y));
        Object.assign(card.style, { left: `${x}px`, top: `${y}px`, right: '', bottom: '' });
      } else {
        layer.classList.remove('has-hole');
        Object.assign(card.style, { left: '', top: '', right: '', bottom: '' });
      }
    };

    const render = () => {
      const step = steps[index];
      if (step.id === 'keys') {
        // Last step: the API keys window. The tour counts as seen from here on.
        if (!replay) markSeen();
        layer.classList.remove('show');
        layer.classList.add('handoff');
        if (scope) { DL.nav.pop(scope); scope = null; }
        const done = () => finish();
        const win = DL.keysTip.openFromTour(done, { replay });
        if (!win) done();
        return;
      }
      stepNo.textContent = t('tour.step', { n: index + 1, total });
      title.textContent = t(`tour.${step.id}.title`);
      text.textContent = t(`tour.${step.id}.text`);
      extra.textContent = '';
      if (step.id === 'colours') {
        const current = (DL.state.settings && DL.state.settings.theme) || 'game';
        extra.appendChild(DL.theme.grid({
          selected: current,
          onPick: async (id) => {
            await DL.saveSettings({ theme: id });
            DL.sound.play('toggle');
            render();
            const again = extra.querySelector(`[data-theme="${id}"]`);
            if (again) DL.nav.focus(again, { sound: false, force: true });
          },
        }));
      }
      back.textContent = t('tour.back');
      back.hidden = index === 0;
      next.textContent = index === total - 2 && steps[total - 1].id === 'keys' ? t('tour.toKeys') : t('tour.next');
      layout();
      DL.nav.refresh();
    };

    function go(dir) {
      const to = index + dir;
      if (to < 0) { DL.sound.play('error'); return; }
      if (to >= total) { if (!replay) markSeen(); finish(); return; }
      index = to;
      if (dir > 0) DL.sound.play('select');
      render();
      DL.nav.focus(steps[index].id === 'colours' ? (extra.querySelector('.theme-swatch.selected') || next) : next, { sound: false, force: true });
    }

    scope = DL.nav.push({
      id: 'tour',
      root: layer,
      initial: () => next,
      // Moving over a colour shows it; anything else shows the saved one.
      onFocus: (node) => {
        if (steps[index] && steps[index].id === 'colours') {
          if (node && node.dataset && node.dataset.theme) DL.theme.preview(node.dataset.theme);
          else DL.theme.endPreview();
        }
      },
      // Colour step: down from the last row of colours goes to "Next" (not "Back").
      onMove: (dir, node) => {
        if (dir !== 'down' || !node || !node.dataset || !node.dataset.theme) return false;
        const r = node.getBoundingClientRect();
        const below = [...extra.querySelectorAll('.theme-swatch')].some((s) => s.getBoundingClientRect().top > r.bottom - 4);
        if (below) return false;
        DL.nav.focus(next);
        return true;
      },
      // Only moving, confirming and going back do something: nothing else opens during the tour.
      onAction: (action) => !['up', 'down', 'left', 'right', 'confirm', 'back'].includes(action),
      onBack: () => go(-1),
    });
    render();
    requestAnimationFrame(() => { layer.classList.add('show'); layout(); });
    const off = DL.bus.on('stage', () => { if (running) layout(); else off(); });
  }

  /** On start-up: the tour runs if this version's tour hasn't been seen yet. */
  const shouldRun = () => seenVersion() !== TOUR_VERSION;

  /** Forgets that the tour was seen (debug menu: shows it at the next start). */
  function reset() { try { localStorage.removeItem(STORE_KEY); } catch { /* not kept */ } }

  DL.tour = { start, shouldRun, reset, isRunning: () => running, VERSION: TOUR_VERSION };
})();
