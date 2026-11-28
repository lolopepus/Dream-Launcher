/* Dream Launcher - the home dashboard: top bar, selected game, tile row, slide-down hub, footer hints. */
(function () {
  'use strict';
  const DL = (window.DL = window.DL || {});
  const { el } = DL;

  const LIBRARY_TILE = '__library__';
  const TILE_TARGET_H = 236;

  let root;
  let rowEl;
  let scope;
  let rowSize = 8;
  let rowGames = [];
  let tiles = [];
  let index = 0;
  const tileById = new Map();
  let detailsTimer = null;
  let bgTimer = null;
  let pointerDownAt = 0;
  let justSelectedByPointer = false;
  const accentCache = new Map();

  window.addEventListener('pointerdown', () => { pointerDownAt = performance.now(); }, true);

  // ------------------------------------------------------------------ layout
  /**
   * Fits the tile row to the stage width: picks the number of tiles whose height is closest to
   * the design size, then sizes them so the row fills the width exactly. Also places the game
   * info and the slide-down hub. All values are stage pixels, set as CSS variables.
   */
  function layout() {
    const st = DL.stage || { w: 1920, h: 1080 };
    const W = st.w;
    const H = st.h;
    const avail = W - 176;
    const gap = 18;
    const hMax = Math.min(300, H - 540);
    let best = null;
    for (let g = 3; g <= 16; g++) {
      const h = (avail - g * gap) / (1.78 + (g * 2) / 3);
      if (h > hMax) continue;
      if (h < 150) break;
      const score = Math.abs(h - TILE_TARGET_H);
      if (!best || score < best.score) best = { g, h, score };
    }
    if (!best) best = { g: 3, h: Math.max(150, Math.min(hMax, 200)) };
    const tileH = Math.floor(best.h);
    const tileW = Math.floor((tileH * 2) / 3);
    const selW = Math.floor(avail - best.g * (tileW + gap));
    rowSize = best.g;
    const rowTop = H - 118 - tileH;
    const availV = rowTop - 36 - 108;
    const logoH = DL.clamp(availV - 196 - 60, 110, 200);
    const heroTop = 108 + Math.max(14, (availV - 196 - logoH) * 0.45);
    const rowScale = 0.82;
    const liftTop = 136;
    const hubTop = liftTop + tileH * rowScale + 34;
    const hubH = H - 100 - hubTop;
    const v = root.style;
    v.setProperty('--tile-h', `${tileH}px`);
    v.setProperty('--tile-w', `${tileW}px`);
    v.setProperty('--tile-sel-w', `${selW}px`);
    v.setProperty('--tile-gap', `${gap}px`);
    v.setProperty('--hero-top', `${Math.round(heroTop)}px`);
    v.setProperty('--logo-h', `${Math.round(logoH)}px`);
    v.setProperty('--title-scale', String(Math.min(1, logoH / 190)));
    v.setProperty('--row-lift', `${Math.round(liftTop - rowTop)}px`);
    v.setProperty('--hub-top', `${Math.round(hubTop)}px`);
    v.setProperty('--hub-h', `${Math.round(hubH)}px`);
    root.style.setProperty('--row-scale', String(rowScale));
    root.classList.toggle('hub-compact', hubH < 380);
    DL.state.logoMaxH = logoH;
  }

  // ------------------------------------------------------------------ data
  /** Games for the home row: installed games only (uninstalled ones are in the library). */
  function homeGames() {
    const s = DL.state.settings;
    const list = DL.state.games.filter((g) => !g.hidden && g.status !== 'notInstalled');
    const recent = (a, b) => (b.lastPlayed - a.lastPlayed) || a.sortName.localeCompare(b.sortName);
    switch (s.homeOrder) {
      case 'mostPlayed': list.sort((a, b) => (b.playtimeMinutes - a.playtimeMinutes) || recent(a, b)); break;
      case 'alphabetical': list.sort((a, b) => a.sortName.localeCompare(b.sortName)); break;
      case 'favorites': list.sort((a, b) => (Number(b.favorite) - Number(a.favorite)) || recent(a, b)); break;
      default: list.sort(recent);
    }
    let picked = list.slice(0, rowSize);
    const pinned = DL.state.pinnedId && DL.state.byId.get(DL.state.pinnedId);
    if (pinned && pinned.status !== 'notInstalled' && !picked.some((g) => g.id === pinned.id)) picked = [pinned, ...picked.slice(0, rowSize - 1)];
    return picked;
  }

  function selectedGame() {
    const id = tiles[index] && tiles[index].dataset.id;
    if (!id || id === LIBRARY_TILE) return null;
    return DL.state.byId.get(id) || null;
  }

  function infoVisible() {
    const base = DL.state.settings.showGameInfo !== false;
    return base !== !!DL.state.infoToggled;
  }

  // ------------------------------------------------------------------ tiles
  function setImg(img, url, onFail) {
    if (!url) { img.removeAttribute('src'); img.hidden = true; delete img.dataset.url; return; }
    if (img.dataset.url === url) return;
    img.dataset.url = url;
    img.hidden = false;
    img.onerror = () => { img.hidden = true; if (onFail) onFail(); };
    img.src = url;
  }

  function buildTile(game) {
    const cover = el('img', { class: 'cover', attrs: { alt: '', draggable: 'false', decoding: 'async' } });
    const coverBlur = el('img', { class: 'cover-blur', attrs: { alt: '', draggable: 'false', decoding: 'async', 'aria-hidden': 'true' } });
    const wide = el('img', { class: 'wide', attrs: { alt: '', draggable: 'false', decoding: 'async' } });
    const fallback = el('div', { class: 'fallback' }, el('span', { class: 'fb-name' }));
    const tile = el('div', { class: 'tile', nav: true, data: { id: game.id } },
      el('div', { class: 'tile-art' }, coverBlur, cover, wide, fallback),
      el('div', { class: 'tile-shade' }),
      el('div', { class: 'tile-badges' }),
      el('div', { class: 'tile-status' }),
      el('div', { class: 'tile-dot' }));
    tile._parts = { cover, coverBlur, wide, fallback };
    tile.addEventListener('click', () => onTileClick(tile));
    tile.addEventListener('dblclick', () => { if (tiles[index] === tile) primaryAction(); });
    return tile;
  }

  function updateTile(tile, game) {
    const p = tile._parts;
    const hue = DL.fallbackHue(game.name);
    p.fallback.style.background = `linear-gradient(160deg, hsl(${hue} 55% 42%), hsl(${(hue + 40) % 360} 60% 18%))`;
    p.fallback.firstChild.textContent = game.name;
    const fit = game.art && game.art.coverFit === 'contain';
    tile.classList.toggle('fit-contain', !!fit);
    const coverUrl = game.art && game.art.cover;
    setImg(p.cover, coverUrl, () => tile.classList.add('no-art'));
    setImg(p.coverBlur, coverUrl);
    tile.classList.toggle('no-art', !coverUrl);
    if (tile.classList.contains('sel')) setImg(p.wide, (game.art && game.art.hero) || null);
    tile.classList.toggle('no-wide', !(game.art && game.art.hero));
    const badges = tile.querySelector('.tile-badges');
    badges.textContent = '';
    for (const b of DL.badge(game)) badges.appendChild(b);
    const status = tile.querySelector('.tile-status');
    status.textContent = '';
    tile.classList.toggle('dim', !game.installed && game.status !== 'running');
    if ((game.status === 'installing' || game.status === 'updating') && typeof game.progress === 'number') {
      status.appendChild(el('span', { text: DL.t(game.status === 'installing' ? 'status.installingShort' : 'status.updatingShort', { p: DL.fmt.percent(game.progress) }) }));
      status.appendChild(el('span', { class: 'prog' }, el('i', { style: { width: `${Math.round(game.progress * 100)}%` } })));
      status.hidden = false;
    } else if (game.status === 'running') {
      status.appendChild(el('span', { text: DL.t('status.running') }));
      status.hidden = false;
    } else {
      status.hidden = true;
    }
    tile.querySelector('.tile-dot').hidden = game.status !== 'updateRequired';
    tile.setAttribute('aria-label', game.name);
  }

  function buildLibraryTile() {
    const tile = el('div', { class: 'tile library-tile', nav: true, data: { id: LIBRARY_TILE } },
      el('div', { class: 'lib-grid' }, el('i'), el('i'), el('i'), el('i')),
      el('div', { class: 'lib-text' }, el('div', { class: 'lib-title', text: DL.t('home.fullLibrary') }), el('div', { class: 'lib-count' })));
    tile.addEventListener('click', () => onTileClick(tile));
    return tile;
  }

  function renderRow() {
    rowGames = homeGames();
    const prevId = tiles[index] && tiles[index].dataset.id;
    const keep = new Set(rowGames.map((g) => g.id));
    for (const [id, t] of tileById) if (id !== LIBRARY_TILE && !keep.has(id)) { t.remove(); tileById.delete(id); }
    const next = [];
    for (const g of rowGames) {
      let t = tileById.get(g.id);
      if (!t) { t = buildTile(g); tileById.set(g.id, t); }
      updateTile(t, g);
      next.push(t);
    }
    let lib = tileById.get(LIBRARY_TILE);
    if (!lib) { lib = buildLibraryTile(); tileById.set(LIBRARY_TILE, lib); }
    const total = DL.visibleGames().length;
    lib.querySelector('.lib-title').textContent = DL.t('home.fullLibrary');
    lib.querySelector('.lib-count').textContent = DL.t('home.gamesCount', { n: DL.fmt.number(total), count: total });
    next.push(lib);
    // Re-order DOM only when needed (keeps images from reloading).
    next.forEach((t, i) => { if (rowEl.children[i] !== t) rowEl.insertBefore(t, rowEl.children[i] || null); });
    while (rowEl.children.length > next.length) rowEl.lastChild.remove();
    tiles = next;
    let newIndex = prevId ? tiles.findIndex((t) => t.dataset.id === prevId) : -1;
    if (newIndex < 0) newIndex = Math.min(index, tiles.length - 1);
    if (!rowGames.length) newIndex = tiles.length - 1;
    root.classList.toggle('empty', !rowGames.length);
    select(Math.max(0, newIndex), { force: true, silent: true });
    if (DL.hub && DL.hub.isOpen() && !selectedGame()) closeHub();
  }

  function onTileClick(tile) {
    const i = tiles.indexOf(tile);
    if (i < 0) return;
    const viaPointerSelect = justSelectedByPointer && !tile._dlViaNav;
    justSelectedByPointer = false;
    if (DL.hub && DL.hub.isOpen() && !tile._dlViaNav) { closeHub({ focusTile: false }); }
    if (i !== index) { DL.nav.focus(tile); return; }
    if (viaPointerSelect) return; // first click only selects
    if (tile.dataset.id === LIBRARY_TILE) { DL.library.open(); return; }
    primaryAction();
  }

  // ------------------------------------------------------------------ selection
  function select(i, { force = false, silent = false } = {}) {
    if (!tiles.length) return;
    i = DL.clamp(i, 0, tiles.length - 1);
    const changed = i !== index || force;
    if (!changed) return;
    if (!force && performance.now() - pointerDownAt < 80) justSelectedByPointer = true;
    const prevTile = tiles[index];
    index = i;
    tiles.forEach((t, k) => t.classList.toggle('sel', k === i));
    const game = selectedGame();
    if (game) {
      const t = tiles[i];
      setImg(t._parts.wide, (game.art && game.art.hero) || null);
      DL.state.selectedId = game.id;
      if (!silent && prevTile !== t && !(DL.state.settings && DL.state.settings.reduceMotion)) {
        t.classList.remove('shine');
        void t.offsetWidth;
        t.classList.add('shine');
      }
    }
    renderHero();
    renderHints();
    clearTimeout(bgTimer);
    bgTimer = setTimeout(() => setBackground(game), silent ? 0 : 140);
    clearTimeout(detailsTimer);
    if (game && game.source === 'steam') detailsTimer = setTimeout(() => loadDetails(game.id), 380);
    if (game && DL.hub) DL.hub.prefetch(game);
  }

  async function loadDetails(id) {
    if (DL.state.details.has(id)) { if (selectedGame() && selectedGame().id === id) renderHero(); return; }
    try {
      const d = await DL.api.gameDetails(id, DL.i18n.locale);
      if (d && !d.error && !d.needsKey && !d.needsId) DL.state.details.set(id, d);
      if (d && d.friends === null && !d.needsKey) {
        // Friends list is being built in the background; ask again later.
        setTimeout(() => { DL.state.details.delete(id); }, 60000);
      }
    } catch { /* ignore */ }
    const g = selectedGame();
    if (g && g.id === id) renderHero();
  }

  // ------------------------------------------------------------------ hero
  function statusText(game) {
    switch (game.status) {
      case 'running': return DL.t('status.running');
      case 'installing': return typeof game.progress === 'number' ? DL.t('status.installingProgress', { p: DL.fmt.percent(game.progress) }) : DL.t('status.installing');
      case 'updating': return typeof game.progress === 'number' ? DL.t('status.updatingProgress', { p: DL.fmt.percent(game.progress) }) : DL.t('status.updating');
      case 'updateRequired': return DL.t('status.updateAvailable');
      case 'notInstalled': return DL.t('status.notInstalled');
      case 'missing': return DL.t('status.missing');
      default: {
        const size = DL.fmt.bytes(game.sizeBytes);
        return size ? `${DL.t('status.installed')} · ${size}` : DL.t('status.installed');
      }
    }
  }

  function primaryInfo(game) {
    if (!game) return { label: DL.t('home.openLibrary'), icon: 'library', enabled: true };
    if (game.status === 'running') return { label: DL.t('actions.playing'), icon: 'play', enabled: false };
    if (game.actions.install) return { label: DL.t('actions.install'), icon: 'download', enabled: true };
    if (game.status === 'installing' || game.status === 'updating') return { label: DL.t('actions.downloading'), icon: 'download', enabled: false };
    if (game.status === 'missing') return { label: DL.t('actions.notFound'), icon: 'warn', enabled: false };
    if (game.actions.play) return { label: DL.t('actions.play'), icon: 'play', enabled: true };
    return { label: DL.t('actions.play'), icon: 'play', enabled: false };
  }

  function secondaryInfo(game) {
    if (!game) return null;
    if (game.status === 'running') return { label: DL.t('actions.notPlaying'), run: () => DL.actions.stopTracking(game) };
    if (game.actions.update) return { label: DL.t('actions.update'), run: () => DL.actions.update(game) };
    if (game.actions.checkUpdates) return { label: DL.t('actions.checkUpdates'), run: () => DL.actions.update(game) };
    return null;
  }

  function titleSize(name) {
    const n = [...String(name)].length;
    if (n > 42) return 'xs';
    if (n > 30) return 's';
    if (n > 18) return 'm';
    return 'l';
  }

  // ---- logos
  const logoInfo = new Map(); // url -> { src, w, h, dark } | null when it failed

  /** Loads a logo, trims transparent borders and checks whether it is too dark for the background. */
  function loadLogo(url) {
    if (logoInfo.has(url)) return Promise.resolve(logoInfo.get(url));
    if (loadLogo.pending.has(url)) return loadLogo.pending.get(url);
    const p = new Promise((resolve) => {
      const remember = (info) => {
        if (logoInfo.size > 60) logoInfo.delete(logoInfo.keys().next().value);
        logoInfo.set(url, info);
        resolve(info);
      };
      // First with CORS (so the pixels can be read for trimming); if that is refused, load it
      // plainly and show it untrimmed.
      const tryLoad = (withCors) => {
        const img = new Image();
        if (withCors) img.crossOrigin = 'anonymous';
        img.decoding = 'async';
        img.onload = () => {
          let info = { src: url, w: img.naturalWidth || 1, h: img.naturalHeight || 1, dark: false };
          if (withCors) { try { info = analyseLogo(img, url); } catch { /* keep the untrimmed logo */ } }
          remember(info);
        };
        img.onerror = () => { if (withCors) tryLoad(false); else remember(null); };
        img.src = url;
      };
      tryLoad(true);
    }).finally(() => loadLogo.pending.delete(url));
    loadLogo.pending.set(url, p);
    return p;
  }
  loadLogo.pending = new Map();

  function analyseLogo(img, url) {
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    const k = Math.min(1, 360 / Math.max(nw, nh));
    const sw = Math.max(1, Math.round(nw * k));
    const sh = Math.max(1, Math.round(nh * k));
    const c = document.createElement('canvas');
    c.width = sw; c.height = sh;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, sw, sh);
    const data = g.getImageData(0, 0, sw, sh).data;
    let minX = sw; let minY = sh; let maxX = -1; let maxY = -1;
    let lum = 0; let n = 0;
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const i = (y * sw + x) * 4;
        const a = data[i + 3];
        if (a < 24) continue;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        lum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) * (a / 255);
        n += a / 255;
      }
    }
    if (maxX < 0) return { src: url, w: nw, h: nh, dark: false };
    const dark = n > 0 && lum / n < 48;
    const bw = (maxX - minX + 1) / k;
    const bh = (maxY - minY + 1) / k;
    if (bw > nw * 0.92 && bh > nh * 0.92) return { src: url, w: nw, h: nh, dark };
    // Crop the transparent border at full resolution.
    const pad = 2;
    const cx = Math.max(0, Math.floor(minX / k) - pad);
    const cy = Math.max(0, Math.floor(minY / k) - pad);
    const cw = Math.min(nw - cx, Math.ceil(bw) + pad * 2);
    const ch = Math.min(nh - cy, Math.ceil(bh) + pad * 2);
    const out = document.createElement('canvas');
    out.width = cw; out.height = ch;
    out.getContext('2d').drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch);
    return { src: out.toDataURL('image/png'), w: cw, h: ch, dark };
  }

  /** Size of a logo on screen: similar visual weight for wide and tall logos. */
  function logoBox(info) {
    const maxH = DL.state.logoMaxH || 190;
    const a = info.w / info.h;
    let h = Math.min(maxH, Math.sqrt(84000 / a));
    let w = h * a;
    if (w > 760) { w = 760; h = w / a; }
    return { w: Math.round(w), h: Math.round(h) };
  }

  function applyLogo(game) {
    const box = DL.$('.hero-titlebox');
    const img = DL.$('.hero-logo');
    const url = DL.state.settings.showLogos !== false && game && game.art && game.art.logo;
    if (!url) { box.classList.remove('logo'); img.hidden = true; img.classList.remove('shown'); delete img.dataset.url; return; }
    const info = logoInfo.get(url);
    if (info === null) { box.classList.remove('logo'); img.hidden = true; return; }
    if (!info) {
      box.classList.remove('logo');
      img.hidden = true;
      loadLogo(url).then(() => { const g = selectedGame(); if (g && g.art && g.art.logo === url) applyLogo(g); });
      return;
    }
    const size = logoBox(info);
    img.style.setProperty('--logo-w', `${size.w}px`);
    img.style.setProperty('--logo-box-h', `${size.h}px`);
    img.classList.toggle('dark', info.dark);
    img.setAttribute('alt', game.name);
    img.hidden = false;
    box.classList.add('logo');
    if (img.dataset.url !== url) {
      img.dataset.url = url;
      img.classList.remove('shown');
      img.src = info.src;
      requestAnimationFrame(() => requestAnimationFrame(() => img.classList.add('shown')));
    } else {
      img.classList.add('shown');
    }
  }

  function renderHero() {
    const hero = DL.$('#hero');
    const tags = DL.$('.hero-tags', hero);
    const title = DL.$('.hero-title', hero);
    const meta = DL.$('.hero-meta', hero);
    const play = DL.$('#btn-play');
    const more = DL.$('#btn-more');
    tags.textContent = '';
    meta.textContent = '';
    const game = selectedGame();
    root.classList.toggle('info-off', !infoVisible() && rowGames.length > 0);

    if (!rowGames.length) {
      const scanning = DL.state.scanning;
      applyLogo(null);
      title.textContent = DL.t(scanning ? 'empty.scanningTitle' : 'empty.title');
      title.dataset.size = 'm';
      meta.appendChild(el('span', { class: 'meta-text', text: DL.t(scanning ? 'empty.scanningText' : 'empty.text') }));
      setPrimary(play, { label: DL.t('empty.openImporter'), icon: 'importer', enabled: true });
      more.hidden = true;
      return;
    }
    more.hidden = !game;
    if (!game) {
      const total = DL.visibleGames().length;
      applyLogo(null);
      tags.appendChild(el('span', { class: 'tag-text', text: DL.t('home.libraryTag') }));
      title.textContent = DL.t('home.fullLibrary');
      title.dataset.size = 'l';
      meta.appendChild(el('span', { class: 'meta-text', text: DL.t('home.gamesCount', { n: DL.fmt.number(total), count: total }) }));
      setPrimary(play, primaryInfo(null));
      return;
    }
    for (const b of DL.badge(game, { forHero: true })) tags.appendChild(b);
    tags.appendChild(el('span', { class: 'tag-text', text: statusText(game) }));
    title.textContent = game.name;
    title.dataset.size = titleSize(game.name);
    applyLogo(game);

    const items = [];
    if (game.status === 'running') {
      items.push(el('span', { class: 'meta-item playing' }, DL.icon('play'), el('span', { text: DL.t('status.running') })));
    }
    for (const it of playtimeItems(game)) items.push(it);
    // Achievements and friends come from the internet: hidden while offline.
    const online = DL.state.net.online !== false;
    const d = online ? DL.state.details.get(game.id) : null;
    const ach = (d && d.achievements && d.achievements.total) ? d.achievements
      : (online && game.xboxAchievements && game.xboxAchievements.total ? game.xboxAchievements : null);
    if (ach) {
      const pct = ach.unlocked / ach.total;
      const ring = DL.svg(`<svg class="ring" viewBox="0 0 40 40"><circle cx="20" cy="20" r="15" fill="none" stroke="rgba(255,255,255,.28)" stroke-width="6"/><circle cx="20" cy="20" r="15" fill="none" stroke="#ffcc00" stroke-width="6" stroke-linecap="round" stroke-dasharray="94.25" stroke-dashoffset="${(94.25 * (1 - pct)).toFixed(2)}" transform="rotate(-90 20 20)"/></svg>`);
      items.push(el('span', { class: 'meta-item', attrs: { title: DL.t('meta.achievements') } }, ring, el('span', { text: `${DL.fmt.number(ach.unlocked)} / ${DL.fmt.number(ach.total)}` })));
    }
    const fr = !online ? null : (d && d.friends && d.friends.count > 0) ? d.friends
      : (DL.state.friendsSummary || {})[friendsKey(game)];
    if (fr && fr.count > 0) {
      const faces = el('span', { class: 'faces' });
      for (const p of fr.people || []) {
        const face = el('span', { class: 'face', text: (p.name || '?').slice(0, 1).toUpperCase() });
        if (p.avatar && /^https:\/\//.test(p.avatar)) {
          const img = el('img', { attrs: { alt: '', src: p.avatar, referrerpolicy: 'no-referrer' } });
          img.onerror = () => img.remove();
          face.appendChild(img);
        }
        faces.appendChild(face);
      }
      items.push(el('span', { class: 'meta-item' }, faces, el('span', { text: DL.t('meta.friendsPlayed', { n: DL.fmt.number(fr.count), count: fr.count }) })));
    }
    for (const it of items) meta.appendChild(it);
    setPrimary(play, primaryInfo(game));
  }

  /** Key of a game in the "friends who played" summary. */
  function friendsKey(game) {
    if (game.source === 'steam') return String(game.sourceId);
    if (game.source === 'xbox' && game.xboxTitleId) return `xbox:${game.xboxTitleId}`;
    return '';
  }

  /**
   * Playtime chips. Steam, Cemu and the Xbox network know the real playtime. For other games
   * Dream Launcher only knows when it started them: by default those show "Last booted" only
   * (Options › Home & display › "Only show known playtime").
   */
  function playtimeItems(game) {
    const out = [];
    if (game.status === 'running') return out;
    const clock = (text) => el('span', { class: 'meta-item' }, DL.icon('clock'), el('span', { text }));
    const when = (ms) => DL.fmt.relativeDay(ms, { dateOnly: !!game.lastPlayedDayOnly && ms === game.lastPlayed });
    if (game.playtimeKnown || !DL.state.settings.onlyKnownPlaytime) {
      const lastText = game.lastPlayed ? DL.t('meta.lastPlayed', { when: when(game.lastPlayed) }) : '';
      if (Math.round(game.playtimeMinutes || 0) > 0) {
        out.push(clock(DL.fmt.playtime(game.playtimeMinutes)));
        if (lastText) out.push(el('span', { class: 'meta-item', text: lastText }));
      } else {
        out.push(clock(lastText || DL.t('meta.neverPlayed')));
      }
      return out;
    }
    const booted = game.lastBooted || 0;
    if (game.lastPlayed > booted) out.push(clock(DL.t('meta.lastPlayed', { when: when(game.lastPlayed) })));
    else if (booted) out.push(clock(DL.t('meta.lastBooted', { when: DL.fmt.relativeDay(booted) })));
    return out;
  }

  function setPrimary(btn, info) {
    btn.textContent = '';
    btn.appendChild(DL.icon(info.icon));
    btn.appendChild(el('span', { text: info.label }));
    if (info.enabled) btn.removeAttribute('aria-disabled'); else btn.setAttribute('aria-disabled', 'true');
  }

  function primaryAction() {
    if (!rowGames.length) { DL.importer.open(); return; }
    const game = selectedGame();
    if (!game) { DL.library.open(); return; }
    DL.actions.primary(game);
  }

  // ------------------------------------------------------------------ background
  function extractAccent(url, cb) {
    if (accentCache.has(url)) { cb(accentCache.get(url)); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 24; c.height = 24;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0, 24, 24);
        const data = g.getImageData(0, 0, 24, 24).data;
        let r = 0; let gr = 0; let b = 0; let n = 0;
        for (let i = 0; i < data.length; i += 4) {
          const R = data[i]; const G = data[i + 1]; const B = data[i + 2];
          const max = Math.max(R, G, B); const min = Math.min(R, G, B);
          if (max < 35) continue;
          const w = 1 + (max - min) / 28;
          r += R * w; gr += G * w; b += B * w; n += w;
        }
        const rgb = n ? [r / n, gr / n, b / n] : null;
        accentCache.set(url, rgb);
        cb(rgb);
      } catch {
        accentCache.set(url, null);
        cb(null);
      }
    };
    img.onerror = () => { accentCache.set(url, null); cb(null); };
    img.src = url;
  }

  let heroLayer = 0;
  function setBackground(game) {
    const layers = DL.$$('#hero-art .hero-layer');
    const s = DL.state.settings;
    const hero = game && game.art ? game.art.hero : null;
    const cover = game && game.art ? game.art.cover : null;
    const url = s.showHeroArt === false ? null : (hero || cover || null);
    const mode = hero ? 'hero' : 'blur';
    const current = layers[heroLayer];
    if ((current.dataset.url || '') === (url || '') && current.dataset.mode === mode) return;
    const next = layers[1 - heroLayer];
    const show = () => {
      next.style.backgroundImage = url ? `url("${url.replace(/"/g, '%22')}")` : 'none';
      next.dataset.url = url || '';
      next.dataset.mode = mode;
      next.classList.toggle('blur', mode === 'blur');
      next.classList.add('on');
      current.classList.remove('on');
      heroLayer = 1 - heroLayer;
    };
    if (url) {
      const probe = new Image();
      probe.onload = show;
      probe.onerror = () => { next.dataset.url = ''; current.classList.remove('on'); };
      probe.src = url;
    } else {
      show();
    }
    // The cover's colour (used by the "Game colour" theme; fixed themes keep their own).
    const accentSrc = cover || hero;
    if (accentSrc) {
      extractAccent(accentSrc, (rgb) => { if (rgb) DL.theme.setGameColor(rgb.map((v) => Math.round(v))); });
    } else {
      DL.theme.setGameColor(null);
    }
  }

  // ------------------------------------------------------------------ top bar
  let battery = null;
  async function initBattery() {
    if (!navigator.getBattery) return;
    try {
      battery = await navigator.getBattery();
      const upd = () => renderStatus();
      battery.addEventListener('levelchange', upd);
      battery.addEventListener('chargingchange', upd);
    } catch { battery = null; }
  }

  function renderStatus() {
    const s = DL.state.settings;
    const clock = DL.$('#clock-block');
    clock.textContent = '';
    const now = new Date();
    if (s.showClock !== false) clock.appendChild(el('span', { class: 'tb-time', text: DL.fmt.time(now) }));
    if (s.showDate) clock.appendChild(el('span', { class: 'tb-date', text: DL.fmt.longDate(now) }));
    const pill = DL.$('#battery-pill');
    pill.textContent = '';
    if (s.showBattery !== false && DL.state.hasBattery && battery) {
      const lvl = Math.round(battery.level * 100);
      pill.appendChild(el('span', { class: `batt ${lvl <= 15 && !battery.charging ? 'low' : ''}` },
        el('span', { class: 'bat-body' }, el('i', { style: { width: `${lvl}%` } })),
        battery.charging ? DL.icon('bolt', 'bat-bolt') : null,
        el('span', { text: DL.fmt.percent(lvl / 100) })));
      pill.hidden = false;
    } else {
      pill.hidden = true;
    }
  }

  // ------------------------------------------------------------------ hints
  function renderHints() {
    const left = DL.$('#hints');
    const right = DL.$('#hints-right');
    left.textContent = '';
    right.textContent = '';
    const game = selectedGame();
    if (DL.hub && DL.hub.isOpen()) {
      left.appendChild(DL.glyphs.hint('confirm', DL.t('hints.select')));
      if (rowGames.length > 1) left.appendChild(DL.glyphs.hint('lbrb', DL.t('hub.switchGame')));
      left.appendChild(DL.glyphs.hint('back', DL.t('hints.back'), () => closeHub()));
      right.appendChild(DL.glyphs.hint('up', DL.t('hub.backToGames'), () => closeHub()));
      return;
    }
    if (!rowGames.length) {
      left.appendChild(DL.glyphs.hint('confirm', DL.t('empty.openImporter'), () => DL.importer.open()));
    } else if (!game) {
      left.appendChild(DL.glyphs.hint('confirm', DL.t('home.openLibrary'), () => DL.library.open()));
    } else {
      const p = primaryInfo(game);
      if (p.enabled) left.appendChild(DL.glyphs.hint('confirm', p.label, primaryAction));
      const sec = secondaryInfo(game);
      if (sec) left.appendChild(DL.glyphs.hint('x', sec.label, sec.run));
      left.appendChild(DL.glyphs.hint('menu', DL.t('hints.gameOptions'), () => DL.gameMenu.open(game)));
    }
    left.appendChild(DL.glyphs.hint('view', DL.t('hints.search'), () => DL.search.open()));
    if (game) {
      const online = DL.state.net.online !== false;
      let peek = 'hub.peek';
      if (game.source === 'steam') peek = online ? 'hub.peekSteam' : 'hub.peekSteamOffline';
      else if (game.source === 'xbox' && online) peek = 'hub.peekXbox';
      else if (['cemu', 'dolphin', 'ppsspp', 'rpcs3'].includes(game.screenshotSource)) peek = 'hub.peekCemu';
      right.appendChild(DL.glyphs.hint('down', DL.t(peek), () => openHub()));
    }
    renderPeek(game);
    if (rowGames.length) right.appendChild(DL.glyphs.hint('info', DL.t(infoVisible() ? 'hints.hideInfo' : 'hints.showInfo'), toggleInfo));
  }

  /**
   * A small bobbing arrow under the game row showing that there is more below (the slide-down
   * panel). It names what is there until the panel has been opened a few times.
   */
  const PEEK_KEY = 'dl.hubOpened';
  const peekSeen = () => { try { return Number(localStorage.getItem(PEEK_KEY)) || 0; } catch { return 0; } };
  function renderPeek(game) {
    const btn = DL.$('#hub-peek');
    if (!btn) return;
    const show = !!game && !(DL.hub && DL.hub.isOpen());
    btn.classList.toggle('show', show);
    btn.textContent = '';
    btn.appendChild(el('span', { class: 'peek-arrow' }, DL.icon('chevronDown')));
    if (show && peekSeen() < 3) btn.appendChild(el('span', { class: 'peek-text', text: DL.t('hub.peekMore') }));
    btn.setAttribute('aria-label', DL.t('hub.peekMore'));
  }

  function toggleInfo() {
    DL.state.infoToggled = !DL.state.infoToggled;
    DL.sound.play('toggle');
    renderHero();
    renderHints();
    if (!infoVisible() && scope && DL.nav.top() === scope) {
      const f = DL.nav.focused();
      if (f && f.closest('#hero')) DL.nav.focus(tiles[index], { sound: false });
    }
  }

  // ------------------------------------------------------------------ hub (slide down)
  function openHub() {
    const game = selectedGame();
    if (!game || !DL.hub || DL.hub.isOpen()) return;
    if (DL.nav.top() !== scope) return;
    DL.hub.open(game);
    try { localStorage.setItem(PEEK_KEY, String(peekSeen() + 1)); } catch { /* not kept */ }
    root.classList.add('hub-open');
    document.body.classList.add('hub-open');
    DL.waves.setMode('hub');
    DL.sound.play('slide');
    renderHints();
    const first = DL.hub.firstCard();
    if (first) DL.nav.focus(first, { sound: false });
  }

  function closeHub({ focusTile = true } = {}) {
    if (!DL.hub || !DL.hub.isOpen()) return;
    DL.hub.close();
    root.classList.remove('hub-open');
    document.body.classList.remove('hub-open');
    DL.waves.setMode('dashboard');
    DL.sound.play('slideBack');
    renderHints();
    if (focusTile && tiles[index] && DL.nav.top() === scope) DL.nav.focus(tiles[index], { sound: false });
  }

  /** LB/RB inside the hub: show the previous/next game of the row. */
  function switchHubGame(dir) {
    let i = index;
    for (let n = 0; n < tiles.length; n++) {
      i = (i + dir + tiles.length) % tiles.length;
      if (tiles[i].dataset.id !== LIBRARY_TILE) break;
    }
    if (i === index || tiles[i].dataset.id === LIBRARY_TILE) return;
    select(i);
    const game = selectedGame();
    if (game) {
      const cardIndex = DL.hub.focusedIndex();
      DL.hub.open(game);
      DL.sound.play('toggle');
      const target = DL.hub.cardAt(cardIndex) || DL.hub.firstCard();
      if (target) DL.nav.focus(target, { sound: false, force: true });
    }
  }

  // ------------------------------------------------------------------ navigation
  function heroButton() {
    if (!infoVisible() && rowGames.length) return null;
    const play = DL.$('#btn-play');
    return play && !play.hidden ? play : null;
  }

  function onMove(dir, focused) {
    if (!focused) return false;
    if (focused.classList.contains('hub-card')) {
      if (dir === 'up') { closeHub(); return true; }
      if (dir === 'left' || dir === 'right') { DL.hub.move(dir === 'right' ? 1 : -1); return true; }
      return true;
    }
    if (focused.classList.contains('tile')) {
      if (dir === 'left' || dir === 'right') {
        const i = tiles.indexOf(focused) + (dir === 'right' ? 1 : -1);
        if (i >= 0 && i < tiles.length) DL.nav.focus(tiles[i], { x: posX(tiles[i]) });
        return true;
      }
      if (dir === 'up') {
        DL.nav.focus(heroButton() || DL.$('#btn-search'));
        return true;
      }
      if (dir === 'down') { openHub(); return true; }
      return true;
    }
    if (focused.closest('#hero')) {
      if (dir === 'up') { DL.nav.focus(DL.$('#btn-search')); return true; }
      if (dir === 'down') { if (rowGames.length && tiles[index]) DL.nav.focus(tiles[index]); return true; }
      // Left/right only between the game's buttons.
      const buttons = DL.$$('#hero .hero-actions [data-nav]').filter((b) => !b.hidden);
      const i = buttons.indexOf(focused) + (dir === 'right' ? 1 : -1);
      if (i >= 0 && i < buttons.length) DL.nav.focus(buttons[i]);
      return true;
    }
    if (focused.closest('.topbar')) {
      if (dir === 'down') {
        DL.nav.focus(heroButton() || (rowGames.length ? tiles[index] : DL.$('#btn-play')));
        return true;
      }
      return dir === 'up';
    }
    return false;
  }

  function posX(node) {
    const r = node.getBoundingClientRect();
    return (r.left + r.width / 2) / Math.max(1, window.innerWidth);
  }

  function onAction(action) {
    const game = selectedGame();
    if (DL.hub && DL.hub.isOpen()) {
      if (action === 'lb' || action === 'rb') { switchHubGame(action === 'rb' ? 1 : -1); return true; }
      if (action === 'menu' && game) { DL.gameMenu.open(game); return true; }
      if (action === 'x' || action === 'info') return true;
      return false;
    }
    switch (action) {
      case 'x': {
        const sec = secondaryInfo(game);
        if (sec) { DL.sound.play('select'); sec.run(); }
        return true;
      }
      case 'info': if (rowGames.length) toggleInfo(); return true;
      case 'menu': if (game) DL.gameMenu.open(game); return true;
      case 'rb': DL.library.open(); return true;
      case 'lb': DL.search.open(); return true;
      default: return false;
    }
  }

  async function onBack() {
    if (DL.hub && DL.hub.isOpen()) { closeHub(); return; }
    const s = DL.state.settings;
    if (!s.confirmExit) { DL.api.quit(); return; }
    DL.sound.play('open');
    const choice = await DL.ui.confirm({
      title: DL.t('exit.title'),
      message: DL.t('exit.text'),
      buttons: [
        { id: 'cancel', label: DL.t('common.cancel'), primary: true },
        { id: 'minimize', label: DL.t('exit.minimize') },
        { id: 'quit', label: DL.t('exit.quit'), danger: true },
      ],
    });
    if (choice === 'quit') DL.api.quit();
    else if (choice === 'minimize') DL.api.minimize();
  }

  // Mouse wheel and touch: scroll / swipe to open and close the hub.
  function wireGestures() {
    let wheelLock = 0;
    root.addEventListener('wheel', (e) => {
      if (DL.nav.top() !== scope) return;
      const overRow = e.target.closest && e.target.closest('#row');
      const dy = e.deltaY;
      if (overRow && !(DL.hub && DL.hub.isOpen())) {
        e.preventDefault();
        const dir = (dy || e.deltaX) > 0 ? 1 : -1;
        const t = tiles[DL.clamp(index + dir, 0, tiles.length - 1)];
        if (t) DL.nav.focus(t);
        return;
      }
      if (Math.abs(dy) < 8 || performance.now() < wheelLock) return;
      wheelLock = performance.now() + 450;
      if (dy > 0) openHub(); else closeHub();
    }, { passive: false });
    let start = null;
    root.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') start = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    root.addEventListener('pointerup', (e) => {
      if (!start || e.pointerType !== 'touch') return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      const fast = performance.now() - start.t < 700;
      start = null;
      if (!fast || Math.abs(dy) < 70 || Math.abs(dy) < Math.abs(dx) * 1.3) return;
      if (dy < 0) openHub(); else closeHub();
    });
  }

  /** Wi-Fi button in the top bar: icon only when online, "Offline" pill when not. */
  function renderNet() {
    const btn = DL.$('#btn-net');
    if (!btn) return;
    const net = DL.state.net || {};
    const online = net.online !== false;
    btn.textContent = '';
    btn.appendChild(DL.icon(online ? 'wifi' : 'wifiOff'));
    if (!online) btn.appendChild(el('span', { class: 'net-label', text: DL.t('net.offlineShort') }));
    btn.classList.toggle('is-offline', !online);
    btn.setAttribute('aria-label', DL.t(online ? 'net.onlineTitle' : 'net.offlineTitle'));
  }

  // ------------------------------------------------------------------ public
  function init() {
    root = DL.$('#dashboard');
    rowEl = DL.$('#row');
    const peek = DL.$('#hub-peek');
    if (peek) peek.addEventListener('click', () => { if (DL.hub && DL.hub.isOpen()) closeHub(); else openHub(); });
    const netBtn = DL.$('#btn-net');
    if (netBtn) netBtn.addEventListener('click', () => DL.net.open());
    renderNet();
    const search = DL.$('#btn-search');
    search.appendChild(DL.icon('search'));
    search.addEventListener('click', () => DL.search.open());
    const imp = DL.$('#btn-import');
    imp.appendChild(DL.icon('importer'));
    imp.addEventListener('click', () => DL.importer.open());
    const opt = DL.$('#btn-options');
    opt.appendChild(DL.icon('options'));
    opt.addEventListener('click', () => DL.options.open());
    DL.$('#btn-play').addEventListener('click', () => { if (DL.$('#btn-play').getAttribute('aria-disabled') !== 'true') primaryAction(); });
    const more = DL.$('#btn-more');
    more.appendChild(DL.icon('more'));
    more.addEventListener('click', () => { const g = selectedGame(); if (g) DL.gameMenu.open(g); });
    layout();
    wireGestures();
    if (DL.hub) DL.hub.init({ selected: selectedGame, close: closeHub });

    scope = {
      id: 'dashboard',
      root,
      initial: () => (rowGames.length ? tiles[index] : DL.$('#btn-play')) || DL.$('#btn-search'),
      onMove,
      onAction,
      onBack,
      onFocus: (node) => {
        if (node.classList.contains('tile')) {
          const i = tiles.indexOf(node);
          if (i >= 0) select(i);
          if (DL.hub && DL.hub.isOpen()) closeHub({ focusTile: false });
        }
        root.classList.toggle('row-focused', node.classList.contains('tile'));
      },
    };

    initBattery().then(renderStatus);
    setInterval(renderStatus, 10000);
    setInterval(() => { if (selectedGame() && selectedGame().lastPlayed) renderHero(); }, 5 * 60 * 1000);

    DL.bus.on('library', () => { renderRow(); DL.nav.refresh(); });
    DL.bus.on('net', () => { renderNet(); renderHero(); renderHints(); DL.nav.refresh(); });
    // A dot on the Options button while a newer version is waiting.
    const renderUpdateDot = () => {
      const btn = DL.$('#btn-options');
      if (btn) btn.classList.toggle('has-update', !!(DL.state.update && DL.state.update.latest));
    };
    DL.bus.on('update', renderUpdateDot);
    renderUpdateDot();
    DL.bus.on('settings', (patch) => {
      if (patch && 'showGameInfo' in patch) DL.state.infoToggled = false;
      renderRow();
      renderStatus();
      if (patch && 'showHeroArt' in patch) setBackground(selectedGame());
      DL.nav.refresh();
    });
    DL.bus.on('stage', () => { layout(); renderRow(); });
    DL.bus.on('inputmode', renderHints);
    DL.bus.on('language', () => { renderRow(); renderStatus(); renderHints(); });
  }

  function show() {
    renderRow();
    renderStatus();
    DL.nav.push(scope);
    root.classList.add('row-focused');
  }

  DL.dashboard = {
    init,
    show,
    render: renderRow,
    selectGame(id) {
      DL.state.pinnedId = id;
      renderRow();
      const i = tiles.findIndex((t) => t.dataset.id === id);
      if (i >= 0) {
        select(i, { force: true });
        if (DL.nav.top() === scope) DL.nav.focus(tiles[i], { sound: false, force: true });
        else scope.focused = tiles[i];
      }
    },
    selected: selectedGame,
    refreshHero() { if (selectedGame()) renderHero(); },
    openHub,
    closeHub,
    logo: (game) => (game && game.art && game.art.logo ? logoInfo.get(game.art.logo) || null : null),
    loadLogo,
    layout,
  };
})();
