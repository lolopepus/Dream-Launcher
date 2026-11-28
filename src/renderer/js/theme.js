/*
 * Dream Launcher - colour themes.
 * A theme colours the background (gradient, glows and the shade behind text), the waves and the
 * highlights (glow around the selected game and card). "Game colour" takes the colour from the
 * selected game's cover (the original look); the others stay the same for every game.
 * The picker previews each theme on the whole screen while you move over it.
 */
(function () {
  'use strict';
  const DL = (window.DL = window.DL || {});
  const { el } = DL;
  const t = (k, p) => DL.t(k, p);

  const DEFAULT_ACCENT = [120, 104, 255];

  /** Fixed calm themes. glow: how strong the coloured glows are; white/strength: the waves. */
  const CALM = {
    darkblue: { accent: [70, 130, 240], bg1: '#0a1a3f', bg2: '#0b1432', bg3: '#040814', low: 'rgba(40, 100, 230, 0.30)', shade: [4, 9, 22], glow: 0.9, white: 0.45, strength: 0.9 },
    black: { accent: [175, 175, 185], bg1: '#16171b', bg2: '#0f1013', bg3: '#060607', low: 'rgba(130, 130, 145, 0.10)', shade: [8, 8, 10], glow: 0.45, white: 0.55, strength: 0.7 },
    oled: { accent: [140, 140, 150], bg1: '#000000', bg2: '#000000', bg3: '#000000', low: 'rgba(0, 0, 0, 0)', shade: [0, 0, 0], glow: 0, white: 0.5, strength: 0.5 },
    graphite: { accent: [150, 160, 180], bg1: '#2b2e34', bg2: '#1e2025', bg3: '#0f1013', low: 'rgba(150, 160, 180, 0.14)', shade: [15, 16, 19], glow: 0.6, white: 0.5, strength: 0.8 },
  };
  /** Colourful themes: the background is a deep shade of the colour. */
  const COLOURFUL = {
    purple: [150, 95, 255],
    blue: [45, 125, 255],
    cyan: [0, 200, 225],
    green: [45, 205, 110],
    yellow: [255, 205, 40],
    orange: [255, 140, 45],
    red: [240, 65, 75],
    pink: [255, 85, 175],
  };
  const GROUPS = [
    { id: 'special', ids: ['game'] },
    { id: 'calm', ids: Object.keys(CALM) },
    { id: 'colourful', ids: Object.keys(COLOURFUL) },
  ];
  const IDS = GROUPS.flatMap((g) => g.ids);

  const mix = (c, base, f) => c.map((v, i) => Math.round(v * f + base[i] * (1 - f)));
  const hex = (c) => `#${c.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;

  let gameRgb = null; // colour of the selected game's cover
  let previewing = null;

  /** Everything a theme sets. */
  function resolve(id) {
    if (CALM[id]) return { id, ...CALM[id] };
    if (COLOURFUL[id]) {
      const rgb = COLOURFUL[id];
      return {
        id,
        accent: rgb,
        bg1: hex(mix(rgb, [6, 7, 16], 0.26)),
        bg2: hex(mix(rgb, [4, 4, 10], 0.15)),
        bg3: hex(mix(rgb, [2, 2, 6], 0.06)),
        low: `rgba(${rgb.join(', ')}, 0.24)`,
        shade: mix(rgb, [3, 3, 8], 0.07),
        glow: 1,
        white: 0.32,
        strength: 1,
      };
    }
    // Game colour: the original dark blue background with the cover's colour.
    return {
      id: 'game', accent: gameRgb || DEFAULT_ACCENT,
      bg1: '#0b1240', bg2: '#1a0f3d', bg3: '#06091c', low: 'rgba(70, 90, 255, 0.34)', shade: [6, 10, 28],
      glow: 1, white: 0.45, strength: 1,
    };
  }

  function paint(theme) {
    const root = document.documentElement.style;
    const a = theme.accent.map((v) => Math.round(v));
    root.setProperty('--accent', a.join(', '));
    root.setProperty('--glow', `rgba(${a.join(', ')}, ${theme.glow})`);
    root.setProperty('--bg1', theme.bg1);
    root.setProperty('--bg2', theme.bg2);
    root.setProperty('--bg3', theme.bg3);
    root.setProperty('--bg-low', theme.low);
    root.setProperty('--shade', `rgb(${theme.shade.join(', ')})`);
    document.documentElement.dataset.theme = theme.id;
    if (DL.waves) DL.waves.setTint(a, { white: theme.white, strength: theme.strength });
  }

  const active = () => {
    const id = DL.state.settings && DL.state.settings.theme;
    return IDS.includes(id) ? id : 'game';
  };

  /** The colours of the current theme (or the one being previewed). */
  function apply() { paint(resolve(previewing || active())); }

  /** Shows a theme on the whole screen without saving it. */
  function preview(id) {
    previewing = IDS.includes(id) ? id : null;
    apply();
  }

  function endPreview() {
    previewing = null;
    apply();
  }

  /** The selected game's cover colour (null: none). Only "Game colour" uses it. */
  function setGameColor(rgb) {
    gameRgb = rgb && rgb.length === 3 ? rgb : null;
    if ((previewing || active()) === 'game') apply();
  }

  const nameOf = (id) => t(`theme.names.${id}`);

  // ---------------------------------------------------------------- swatches

  /** Small picture of a theme: its background, glow and three wave lines. */
  function mini(id) {
    const th = resolve(id);
    const node = el('span', { class: `theme-mini ${id === 'game' ? 'is-game' : ''}` });
    const a = th.accent.join(', ');
    node.style.background = id === 'game'
      ? 'radial-gradient(90% 90% at 75% 15%, rgba(255, 255, 255, 0.18), transparent 60%), conic-gradient(from 210deg at 60% 60%, #ff6b8b, #ffb347, #ffe66d, #5ee08a, #4cc9ff, #8b7bff, #ff6b8b)'
      : `radial-gradient(120% 90% at 80% 10%, rgba(${a}, ${0.42 * th.glow}), transparent 62%), radial-gradient(90% 80% at 5% 100%, ${th.low}, transparent 65%), linear-gradient(160deg, ${th.bg1} 0%, ${th.bg2} 45%, ${th.bg3} 100%)`;
    const w = mix(th.accent, [255, 255, 255], 1 - th.white);
    const stroke = `rgba(${w.join(', ')}, ${Math.max(0.35, 0.85 * th.strength)})`;
    const paths = [0, 1, 2].map((i) => {
      const y = 62 + i * 7;
      return `<path d="M0 ${y} C 30 ${y - 16}, 60 ${y + 14}, 100 ${y - 6} S 160 ${y + 10}, 200 ${y - 8}" fill="none" stroke="${stroke}" stroke-width="1.6" opacity="${1 - i * 0.25}"/>`;
    }).join('');
    const waves = el('span', { class: 'theme-waves' });
    waves.innerHTML = `<svg viewBox="0 0 200 100" preserveAspectRatio="none">${paths}</svg>`;
    node.appendChild(waves);
    if (id === 'game') node.appendChild(el('span', { class: 'theme-game-mark' }, DL.icon('image')));
    return node;
  }

  /**
   * The grid of themes, grouped. `onPick(id)` when one is chosen; while moving over them the screen
   * shows each one (the caller's sheet passes focus changes to `previewFrom`).
   */
  function grid({ selected, onPick }) {
    const wrap = el('div', { class: 'theme-groups' });
    for (const group of GROUPS) {
      const box = el('div', { class: `theme-group group-${group.id}` });
      box.appendChild(el('div', { class: 'theme-group-title', text: t(`theme.groups.${group.id}`) }));
      const items = el('div', { class: 'theme-grid' });
      for (const id of group.ids) {
        const on = id === selected;
        items.appendChild(el('button', {
          class: `theme-swatch ${on ? 'selected' : ''}`, nav: true, data: { theme: id },
          attrs: { 'aria-label': nameOf(id) },
          on: { click: () => onPick(id) },
        }, mini(id), el('span', { class: 'theme-name' }, el('span', { text: nameOf(id) }), on ? DL.icon('check') : null),
        id === 'game' ? el('span', { class: 'theme-desc', text: t('theme.gameDesc') }) : null));
      }
      box.appendChild(items);
      wrap.appendChild(box);
    }
    return wrap;
  }

  /** Previews the theme of a focused swatch (for sheets that hold a grid). */
  function previewFrom(node) {
    const id = node && node.dataset && node.dataset.theme;
    if (id) preview(id);
  }

  // ---------------------------------------------------------------- picker

  /**
   * Opens the colour picker. While it is open the other windows step aside, so the whole launcher
   * shows the theme being looked at. A / Enter keeps it, B / Esc goes back to the old one.
   */
  function openPicker({ onDone } = {}) {
    const before = active();
    let sheet;
    let done = false;
    const finish = async (id) => {
      if (done) return;
      done = true;
      document.body.classList.remove('theme-preview');
      if (id && id !== before) {
        await DL.saveSettings({ theme: id });
        DL.sound.play('toggle');
      }
      endPreview();
      sheet.close(true);
      if (onDone) onDone(id || before);
    };
    document.body.classList.add('theme-preview');
    sheet = DL.ui.openSheet({
      id: 'theme',
      cls: 'side theme-sheet',
      title: t('theme.title'),
      subtitle: t('theme.subtitle'),
      build(body) {
        body.appendChild(el('div', { class: 'theme-scroll', attrs: { 'data-scroll': true } }, grid({ selected: before, onPick: (id) => finish(id) })));
      },
      initial: (panel) => panel.querySelector('.theme-swatch.selected') || panel.querySelector('.theme-swatch'),
      onFocus: previewFrom,
      hints: [['confirm', t('theme.keep')], ['back', t('hints.back'), () => { DL.sound.play('back'); finish(null); }]],
      onBack: () => { DL.sound.play('back'); finish(null); },
      onClose: () => { document.body.classList.remove('theme-preview'); if (!done) { done = true; endPreview(); } },
    });
    return sheet;
  }

  DL.theme = { apply, preview, endPreview, setGameColor, grid, previewFrom, openPicker, nameOf, resolve, ids: IDS, groups: GROUPS };
})();
