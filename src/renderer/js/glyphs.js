/* Dream Launcher - button glyphs for Xbox, PlayStation, Nintendo controllers and the keyboard. */
(function () {
  'use strict';
  const DL = (window.DL = window.DL || {});

  // Physical position of each logical action (standard gamepad layout).
  // confirm/back depend on the "Confirm button" setting (Nintendo controllers confirm with the right button).
  function position(action) {
    const right = DL.glyphs.confirmIsRight();
    switch (action) {
      case 'confirm': return right ? 'right' : 'bottom';
      case 'back': return right ? 'bottom' : 'right';
      case 'x': return 'left';
      case 'info': return 'top';
      default: return action; // menu, view, lb, rb, lt, rt
    }
  }

  const FACE = {
    xbox: {
      bottom: { text: 'A', color: '#3fbf5b' },
      right: { text: 'B', color: '#e24a4a' },
      left: { text: 'X', color: '#3a8bff' },
      top: { text: 'Y', color: '#f4c430', dark: true },
    },
    nintendo: {
      bottom: { text: 'B' },
      right: { text: 'A' },
      left: { text: 'Y' },
      top: { text: 'X' },
    },
  };

  const PS_SYMBOL = {
    bottom: '<svg viewBox="0 0 20 20"><path d="M5 5l10 10M15 5L5 15" stroke="#8fb5ff" stroke-width="2.4" stroke-linecap="round" fill="none"/></svg>',
    right: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="5.6" stroke="#ff6b6b" stroke-width="2.3" fill="none"/></svg>',
    left: '<svg viewBox="0 0 20 20"><rect x="4.8" y="4.8" width="10.4" height="10.4" rx="1" stroke="#ff8ad8" stroke-width="2.2" fill="none"/></svg>',
    top: '<svg viewBox="0 0 20 20"><path d="M10 4.2l6 10.4H4z" stroke="#4fd1a5" stroke-width="2.2" stroke-linejoin="round" fill="none"/></svg>',
  };

  const XBOX_MENU = '<svg viewBox="0 0 20 20" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><path d="M5 6.5h10M5 10h10M5 13.5h10"/></svg>';
  const XBOX_VIEW = '<svg viewBox="0 0 20 20" fill="none" stroke="#fff" stroke-width="1.8"><rect x="4" y="6.5" width="8.5" height="7" rx="1.2"/><path d="M7.5 6.5V5.5a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-2.5"/></svg>';

  const KEYS = {
    confirm: 'Enter', back: 'Esc', x: 'X', info: 'I', menu: 'M', view: 'F', lb: 'Q', rb: 'E', lt: 'PgUp', rt: 'PgDn',
    down: '↓', up: '↑', leftright: '← →',
  };
  const DPAD = {
    down: '<svg viewBox="0 0 20 20" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 8l4.5 4.5L14.5 8"/></svg>',
    up: '<svg viewBox="0 0 20 20" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 12l4.5-4.5 4.5 4.5"/></svg>',
    leftright: '<svg viewBox="0 0 20 20" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 6l-4 4 4 4M13 6l4 4-4 4"/></svg>',
  };

  DL.glyphs = {
    /** Which glyph style to show right now. */
    kind() {
      const s = DL.state.settings || {};
      if (s.buttonGlyphs && s.buttonGlyphs !== 'auto') return s.buttonGlyphs;
      if (DL.state.inputMode !== 'gamepad') return 'keyboard';
      const k = DL.state.padKind;
      return k === 'playstation' || k === 'nintendo' ? k : 'xbox';
    },
    confirmIsRight() {
      const s = DL.state.settings || {};
      if (s.confirmButton === 'right') return true;
      if (s.confirmButton === 'bottom') return false;
      return DL.state.padKind === 'nintendo' && DL.state.inputMode === 'gamepad';
    },
    position,
    /** Returns an element showing the button for a logical action. */
    render(action) {
      const kind = DL.glyphs.kind();
      const pos = position(action);
      if (action === 'lbrb') {
        return DL.el('span', { class: 'glyph-pair' }, DL.glyphs.render('lb'), DL.glyphs.render('rb'));
      }
      if (DPAD[action] && kind !== 'keyboard') {
        const n = DL.el('span', { class: 'glyph round dpad' });
        n.appendChild(DL.svg(DPAD[action]));
        return n;
      }
      if (kind === 'keyboard') {
        return DL.el('span', { class: 'glyph key', text: KEYS[action] || action });
      }
      if (['bottom', 'right', 'left', 'top'].includes(pos)) {
        if (kind === 'playstation') {
          const n = DL.el('span', { class: 'glyph ps' });
          n.appendChild(DL.svg(PS_SYMBOL[pos]));
          return n;
        }
        const f = (FACE[kind] || FACE.xbox)[pos];
        const n = DL.el('span', { class: `glyph face ${kind}${f.dark ? ' dark' : ''}`, text: f.text });
        if (f.color) n.style.background = f.color;
        return n;
      }
      if (pos === 'menu' || pos === 'view') {
        if (kind === 'xbox') {
          const n = DL.el('span', { class: 'glyph round' });
          n.appendChild(DL.svg(pos === 'menu' ? XBOX_MENU : XBOX_VIEW));
          return n;
        }
        if (kind === 'playstation') return DL.el('span', { class: 'glyph pill', text: pos === 'menu' ? 'OPTIONS' : 'CREATE' });
        return DL.el('span', { class: 'glyph round', text: pos === 'menu' ? '+' : '−' });
      }
      const shoulder = {
        xbox: { lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT' },
        playstation: { lb: 'L1', rb: 'R1', lt: 'L2', rt: 'R2' },
        nintendo: { lb: 'L', rb: 'R', lt: 'ZL', rt: 'ZR' },
      };
      return DL.el('span', { class: 'glyph pill', text: (shoulder[kind] || shoulder.xbox)[pos] || pos.toUpperCase() });
    },
    /** A hint: glyph + label, clickable for mouse users. */
    hint(action, label, onClick) {
      const node = DL.el('span', { class: 'hint' }, DL.glyphs.render(action), DL.el('span', { text: label }));
      if (onClick) {
        node.classList.add('clickable');
        node.addEventListener('click', onClick);
      }
      return node;
    },
  };
})();
