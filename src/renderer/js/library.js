/* Dream Launcher - full library (grid with filters and sorting) and search. */
(function () {
  'use strict';
  const DL = (window.DL = window.DL || {});
  const { el } = DL;

  const SORTS = ['recent', 'alphabetical', 'mostPlayed', 'size'];
  const SOURCE_ORDER = ['steam', 'epic', 'gog', 'ubisoft', 'xbox', 'emulators', 'manual'];

  function card(game, onChoose, { showSize = false } = {}) {
    const img = el('img', { class: 'card-img', attrs: { alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' } });
    const hue = DL.fallbackHue(game.name);
    const art = el('div', { class: 'card-art', style: { background: `linear-gradient(160deg, hsl(${hue} 55% 40%), hsl(${(hue + 40) % 360} 60% 16%))` } },
      el('span', { class: 'card-fallback', text: game.name }), img);
    const cover = game.art && game.art.cover;
    if (cover) {
      img.src = cover;
      img.onerror = () => img.remove();
      if (game.art.coverFit === 'contain') art.classList.add('contain');
    } else {
      img.remove();
    }
    const node = el('button', { class: `card ${game.hidden ? 'is-hidden-game' : ''} ${game.installed ? '' : 'not-installed'}`, nav: true, data: { id: game.id }, on: { click: () => onChoose(game) } },
      art,
      el('div', { class: 'card-badges' }, ...DL.badge(game)),
      game.favorite ? el('span', { class: 'card-fav' }, DL.icon('star')) : null,
      el('div', { class: 'card-name', text: game.name }),
      showSize ? el('span', { class: 'card-size', text: DL.fmt.bytes(game.sizeBytes) || '—' }) : null);
    return node;
  }

  function chooseGame(game, sheet) {
    // Uninstalled games live only in the library: open their menu (Install, ...) instead.
    if (game.status === 'notInstalled') { DL.gameMenu.open(game); return; }
    sheet.close(true);
    DL.sound.play('select');
    DL.dashboard.selectGame(game.id);
  }

  // ---------------------------------------------------------------- library
  function openLibrary() {
    if (DL.nav.has('library')) return;
    let filter = 'all';
    let sort = 'recent';
    let sheet;

    const filters = () => {
      const games = DL.visibleGames();
      const list = [{ id: 'all', label: DL.t('library.all') }, { id: 'installed', label: DL.t('library.installed') }];
      if (games.some((g) => g.favorite)) list.push({ id: 'favorites', label: DL.t('library.favorites') });
      for (const src of SOURCE_ORDER) {
        if (games.some((g) => g.source === src)) list.push({ id: src, label: DL.t(`sources.${src}`) });
      }
      return list;
    };

    const filtered = () => {
      let games = DL.visibleGames();
      if (filter === 'installed') games = games.filter((g) => g.installed);
      else if (filter === 'favorites') games = games.filter((g) => g.favorite);
      else if (filter !== 'all') games = games.filter((g) => g.source === filter);
      const byName = (a, b) => a.sortName.localeCompare(b.sortName);
      if (sort === 'alphabetical') games.sort(byName);
      else if (sort === 'mostPlayed') games.sort((a, b) => (b.playtimeMinutes - a.playtimeMinutes) || byName(a, b));
      else if (sort === 'size') games.sort((a, b) => ((b.installed ? b.sizeBytes || 0 : -1) - (a.installed ? a.sizeBytes || 0 : -1)) || byName(a, b));
      else games.sort((a, b) => (b.lastPlayed - a.lastPlayed) || (Number(b.installed) - Number(a.installed)) || byName(a, b));
      return games;
    };

    const render = (body) => {
      const focusedId = DL.nav.focused() && DL.nav.focused().dataset.id;
      body.textContent = '';
      const fl = filters();
      if (!fl.some((f) => f.id === filter)) filter = 'all';
      const chips = el('div', { class: 'chips' }, ...fl.map((f) => el('button', {
        class: `chip ${f.id === filter ? 'active' : ''}`, nav: true, text: f.label, data: { filter: f.id },
        on: { click: () => { if (filter !== f.id) { filter = f.id; render(body); DL.nav.refresh(); } } },
      })));
      const sortBtn = el('button', { class: 'chip sort', nav: true, on: { click: () => cycleSort(body) } }, DL.icon('refresh'), el('span', { text: DL.t(`library.sort.${sort}`) }));
      body.appendChild(el('div', { class: 'lib-toolbar' }, chips, sortBtn));
      const games = filtered();
      sheet.title.textContent = DL.t('library.title');
      sheet.headExtra.textContent = DL.t('home.gamesCount', { n: DL.fmt.number(games.length), count: games.length });
      const grid = el('div', { class: 'card-grid', attrs: { 'data-scroll': true } });
      for (const g of games) grid.appendChild(card(g, (game) => chooseGame(game, sheet), { showSize: sort === 'size' }));
      if (!games.length) grid.appendChild(el('div', { class: 'empty-note', text: DL.t('library.empty') }));
      body.appendChild(grid);
      if (focusedId && sheet && sheet.scope && DL.nav.top() === sheet.scope) {
        const again = body.querySelector(`[data-id="${CSS.escape(focusedId)}"]`);
        if (again) DL.nav.focus(again, { sound: false, force: true });
      }
    };

    const cycleSort = (body) => {
      sort = SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length];
      DL.sound.play('toggle');
      render(body);
      DL.nav.refresh();
    };

    const cycleFilter = (dir) => {
      const fl = filters();
      const i = fl.findIndex((f) => f.id === filter);
      filter = fl[(i + dir + fl.length) % fl.length].id;
      DL.sound.play('toggle');
      render(sheet.body);
      const first = sheet.body.querySelector('.card');
      DL.nav.focus(first || sheet.body.querySelector('.chip.active'), { sound: false, force: true });
    };

    sheet = DL.ui.openSheet({
      id: 'library',
      cls: 'full',
      title: DL.t('library.title'),
      build: (body, s) => { sheet = s; render(body); },
      initial: (panel) => panel.querySelector('.card') || panel.querySelector('.chip'),
      hints: [
        ['confirm', DL.t('hints.select')],
        ['menu', DL.t('hints.gameOptions')],
        ['lb', DL.t('hints.filter')],
        ['x', DL.t('hints.sort'), () => cycleSort(sheet.body)],
        ['back', DL.t('hints.back')],
      ],
      onAction(action, focused) {
        if (action === 'lb' || action === 'rb') { cycleFilter(action === 'rb' ? 1 : -1); return true; }
        if (action === 'x') { cycleSort(sheet.body); return true; }
        if (action === 'menu' && focused && focused.classList.contains('card')) {
          const g = DL.state.byId.get(focused.dataset.id);
          if (g) DL.gameMenu.open(g);
          return true;
        }
        if (action === 'view') { sheet.close(true); DL.search.open(); return true; }
        if (action === 'lt' || action === 'rt') {
          const grid = sheet.body.querySelector('.card-grid');
          if (grid) grid.scrollBy({ top: (action === 'rt' ? 1 : -1) * grid.clientHeight * 0.8 });
          return true;
        }
        return false;
      },
    });
    const off = DL.bus.on('library', () => { if (!sheet.closed) { render(sheet.body); DL.nav.refresh(); } else off(); });
  }

  // ---------------------------------------------------------------- search
  function normalize(s) {
    return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  function searchGames(query) {
    const q = normalize(query);
    if (!q) return [];
    const compact = q.replace(/ /g, '');
    const out = [];
    for (const g of DL.visibleGames()) {
      const n = normalize(g.name);
      let score = -1;
      if (n.startsWith(q)) score = 0;
      else if (n.split(' ').some((w) => w.startsWith(q))) score = 1;
      else if (n.includes(q)) score = 2;
      else if (n.replace(/ /g, '').includes(compact)) score = 3;
      else {
        const initials = n.split(' ').map((w) => w[0]).join('');
        if (compact.length >= 2 && initials.startsWith(compact)) score = 4;
      }
      if (score >= 0) out.push({ g, score });
    }
    out.sort((a, b) => a.score - b.score || (b.g.lastPlayed - a.g.lastPlayed) || a.g.sortName.localeCompare(b.g.sortName));
    return out.slice(0, 40).map((x) => x.g);
  }

  function openSearch() {
    if (DL.nav.has('search')) return;
    const pad = DL.state.inputMode === 'gamepad';
    const input = el('input', { class: 'text-input big', type: 'text', attrs: { placeholder: DL.t('search.placeholder'), spellcheck: 'false', autocomplete: 'off' } });
    let results;
    let keyboard = null;
    let sheet;
    const update = () => {
      results.textContent = '';
      const list = searchGames(input.value);
      if (!input.value.trim()) results.appendChild(el('div', { class: 'empty-note', text: DL.t('search.hint') }));
      else if (!list.length) results.appendChild(el('div', { class: 'empty-note', text: DL.t('search.none') }));
      for (const g of list) results.appendChild(card(g, (game) => chooseGame(game, sheet)));
    };
    sheet = DL.ui.openSheet({
      id: 'search',
      cls: `full search ${pad ? 'with-osk' : ''}`,
      title: DL.t('search.title'),
      build(body, s) {
        sheet = s;
        input.addEventListener('input', update);
        input.addEventListener('dl-enter', () => {
          const first = results.querySelector('.card');
          if (first) first.click();
        });
        const field = el('div', { class: 'text-field search-field', nav: true, on: { click: () => { if (DL.state.inputMode !== 'gamepad') input.focus(); } } }, DL.icon('search', 'field-icon'), input);
        results = el('div', { class: 'card-grid results', attrs: { 'data-scroll': true } });
        const left = el('div', { class: 'search-left' }, field);
        if (pad) {
          keyboard = DL.ui.osk(input, { onDone: () => { const first = results.querySelector('.card'); if (first) DL.nav.focus(first); } });
          left.appendChild(keyboard.root);
        }
        body.appendChild(el('div', { class: 'search-layout' }, left, results));
        update();
      },
      initial: (panel) => (keyboard ? keyboard.first() : panel.querySelector('.search-field')),
      hints: pad
        ? [['confirm', DL.t('hints.select')], ['x', DL.t('hints.delete')], ['info', DL.t('hints.space')], ['back', DL.t('hints.close')]]
        : [['confirm', DL.t('hints.select')], ['back', DL.t('hints.close')]],
      onAction(action) {
        if (!keyboard) return false;
        if (action === 'x') { keyboard.backspace(); DL.sound.play('toggle'); return true; }
        if (action === 'info') { keyboard.space(); DL.sound.play('toggle'); return true; }
        return false;
      },
    });
    if (!pad) setTimeout(() => input.focus(), 60);
  }

  DL.library = { open: openLibrary, searchGames };
  DL.search = { open: openSearch };
})();
