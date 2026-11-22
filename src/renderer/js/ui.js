/* Dream Launcher - shared interface components: sheets, dialogs, on-screen keyboard, option rows. */
(function () {
  'use strict';
  const DL = (window.DL = window.DL || {});
  const { el } = DL;

  function overlaysHost() { return document.getElementById('overlays'); }

  function updateWavesMode() {
    if (!DL.waves) return;
    const open = overlaysHost().children.length > 0;
    DL.waves.setMode(open ? 'calm' : 'dashboard');
    document.body.classList.toggle('has-overlay', open);
  }

  /**
   * Opens a sheet (modal panel) and makes it the active navigation scope.
   * opts: { id, cls, title, subtitle, build(body, sheet), hints: [[action, label, fn]], onBack, onAction, onMove, initial, onClose, sound }
   */
  function openSheet(opts) {
    const host = overlaysHost();
    const backdrop = el('div', { class: 'backdrop' });
    const title = el('h2', { class: 'sheet-title', text: opts.title || '' });
    const subtitle = opts.subtitle ? el('div', { class: 'sheet-sub', text: opts.subtitle }) : null;
    const headExtra = el('div', { class: 'sheet-head-extra' });
    const head = el('div', { class: 'sheet-head' }, el('div', { class: 'sheet-titles' }, title, subtitle), headExtra);
    const body = el('div', { class: 'sheet-body' });
    const foot = el('div', { class: 'sheet-foot' });
    const panel = el('div', { class: `sheet ${opts.cls || ''}` }, head, body, foot);
    const root = el('div', { class: 'overlay', data: { overlay: opts.id || 'sheet' } }, backdrop, panel);
    host.appendChild(root);

    let closed = false;
    const sheet = {
      root, panel, body, head, headExtra, foot, title,
      close(silent) {
        if (closed) return;
        closed = true;
        if (!silent) DL.sound.play('close');
        DL.nav.pop(sheet.scope);
        root.classList.remove('show');
        root.classList.add('hide');
        setTimeout(() => { root.remove(); updateWavesMode(); }, 230);
        if (opts.onClose) opts.onClose();
      },
      setHints(list) {
        foot.textContent = '';
        const left = el('div', { class: 'hints' });
        for (const [action, label, fn] of list) left.appendChild(DL.glyphs.hint(action, label, fn));
        foot.appendChild(left);
        sheet._hints = list;
      },
      get closed() { return closed; },
    };
    backdrop.addEventListener('click', () => (opts.onBack ? opts.onBack() : sheet.close()));
    if (opts.build) opts.build(body, sheet);
    sheet.setHints(opts.hints || [['confirm', DL.t('hints.select')], ['back', DL.t('hints.back'), () => (opts.onBack ? opts.onBack() : sheet.close())]]);
    sheet.scope = {
      id: opts.id || 'sheet',
      root: panel,
      // The sheet object is passed in because `initial` runs before openSheet() returns.
      initial: opts.initial ? () => opts.initial(panel) : undefined,
      onAction: opts.onAction ? (a, f, s) => opts.onAction(a, f, s) : null,
      onMove: opts.onMove || null,
      onBack: () => (opts.onBack ? opts.onBack() : (DL.sound.play('back'), sheet.close(true))),
      onFocus: opts.onFocus || null,
    };
    DL.nav.push(sheet.scope);
    updateWavesMode();
    requestAnimationFrame(() => root.classList.add('show'));
    if (opts.sound !== false) DL.sound.play('open');
    // Glyphs change when switching between keyboard and controller.
    const off = DL.bus.on('inputmode', () => { if (!closed && sheet._hints) sheet.setHints(sheet._hints); });
    const prevClose = sheet.close;
    sheet.close = (silent) => { off(); prevClose(silent); };
    return sheet;
  }

  /** Confirmation dialog. Resolves with the chosen button id (or cancelId when dismissed). */
  function confirm({ title, message, buttons, cancelId = 'cancel' }) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (id) => {
        if (done) return;
        done = true;
        sheet.close(true);
        resolve(id);
      };
      const sheet = openSheet({
        id: 'dialog',
        cls: 'dialog',
        title,
        build(body) {
          if (message) body.appendChild(el('p', { class: 'dialog-text', text: message }));
          const row = el('div', { class: 'dialog-buttons' });
          for (const b of buttons) {
            row.appendChild(el('button', {
              class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`,
              nav: true,
              text: b.label,
              data: { id: b.id },
              on: { click: () => finish(b.id) },
            }));
          }
          body.appendChild(row);
        },
        initial: (panel) => panel.querySelector('.dialog-buttons [data-nav]'),
        onBack: () => { DL.sound.play('back'); finish(cancelId); },
      });
    });
  }

  // ---------------------------------------------------------------- on-screen keyboard
  const OSK_ROWS = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', '-'],
    ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/'],
  ];

  /** Builds an on-screen keyboard that types into `input`. */
  function osk(input, { onDone, onChange } = {}) {
    let shift = false;
    const keys = [];
    const root = el('div', { class: 'osk' });
    const fire = () => {
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (onChange) onChange(input.value);
    };
    const type = (ch) => { input.value += shift ? ch.toUpperCase() : ch; fire(); };
    const backspace = () => { input.value = input.value.slice(0, -1); fire(); };
    const space = () => { input.value += ' '; fire(); };
    const renderKeys = () => { for (const k of keys) k.node.textContent = shift ? k.ch.toUpperCase() : k.ch; shiftKey.classList.toggle('on', shift); };
    for (const row of OSK_ROWS) {
      const r = el('div', { class: 'osk-row' });
      for (const ch of row) {
        const node = el('button', { class: 'osk-key', nav: true, attrs: { 'data-silent': true }, on: { click: () => { DL.sound.play('toggle'); type(ch); } } });
        keys.push({ ch, node });
        r.appendChild(node);
      }
      root.appendChild(r);
    }
    const shiftKey = el('button', { class: 'osk-key wide', nav: true, attrs: { 'data-silent': true, 'aria-label': 'Shift' }, on: { click: () => { DL.sound.play('toggle'); shift = !shift; renderKeys(); } } }, DL.icon('shift'));
    const extra = ['@', '_', ':'].map((ch) => el('button', { class: 'osk-key', nav: true, text: ch, attrs: { 'data-silent': true }, on: { click: () => { DL.sound.play('toggle'); input.value += ch; fire(); } } }));
    const spaceKey = el('button', { class: 'osk-key space', nav: true, attrs: { 'data-silent': true, 'aria-label': 'Space' }, on: { click: () => { DL.sound.play('toggle'); space(); } } }, DL.icon('space'));
    const bsKey = el('button', { class: 'osk-key wide', nav: true, attrs: { 'data-silent': true, 'aria-label': 'Backspace' }, on: { click: () => { DL.sound.play('toggle'); backspace(); } } }, DL.icon('backspace'));
    const doneKey = el('button', { class: 'osk-key done', nav: true, text: DL.t('common.done'), on: { click: () => onDone && onDone() } });
    root.appendChild(el('div', { class: 'osk-row' }, shiftKey, ...extra, spaceKey, bsKey, doneKey));
    renderKeys();
    return { root, backspace, space, first: () => keys[10].node };
  }

  /** Text input sheet. Uses the on-screen keyboard with a controller, normal typing otherwise. */
  function editText({ title, value = '', placeholder = '', hint = '', maxLength = 300 }) {
    return new Promise((resolve) => {
      let done = false;
      const input = el('input', { class: 'text-input', type: 'text', attrs: { placeholder, maxlength: maxLength, spellcheck: 'false', autocomplete: 'off' } });
      input.value = value;
      const pad = DL.state.inputMode === 'gamepad';
      let keyboard = null;
      const finish = (v) => {
        if (done) return;
        done = true;
        input.blur();
        sheet.close(true);
        resolve(v);
      };
      const sheet = openSheet({
        id: 'edit-text',
        cls: 'edit-text',
        title,
        build(body) {
          const field = el('div', { class: 'text-field', nav: true, on: { click: () => { if (DL.state.inputMode !== 'gamepad') input.focus(); } } }, input);
          body.appendChild(field);
          if (hint) body.appendChild(el('p', { class: 'field-hint', text: hint }));
          if (pad) {
            keyboard = osk(input, { onDone: () => { DL.sound.play('select'); finish(input.value); } });
            body.appendChild(keyboard.root);
          } else {
            body.appendChild(el('div', { class: 'dialog-buttons' },
              el('button', { class: 'btn primary', nav: true, text: DL.t('common.save'), on: { click: () => finish(input.value) } }),
              el('button', { class: 'btn', nav: true, text: DL.t('common.cancel'), on: { click: () => finish(null) } })));
          }
        },
        hints: pad
          ? [['confirm', DL.t('hints.type')], ['x', DL.t('hints.delete')], ['info', DL.t('hints.space')], ['menu', DL.t('common.done')], ['back', DL.t('common.cancel')]]
          : [['confirm', DL.t('common.save')], ['back', DL.t('common.cancel')]],
        initial: (panel) => (keyboard ? keyboard.first() : panel.querySelector('.btn.primary')),
        onAction(action) {
          if (!keyboard) return false;
          if (action === 'x') { keyboard.backspace(); DL.sound.play('toggle'); return true; }
          if (action === 'info') { keyboard.space(); DL.sound.play('toggle'); return true; }
          if (action === 'menu') { DL.sound.play('select'); finish(input.value); return true; }
          return false;
        },
        onBack: () => { DL.sound.play('back'); finish(null); },
      });
      input.addEventListener('dl-enter', () => finish(input.value));
      if (!pad) setTimeout(() => { input.focus(); input.select(); }, 60);
    });
  }

  /** List of choices in a sheet. Resolves with the chosen value or null. */
  function choose({ title, options, value }) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; sheet.close(true); resolve(v); };
      const sheet = openSheet({
        id: 'choose',
        cls: 'dialog list',
        title,
        build(body) {
          const list = el('div', { class: 'choice-list', attrs: { 'data-scroll': true } });
          for (const o of options) {
            list.appendChild(el('button', {
              class: `choice ${o.value === value ? 'current' : ''}`,
              nav: true,
              data: { value: String(o.value) },
              on: { click: () => finish(o.value) },
            }, el('span', { text: o.label }), o.value === value ? DL.icon('check', 'choice-check') : null));
          }
          body.appendChild(list);
        },
        initial: (panel) => panel.querySelector('.choice.current') || panel.querySelector('.choice'),
        onBack: () => { DL.sound.play('back'); finish(null); },
      });
    });
  }

  // ---------------------------------------------------------------- option rows
  function rowShell(label, desc, cls, control) {
    const text = el('div', { class: 'row-text' }, el('div', { class: 'row-label', text: label }), desc ? el('div', { class: 'row-desc', text: desc }) : null);
    return el('div', { class: `opt-row ${cls || ''}`, nav: true }, text, control);
  }

  function toggleRow({ label, desc, get, set }) {
    const sw = el('span', { class: 'switch' }, el('span', { class: 'knob' }));
    const row = rowShell(label, desc, 'toggle', sw);
    row.dataset.sound = 'toggle';
    const render = () => sw.classList.toggle('on', !!get());
    row.addEventListener('click', () => { set(!get()); render(); });
    row._dlAdjust = (dir) => {
      const want = dir > 0;
      if (!!get() !== want) { set(want); render(); DL.sound.play('toggle'); }
      return true;
    };
    row._dlRender = render;
    render();
    return row;
  }

  function choiceRow({ label, desc, options, get, set, list = false }) {
    const value = el('span', { class: 'choice-value' });
    const control = el('span', { class: 'choice-control' }, el('span', { class: 'arrow' }, DL.icon('chevronLeft')), value, el('span', { class: 'arrow' }, DL.icon('chevron')));
    const row = rowShell(label, desc, 'choice-row', control);
    const opts = () => (typeof options === 'function' ? options() : options);
    const render = () => {
      const cur = opts().find((o) => o.value === get());
      value.textContent = cur ? cur.label : String(get());
    };
    const step = (dir) => {
      const list2 = opts();
      const idx = Math.max(0, list2.findIndex((o) => o.value === get()));
      const next = list2[(idx + dir + list2.length) % list2.length];
      set(next.value);
      render();
    };
    row.dataset.sound = 'toggle';
    row.addEventListener('click', async () => {
      if (list || opts().length > 4) {
        const v = await choose({ title: label, options: opts(), value: get() });
        if (v !== null && v !== undefined) { set(v); render(); }
      } else {
        step(1);
      }
    });
    // Rows that open a list (language, interface size) are not changed with left/right, so
    // pressing left to go back to the section list never changes them by accident.
    if (!list) row._dlAdjust = (dir) => { step(dir); DL.sound.play('toggle'); return true; };
    row._dlRender = render;
    render();
    return row;
  }

  function sliderRow({ label, desc, get, set, step = 5 }) {
    const fill = el('span', { class: 'slider-fill' });
    const bar = el('span', { class: 'slider' }, fill);
    const num = el('span', { class: 'slider-num' });
    const row = rowShell(label, desc, 'slider-row', el('span', { class: 'slider-control' }, bar, num));
    const render = () => { const v = DL.clamp(Number(get()) || 0, 0, 100); fill.style.width = `${v}%`; num.textContent = `${v}%`; };
    row._dlAdjust = (dir) => { set(DL.clamp((Number(get()) || 0) + dir * step, 0, 100)); render(); DL.sound.play('move'); return true; };
    row.dataset.silent = '';
    row.setAttribute('data-silent', '');
    bar.addEventListener('click', (e) => {
      const r = bar.getBoundingClientRect();
      const v = Math.round(DL.clamp((e.clientX - r.left) / r.width, 0, 1) * 100 / step) * step;
      set(v);
      render();
    });
    row._dlRender = render;
    render();
    return row;
  }

  function actionRow({ label, desc, value, icon = 'chevron', danger = false, onClick }) {
    const val = el('span', { class: 'action-value', text: value || '' });
    const row = rowShell(label, desc, `action-row ${danger ? 'danger' : ''}`, el('span', { class: 'action-control' }, val, DL.icon(icon)));
    row.addEventListener('click', () => onClick && onClick(row));
    row._dlSetValue = (v) => { val.textContent = v || ''; };
    return row;
  }

  function textRow({ label, desc, get, set, placeholder = '', hint = '', display }) {
    const val = el('span', { class: 'action-value' });
    const row = rowShell(label, desc, 'action-row text-row', el('span', { class: 'action-control' }, val, DL.icon('edit')));
    const render = () => {
      const shown = display ? display() : get();
      val.textContent = shown || placeholder || '';
      val.classList.toggle('placeholder', !shown);
    };
    row.addEventListener('click', async () => {
      const v = await editText({ title: label, value: get() || '', placeholder, hint });
      if (v !== null) { await set(v.trim()); render(); }
    });
    row._dlRender = render;
    render();
    return row;
  }

  function infoRow({ label, value }) {
    return el('div', { class: 'opt-row info-row' }, el('div', { class: 'row-text' }, el('div', { class: 'row-label', text: label })), el('span', { class: 'action-value', text: value }));
  }

  function sectionTitle(text) {
    return el('div', { class: 'opt-section', text });
  }

  DL.ui = { openSheet, confirm, osk, editText, choose, toggleRow, choiceRow, sliderRow, actionRow, textRow, infoRow, sectionTitle, updateWavesMode };
})();
