/*
 * Dream Launcher - the slide-down hub under the tile row ("press down on a game").
 * Steam games: achievements, friends who play it and Steam screenshots & clips. Other games: game info.
 * Each card opens a full view: achievement list, friends list, gallery and viewer (clips play here).
 */
(function () {
  'use strict';
  const DL = (window.DL = window.DL || {});
  const { el } = DL;

  DL.icons.users = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 19.5c1-3.3 3.5-5 6.5-5s5.5 1.7 6.5 5"/><circle cx="17" cy="9" r="2.8"/><path d="M16.5 14.6c2.6.2 4.3 1.7 5 4.4"/></svg>';
  DL.icons.camera = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h2l1.5-2h6l1.5 2h2A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><circle cx="12" cy="12.5" r="3.6"/></svg>';
  DL.icons.calendar = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';
  DL.icons.pauseFill = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4.5" width="4.2" height="15" rx="1.2"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1.2"/></svg>';
  DL.icons.lock = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>';

  const TTL = 90 * 1000;
  const cache = new Map(); // game id -> { at, data, promise }
  let host = null;
  let api = null;
  let open = false;
  let current = null; // game shown in the hub
  let cards = [];
  let prefetchTimer = null;

  const t = (k, p) => DL.t(k, p);

  function fetchHub(game, { force = false } = {}) {
    const hit = cache.get(game.id);
    if (!force && hit && (hit.promise || Date.now() - hit.at < TTL)) return hit.promise || Promise.resolve(hit.data);
    const entry = { at: Date.now(), data: hit ? hit.data : null, promise: null };
    entry.promise = DL.api.gameHub(game.id, DL.i18n.locale)
      .then((data) => {
        entry.data = data && !data.error ? data : { error: true, screenshots: [] };
        // "Missing key / Steam ID" is never kept: ask again next time (it may be set by now).
        entry.at = entry.data.needsKey || entry.data.needsId || entry.data.error ? 0 : Date.now();
        return entry.data;
      })
      .catch(() => { entry.data = { error: true, screenshots: [] }; return entry.data; })
      .finally(() => { entry.promise = null; });
    cache.set(game.id, entry);
    return entry.promise;
  }

  // ---------------------------------------------------------------- small pieces
  function head(icon, title, count) {
    return el('div', { class: 'hub-head' }, DL.icon(icon), el('span', { text: title }), count !== undefined && count !== null ? el('span', { class: 'hub-count', text: count }) : null);
  }

  function more(text) {
    return el('div', { class: 'hub-more' }, el('span', { text }), DL.icon('chevron'));
  }

  function skeleton(heights) {
    return heights.map((h) => el('div', { class: 'hub-skel', style: { height: `${h}px`, flex: 'none' } }));
  }

  function safeImg(src, cls, alt = '') {
    const img = el('img', { class: cls, attrs: { alt, src, loading: 'lazy', decoding: 'async', draggable: 'false', referrerpolicy: 'no-referrer' } });
    img.onerror = () => { img.style.visibility = 'hidden'; };
    return img;
  }

  const THUMB_SIZES = [480, 640, 960, 1280, 1600];
  /**
   * Screenshot previews are made by the app at the size they are shown (interface scale × pixel
   * density), so they are sharp on any screen without loading full pictures.
   */
  function sizedThumb(url, cssWidth) {
    if (!url || !/^dl:\/\/shot\//.test(url)) return url;
    const px = cssWidth * ((DL.stage && DL.stage.s) || 1) * (window.devicePixelRatio || 1);
    const w = THUMB_SIZES.find((x) => x >= px) || THUMB_SIZES[THUMB_SIZES.length - 1];
    return `${url}${url.includes('?') ? '&' : '?'}w=${w}`;
  }

  /** Screenshots and clips of a game, newest first. */
  function mediaOf(data) {
    const shots = data && Array.isArray(data.screenshots) ? data.screenshots.map((x) => ({ kind: 'shot', ...x })) : [];
    const clips = data && Array.isArray(data.clips) ? data.clips.map((x) => ({ ...x, kind: 'clip' })) : [];
    return { shots, clips, all: shots.concat(clips).sort((a, b) => (b.time || 0) - (a.time || 0)) };
  }

  /** Picture of a screenshot or clip, with a play mark and length for clips. */
  function mediaThumb(item, cssWidth, cls) {
    const node = el('div', { class: `${cls} ${item.kind === 'clip' ? 'is-clip' : ''}` });
    if (item.thumb) node.appendChild(safeImg(sizedThumb(item.thumb, cssWidth), ''));
    else node.appendChild(el('span', { class: 'media-noimg' }, item.kind === 'clip' ? null : DL.icon('image')));
    if (item.kind === 'clip') {
      node.appendChild(el('span', { class: 'media-play' }, DL.icon('play')));
      if (item.duration > 0) node.appendChild(el('span', { class: 'media-len', text: DL.clips.clock(item.duration) }));
    }
    return node;
  }

  function avatar(p, cls = 'friend-av') {
    const ring = p.playingNow ? 'playing' : '';
    const node = el('span', { class: `${cls} ${ring}`, text: (p.name || '?').slice(0, 1).toUpperCase() });
    if (p.avatar && /^https:\/\//.test(p.avatar)) {
      const img = el('img', { attrs: { alt: '', src: p.avatar, referrerpolicy: 'no-referrer', loading: 'lazy' } });
      img.onerror = () => img.remove();
      node.appendChild(img);
    }
    return node;
  }

  /** "Playing now" while they play this game, otherwise when they last played it. */
  function statusOf(p) {
    if (p.playingNow) return { text: t('hub.playingNow'), cls: 'playing' };
    const last = lastPlayedOf(p);
    if (last) return { text: t('hub.friendLastPlayed', { when: DL.fmt.relativeDay(last) }), cls: 'last' };
    if (p.minutes2w > 0) return { text: t('hub.playedRecently'), cls: 'last' };
    return { text: t('hub.lastPlayedUnknown'), cls: 'last' };
  }

  /** When a friend last played: Steam's own date, or else their latest achievement in the game. */
  function lastPlayedOf(p) {
    const a = p.achievements;
    return Math.max(p.lastPlayed || 0, (a && a.lastUnlock) || 0);
  }

  /** Short facts for the hub card: "58 h · 14/16 achievements". */
  function friendShort(p) {
    const parts = [p.minutes > 0 ? DL.fmt.playtime(p.minutes) : t('meta.neverPlayed')];
    if (p.achievements && p.achievements.total) parts.push(t('hub.friendAch', { n: DL.fmt.number(p.achievements.unlocked), total: DL.fmt.number(p.achievements.total) }));
    return parts.join(' · ');
  }

  /** Full facts for the friends list: hours, started, last played, achievements. */
  function friendFacts(p) {
    const facts = [];
    const hours = p.minutes > 0 ? DL.fmt.playtime(p.minutes) : t('meta.neverPlayed');
    facts.push(p.minutes2w > 0 ? `${hours} (${t('hub.lastTwoWeeks', { time: DL.fmt.duration(p.minutes2w) })})` : hours);
    const a = p.achievements;
    if (a && a.firstUnlock) facts.push(t('hub.friendStarted', { when: DL.fmt.shortDate(a.firstUnlock) }));
    facts.push(a && a.total ? t('hub.friendAch', { n: DL.fmt.number(a.unlocked), total: DL.fmt.number(a.total) }) : t('hub.friendAchUnknown'));
    return facts;
  }

  function friendText(p, { long = false } = {}) {
    const st = statusOf(p);
    const name = el('div', { class: 'friend-line' }, el('span', { class: 'friend-name', text: p.name || '?' }), st.text ? el('span', { class: `friend-status ${st.cls}`, text: st.text }) : null);
    if (!long) return el('div', { class: 'friend-text' }, name, el('div', { class: 'friend-sub', text: friendShort(p) }));
    return el('div', { class: 'friend-text' }, name,
      el('div', { class: 'friend-facts' }, ...friendFacts(p).map((f) => el('span', { text: f }))));
  }

  function openProfile(p) {
    let url = typeof p.profileUrl === 'string' && /^https:\/\//.test(p.profileUrl) ? p.profileUrl : '';
    if (!url && /^\d{5,20}$/.test(String(p.id || ''))) url = `https://steamcommunity.com/profiles/${p.id}`;
    if (!url) return;
    DL.api.openExternal(url);
    DL.toast({ title: t('hub.openingProfile', { name: p.name || '' }), icon: 'users' });
  }

  /** Centered icon + message for cards without data (no key, private profile, ...). */
  function emptyState(icon, text) {
    return el('div', { class: 'hub-empty' }, el('span', { class: 'hub-empty-ic' }, DL.icon(icon)), el('p', { class: 'hub-note', text }));
  }

  function card(kind, onClick) {
    const node = el('button', { class: `hub-card hub-${kind}`, nav: true, data: { kind }, on: { click: onClick } });
    return node;
  }

  // ---------------------------------------------------------------- cards
  /** Data that needs a key or account first (Steam or Xbox): shows what to do instead. */
  function needsAccount(data) {
    return !!(data && (data.needsKey || data.needsId || data.needsXboxKey || data.xboxAuth));
  }

  function accountState(node, body, data, forFriends) {
    if (data.needsKey || data.needsId) {
      body.appendChild(emptyState('key', t(data.needsId ? 'hub.needsId' : (forFriends ? 'hub.needsKeyFriends' : 'hub.needsKey'))));
      node.appendChild(more(t(data.needsId ? 'hub.openAccountsId' : 'hub.openAccounts')));
      return true;
    }
    if (data.needsXboxKey || data.xboxAuth) {
      body.appendChild(emptyState('key', t(data.xboxAuth ? 'hub.xboxAuth' : (forFriends ? 'hub.needsXboxFriends' : 'hub.needsXbox'))));
      node.appendChild(more(t('hub.openAccountsXbox')));
      return true;
    }
    if (data.notLinked) { body.appendChild(emptyState(forFriends ? 'users' : 'trophy', t('hub.xboxNotLinked'))); return true; }
    if (data.rateLimited) { body.appendChild(emptyState('clock', t('hub.xboxRateLimited'))); return true; }
    return false;
  }

  function achievementsCard(game, data) {
    const node = card('achievements', () => {
      if (needsAccount(data)) { DL.options.open('accounts'); return; }
      const a = data && data.achievements;
      if (a && !a.error && a.items && a.items.length) openAchievements(game, a);
    });
    const a = data && data.achievements;
    const total = a && !a.error ? a.total : null;
    node.appendChild(head('trophy', t('hub.achievements'), total ? `${DL.fmt.number(a.unlocked)} / ${DL.fmt.number(total)}` : null));
    const body = el('div', { class: 'hub-body' });
    node.appendChild(body);
    if (!data) { body.append(...skeleton([46, 10, 92, 54])); return node; }
    if (accountState(node, body, data, false)) return node;
    if (!a || a.error) {
      const key = a && a.error === 'private' ? 'hub.achPrivate' : (a && a.error === 'none' ? 'hub.achNone' : 'hub.achFailed');
      body.appendChild(emptyState(a && a.error === 'private' ? 'lock' : 'trophy', t(key)));
      return node;
    }
    const pct = a.total ? a.unlocked / a.total : 0;
    body.appendChild(el('div', { class: 'ach-progress' },
      el('span', { class: 'ach-big', text: DL.fmt.number(a.unlocked) }),
      el('span', { class: 'ach-of', text: t('hub.ofTotal', { n: DL.fmt.number(a.total) }) }),
      el('span', { class: 'ach-pct', text: DL.fmt.percent(pct) })));
    body.appendChild(el('div', { class: 'ach-bar' }, el('i', { style: { width: `${(pct * 100).toFixed(1)}%` } })));
    if (a.gamerscoreTotal) body.appendChild(el('div', { class: 'ach-gs', text: t('hub.gamerscore', { n: DL.fmt.number(a.gamerscore || 0), total: DL.fmt.number(a.gamerscoreTotal) }) }));
    // Latest unlocks (or, if none yet, the most common locked ones = the easiest next goals).
    const unlocked = a.items.filter((x) => x.achieved);
    const shown = (unlocked.length ? unlocked : a.items).slice(0, 3);
    const recent = el('div', { class: 'ach-recent' },
      el('div', { class: 'ach-recent-title', text: t(unlocked.length ? 'hub.recentUnlocks' : 'hub.nextGoals') }));
    for (const x of shown) {
      recent.appendChild(el('div', { class: 'ach-feature' },
        x.icon ? safeImg(x.icon, `ach-icon ${x.achieved ? '' : 'locked'}`) : el('span', { class: 'ach-icon' }),
        el('div', { class: 'ach-text' },
          el('div', { class: 'ach-name', text: x.name }),
          el('div', { class: 'ach-when', text: x.achieved ? t('hub.unlockedWhen', { when: DL.fmt.relativeDay(x.unlockTime) }) : (x.percent !== null ? t('hub.percentPlayers', { p: DL.fmt.number(x.percent, { maximumFractionDigits: 1 }) }) : t('hub.nextUp')) }))));
    }
    body.appendChild(recent);
    const strip = el('div', { class: 'ach-strip' });
    for (const x of unlocked.slice(3, 14)) if (x.icon) strip.appendChild(safeImg(x.icon, '', x.name));
    if (strip.children.length) body.appendChild(strip);
    node.appendChild(more(t('hub.showAll')));
    return node;
  }

  function achDesc(x) {
    if (x.hidden && !x.achieved && !x.desc) return t('hub.hiddenDesc');
    return x.desc || '';
  }

  /** Playing now first, then whoever played it most recently. */
  function byRecent(list) {
    return list.slice().sort((a, b) => (Number(!!b.playingNow) - Number(!!a.playingNow)) || (lastPlayedOf(b) - lastPlayedOf(a)) || ((b.minutes2w || 0) - (a.minutes2w || 0)) || (b.minutes - a.minutes));
  }

  function friendsCard(game, data) {
    const f = data && data.friends;
    const list = f && Array.isArray(f.list) ? byRecent(f.list) : null;
    const node = card('friends', () => {
      if (needsAccount(data)) { DL.options.open('accounts'); return; }
      if (list && list.length) openFriends(game, list);
    });
    node.appendChild(head('users', t('hub.friends'), list && list.length ? DL.fmt.number(list.length) : null));
    const body = el('div', { class: 'hub-body' });
    node.appendChild(body);
    if (!data) { body.append(...skeleton([46, 46, 46, 46])); return node; }
    if (accountState(node, body, data, true)) return node;
    if (f && f.building) {
      body.appendChild(el('p', { class: 'hub-note', text: t('hub.friendsLoading') }));
      body.append(...skeleton([46, 46]));
      return node;
    }
    if (!list || !list.length) {
      body.appendChild(emptyState('users', t('hub.noFriends')));
      return node;
    }
    const playing = list.filter((p) => p.playingNow).length;
    const facts = [t('meta.friendsPlayed', { n: DL.fmt.number(list.length), count: list.length })];
    if (playing) facts.push(t('hub.nPlayingNow', { n: DL.fmt.number(playing), count: playing }));
    body.appendChild(el('div', { class: 'friends-facts', text: facts.join(' · ') }));
    for (const p of list.slice(0, 6)) body.appendChild(el('div', { class: 'friend' }, avatar(p), friendText(p)));
    node.appendChild(more(t('hub.showAll')));
    return node;
  }

  function screenshotsCard(game, data) {
    const media = data ? mediaOf(data) : null;
    const items = media ? media.all : null;
    const node = card('screenshots', () => { if (items && items.length) openGallery(game, media); });
    const title = media && media.clips.length ? t('hub.media') : t('hub.screenshots');
    node.appendChild(head('image', title, items && items.length ? DL.fmt.number(items.length) : null));
    const body = el('div', { class: 'hub-body' });
    node.appendChild(body);
    if (!data) { body.appendChild(el('div', { class: 'hub-skel', style: { flex: '1' } })); return node; }
    if (!items.length) {
      body.appendChild(el('div', { class: 'shots-empty' },
        el('div', {}, DL.icon('camera'), el('p', { class: 'hub-note', text: t(game.screenshotSource === 'cemu' ? 'hub.noShotsCemu' : 'hub.noShotsSteam') }))));
      return node;
    }
    const n = Math.min(3, items.length);
    const mosaic = el('div', { class: `shots-mosaic ${n === 1 ? 'one' : n === 2 ? 'two' : ''}` });
    items.slice(0, n).forEach((m, i) => mosaic.appendChild(mediaThumb(m, i === 0 ? 420 : 220, 'shot')));
    body.appendChild(mosaic);
    node.appendChild(more(t('hub.showAll')));
    return node;
  }

  function infoCard(game, data, { wide = false } = {}) {
    const node = card('info', () => DL.gameMenu.open(game));
    node.appendChild(head('info', t('hub.about')));
    const body = el('div', { class: 'hub-body' });
    // Real playtime (Steam, Cemu, Xbox) or only what Dream Launcher counted / when it started it.
    const known = !!game.playtimeKnown;
    let playtime;
    if (known) playtime = game.playtimeMinutes > 0 ? DL.fmt.duration(game.playtimeMinutes) : t('meta.neverPlayed');
    else playtime = game.playtimeMinutes > 0 ? t('hub.trackedTime', { time: DL.fmt.duration(game.playtimeMinutes) }) : t('hub.unknown');
    const playtimeLabel = known && game.playtimeSource ? t('hub.playtimeFrom', { source: t(`hub.src.${game.playtimeSource}`) }) : t('hub.playtime');
    const lastMs = known ? game.lastPlayed : (game.lastPlayed > (game.lastBooted || 0) ? game.lastPlayed : (game.lastBooted || 0));
    const lastLabel = known || game.lastPlayed > (game.lastBooted || 0) ? t('hub.lastPlayed') : t('hub.lastBooted');
    const last = lastMs ? DL.fmt.relativeDay(lastMs, { dateOnly: !!game.lastPlayedDayOnly && lastMs === game.lastPlayed }) : '—';
    const size = DL.fmt.bytes(game.sizeBytes);
    const source = game.source === 'emulators' && game.platform ? `${game.sourceLabel} · ${game.platform}` : game.sourceLabel;
    const lines = [];
    if (wide) {
      // Full-width card (games without Steam data): big numbers first, details below.
      body.appendChild(el('div', { class: 'info-stats' },
        ...[['clock', playtimeLabel, playtime], ['calendar', lastLabel, last], ['download', t('hub.size'), size || '—']]
          .map(([ic, k, v]) => el('div', { class: 'info-stat' }, DL.icon(ic), el('b', { text: v }), el('span', { text: k })))));
      lines.push([t('hub.source'), source]);
      lines.push([t('hub.gameStatus'), statusLabel(game)]);
    } else {
      lines.push([t('hub.source'), source], [playtimeLabel, playtime], [lastLabel, last]);
      if (size) lines.push([t('hub.size'), size]);
    }
    if (game.subscription && DL.subscriptionInfo[game.subscription]) lines.push([t('menu.subscription'), DL.subscriptionInfo[game.subscription].label]);
    if (game.source === 'steam') {
      const fl = data && data.friends && Array.isArray(data.friends.list) ? data.friends.list : null;
      if (fl && fl.length) lines.push([t('hub.friends'), t('meta.friendsPlayed', { n: DL.fmt.number(fl.length), count: fl.length })]);
      const a = data && data.achievements;
      if (a && !a.error && a.total) lines.push([t('hub.achievements'), `${DL.fmt.number(a.unlocked)} / ${DL.fmt.number(a.total)}`]);
    }
    if (game.firstPlayed) lines.push([t('hub.firstPlayed'), DL.fmt.relativeDay(game.firstPlayed, { dateOnly: true })]);
    if (game.platform && game.source !== 'emulators') lines.push([t('hub.platform'), game.platform]);
    lines.push([t('hub.favorite'), t(game.favorite ? 'hub.yes' : 'hub.no')]);
    if (wide && game.installPath) lines.push([t('hub.location'), game.installPath]);
    body.appendChild(el('div', { class: 'info-list' }, ...lines.map(([k, v]) => el('div', { class: 'info-line' }, el('span', { text: k }), el('span', { text: v, attrs: { title: v } })))));
    node.appendChild(body);
    node.appendChild(more(t('hints.gameOptions')));
    return node;
  }

  function statusLabel(game) {
    if (game.status === 'running') return t('status.running');
    if (game.status === 'missing') return t('status.missing');
    if (game.status === 'updateRequired') return t('status.updateAvailable');
    return t(game.installed ? 'status.installed' : 'status.notInstalled');
  }

  function render(game, data) {
    const focusedKind = DL.nav.focused() && DL.nav.focused().closest && DL.nav.focused().closest('.hub-card') ? DL.nav.focused().dataset.kind : null;
    host.textContent = '';
    cards = [];
    const offline = DL.state.net.online === false || !!(data && data.offline);
    if (game.source === 'steam' && offline) {
      // Achievements and friends need the internet; screenshots are on this PC.
      cards = [screenshotsCard(game, data), infoCard(game, data)];
      host.className = 'hub cols-2 offline';
    } else if (game.source === 'steam') {
      cards = [achievementsCard(game, data), friendsCard(game, data), screenshotsCard(game, data)];
      host.className = 'hub cols-3';
    } else if (game.screenshotSource === 'cemu') {
      // Cemu (Wii U): its screenshots, matched to this game by when it was played.
      cards = [screenshotsCard(game, data), infoCard(game, data)];
      host.className = 'hub cols-2';
    } else if (game.source === 'xbox' && !offline) {
      cards = [achievementsCard(game, data), friendsCard(game, data), infoCard(game, data)];
      host.className = 'hub cols-3';
    } else {
      cards = [infoCard(game, data, { wide: true })];
      host.className = 'hub cols-1';
    }
    host.classList.toggle('is-hidden', !open);
    for (const c of cards) host.appendChild(c);
    if (open && focusedKind && DL.nav.top() && DL.nav.top().id === 'dashboard') {
      const again = cards.find((c) => c.dataset.kind === focusedKind);
      if (again) DL.nav.focus(again, { sound: false, force: true });
    }
  }

  function show(game) {
    current = game;
    const hit = cache.get(game.id);
    render(game, hit && hit.data ? hit.data : null);
    fetchHub(game).then((data) => {
      if (!open || !current || current.id !== game.id) return;
      render(game, data);
      // The friends list is built in the background on first use: look again shortly.
      if (data && data.friends && data.friends.building) {
        setTimeout(() => { if (open && current && current.id === game.id) fetchHub(game, { force: true }).then((d) => { if (open && current && current.id === game.id) render(game, d); }); }, 15000);
      }
    });
  }

  // ---------------------------------------------------------------- full views
  function openAchievements(game, a) {
    let filter = 'all';
    let sheet;
    const filters = ['all', 'unlocked', 'locked'];
    const renderList = (body) => {
      body.textContent = '';
      const chips = el('div', { class: 'chips' }, ...filters.map((f) => el('button', {
        class: `chip ${f === filter ? 'active' : ''}`, nav: true, text: t(`hub.filter.${f}`),
        on: { click: () => { if (filter !== f) { filter = f; renderList(body); DL.nav.refresh(); } } },
      })));
      const pct = a.total ? a.unlocked / a.total : 0;
      body.appendChild(el('div', { class: 'ach-sheet-top' }, chips,
        el('div', { class: 'ach-sheet-progress' },
          el('span', { text: `${DL.fmt.number(a.unlocked)} / ${DL.fmt.number(a.total)} · ${DL.fmt.percent(pct)}` }),
          el('span', { class: 'ach-bar' }, el('i', { style: { width: `${(pct * 100).toFixed(1)}%` } })))));
      const items = a.items.filter((x) => filter === 'all' || (filter === 'unlocked' ? x.achieved : !x.achieved));
      const list = el('div', { class: 'ach-list', attrs: { 'data-scroll': true } });
      for (const x of items) {
        const right = x.achieved
          ? el('div', { class: 'ach-right' }, el('span', { class: 'ach-check' }, DL.icon('check')), el('span', { text: DL.fmt.relativeDay(x.unlockTime) }))
          : el('div', { class: 'ach-right' }, x.percent !== null ? el('span', { text: t('hub.percentPlayers', { p: DL.fmt.number(x.percent, { maximumFractionDigits: 1 }) }) }) : null);
        if (x.gamerscore) right.appendChild(el('span', { class: 'ach-gs-pill', text: `${DL.fmt.number(x.gamerscore)} G` }));
        list.appendChild(el('div', { class: `ach-row ${x.achieved ? 'done' : 'locked'}`, nav: true, attrs: { 'data-silent': true } },
          x.icon ? safeImg(x.icon, `ach-icon ${x.achieved ? '' : 'locked'}`) : el('span', { class: 'ach-icon' }, DL.icon('lock')),
          el('div', { class: 'ach-text' }, el('div', { class: 'ach-name', text: x.name }), el('div', { class: 'ach-desc', text: achDesc(x) })),
          right));
      }
      if (!items.length) list.appendChild(el('div', { class: 'empty-note', text: t('hub.filterEmpty') }));
      body.appendChild(list);
    };
    sheet = DL.ui.openSheet({
      id: 'achievements',
      cls: 'full',
      title: t('hub.achievements'),
      subtitle: game.name,
      build: (body) => renderList(body),
      initial: (panel) => panel.querySelector('.ach-row') || panel.querySelector('.chip'),
      hints: [['lbrb', t('hints.filter')], ['back', t('hints.back')]],
      onAction(action) {
        if (action === 'lb' || action === 'rb') {
          filter = filters[(filters.indexOf(filter) + (action === 'rb' ? 1 : -1) + filters.length) % filters.length];
          DL.sound.play('toggle');
          renderList(sheet.body);
          const first = sheet.body.querySelector('.ach-row') || sheet.body.querySelector('.chip.active');
          DL.nav.focus(first, { sound: false, force: true });
          return true;
        }
        if (action === 'lt' || action === 'rt') {
          const list = sheet.body.querySelector('.ach-list');
          if (list) list.scrollBy({ top: (action === 'rt' ? 1 : -1) * list.clientHeight * 0.8 });
          return true;
        }
        return false;
      },
    });
  }

  function openFriends(game, list) {
    const playing = list.filter((p) => p.playingNow).length;
    const sheet = DL.ui.openSheet({
      id: 'friends',
      cls: 'side',
      title: t('hub.friends'),
      subtitle: game.name,
      build(body) {
        body.appendChild(el('div', { class: 'friends-summary' },
          el('div', {}, el('b', { text: DL.fmt.number(list.length) }), el('span', { text: t('hub.sumPlayed') })),
          el('div', {}, el('b', { text: DL.fmt.number(playing) }), el('span', { text: t('hub.sumPlaying') }))));
        const wrap = el('div', { class: 'menu-list', attrs: { 'data-scroll': true } });
        for (const p of list) {
          wrap.appendChild(el('button', { class: 'friend-row', nav: true, on: { click: () => openProfile(p) } }, avatar(p), friendText(p, { long: true })));
        }
        body.appendChild(wrap);
      },
      initial: (panel) => panel.querySelector('.friend-row'),
      hints: [['confirm', t('hub.openProfile')], ['back', t('hints.back')]],
    });
    return sheet;
  }

  function openGallery(game, media) {
    const filters = media.clips.length && media.shots.length ? ['all', 'shots', 'clips'] : ['all'];
    let filter = 'all';
    let sheet;
    const listFor = (f) => (f === 'shots' ? media.shots : f === 'clips' ? media.clips : media.all);
    const countText = () => {
      const parts = [];
      if (media.shots.length) parts.push(t('hub.shotCount', { n: DL.fmt.number(media.shots.length), count: media.shots.length }));
      if (media.clips.length) parts.push(t('hub.clipCount', { n: DL.fmt.number(media.clips.length), count: media.clips.length }));
      return parts.join(' · ');
    };
    const renderGrid = (body) => {
      body.textContent = '';
      if (filters.length > 1) {
        body.appendChild(el('div', { class: 'chips gallery-chips' }, ...filters.map((f) => el('button', {
          class: `chip ${f === filter ? 'active' : ''}`, nav: true, text: t(`hub.mediaFilter.${f}`),
          on: { click: () => { if (filter !== f) { filter = f; renderGrid(body); DL.nav.refresh(); } } },
        }))));
      }
      const list = listFor(filter);
      const grid = el('div', { class: 'gallery-grid', attrs: { 'data-scroll': true } });
      list.forEach((m, i) => {
        grid.appendChild(el('button', { class: 'gallery-item', nav: true, data: { i: String(i) }, on: { click: () => openViewer(game, list, i) } },
          mediaThumb(m, 480, 'gallery-frame')));
      });
      body.appendChild(grid);
    };
    sheet = DL.ui.openSheet({
      id: 'gallery',
      cls: 'full',
      title: media.clips.length ? t('hub.media') : t('hub.screenshots'),
      subtitle: game.name,
      build(body) { renderGrid(body); },
      initial: (panel) => panel.querySelector('.gallery-item'),
      hints: filters.length > 1
        ? [['confirm', t('hub.view')], ['lbrb', t('hints.filter')], ['back', t('hints.back')]]
        : [['confirm', t('hub.view')], ['back', t('hints.back')]],
      onAction(action) {
        if ((action === 'lb' || action === 'rb') && filters.length > 1) {
          filter = filters[(filters.indexOf(filter) + (action === 'rb' ? 1 : -1) + filters.length) % filters.length];
          DL.sound.play('toggle');
          renderGrid(sheet.body);
          DL.nav.focus(sheet.body.querySelector('.gallery-item') || sheet.body.querySelector('.chip.active'), { sound: false, force: true });
          return true;
        }
        if (action === 'lt' || action === 'rt') {
          const grid = sheet.body.querySelector('.gallery-grid');
          if (grid) grid.scrollBy({ top: (action === 'rt' ? 1 : -1) * grid.clientHeight * 0.8 });
          return true;
        }
        return false;
      },
    });
    sheet.headExtra.textContent = countText();
  }

  /** Full-screen view of screenshots and clips; clips play right here. */
  function openViewer(game, items, start) {
    let i = start;
    let sheet;
    let player = null;
    let token = 0; // ignores a clip that finishes loading after moving on
    let musicPaused = false;
    const img = el('img', { class: 'viewer-img', attrs: { alt: '', draggable: 'false' } });
    const video = el('video', { class: 'viewer-video', attrs: { playsinline: '', preload: 'auto', disablepictureinpicture: '' } });
    const bigPlay = el('div', { class: 'clip-bigplay' }, DL.icon('play'));
    const msg = el('div', { class: 'clip-msg' });
    const spinner = el('div', { class: 'clip-spinner' });
    const playBtn = el('button', { class: 'clip-btn', attrs: { 'aria-label': t('hub.playPause') }, on: { click: (e) => { e.stopPropagation(); if (player) player.toggle(); } } }, DL.icon('play'));
    const posText = el('span', { class: 'clip-time', text: '0:00' });
    const lenText = el('span', { class: 'clip-time', text: '0:00' });
    const bufBar = el('i', { class: 'clip-buf' });
    const posBar = el('i', { class: 'clip-pos' });
    const track = el('div', { class: 'clip-track' }, bufBar, posBar);
    const bar = el('div', { class: 'clip-bar' }, playBtn, posText, track, lenText);
    const info = el('div', { class: 'viewer-info' });
    let stage;

    track.addEventListener('pointerdown', (e) => {
      if (!player || player.info.error) return;
      const r = track.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      player.seek(f * (player.info.duration || 0));
    });
    video.addEventListener('click', () => { if (player) player.toggle(); });
    bigPlay.addEventListener('click', () => { if (player) player.toggle(); });

    const errorText = (code) => {
      if (code === 'codec') {
        const c = player && player.info.codec;
        const name = c === 'hevc' ? 'HEVC (H.265)' : c === 'av1' ? 'AV1' : c === 'h264' ? 'H.264' : '';
        return name ? t('hub.clipCodec', { codec: name }) : t('hub.clipCodecUnknown');
      }
      if (code === 'notFound' || code === 'empty') return t('hub.clipMissing');
      if (code === 'memory') return t('hub.clipTooBig');
      return t('hub.clipFailed');
    };

    const paint = (st) => {
      if (!player) return;
      if (st.error) {
        stage.classList.add('clip-error');
        stage.classList.remove('clip-paused', 'clip-waiting');
        msg.textContent = errorText(st.error);
        return;
      }
      const d = st.duration || 0;
      const cur = player.currentTime || 0;
      posText.textContent = DL.clips.clock(cur);
      lenText.textContent = DL.clips.clock(d);
      posBar.style.width = `${d ? Math.min(100, (cur / d) * 100) : 0}%`;
      bufBar.style.width = `${d ? Math.min(100, (player.buffered() / d) * 100) : 0}%`;
      const paused = player.paused || player.ended;
      stage.classList.toggle('clip-paused', paused && !st.error);
      stage.classList.toggle('clip-waiting', !paused && video.readyState < 3 && !st.error);
      if (playBtn.dataset.state !== String(paused)) {
        playBtn.dataset.state = String(paused);
        playBtn.textContent = '';
        playBtn.appendChild(DL.icon(paused ? 'play' : 'pauseFill'));
      }
      stage.classList.toggle('clip-muted', !!st.muted);
    };

    const stopClip = () => {
      token++;
      if (player) { player.destroy(); player = null; }
      stage.classList.remove('is-clip', 'clip-error', 'clip-paused', 'clip-waiting', 'clip-muted', 'clip-loading');
      msg.textContent = '';
      if (musicPaused) { DL.music.resume('clip'); musicPaused = false; }
    };

    const hintsFor = (item) => (item.kind === 'clip'
      ? [['confirm', t('hub.playPause'), () => player && player.toggle()], ['ltrt', t('hub.seek10')], ['leftright', t('hub.prevNext')], ['x', t('hub.showInFolder'), () => showInFolder()], ['back', t('hints.close'), () => sheet.close()]]
      : [['leftright', t('hub.prevNext')], ['x', t('hub.showInFolder'), () => showInFolder()], ['back', t('hints.close'), () => sheet.close()]]);

    const showInFolder = () => {
      const item = items[i];
      if (item.kind === 'clip') DL.api.showClipInFolder(item.id);
      else DL.api.showScreenshotInFolder(item.id);
    };

    const startClip = async (item) => {
      const my = ++token;
      stage.classList.add('is-clip', 'clip-loading');
      lenText.textContent = DL.clips.clock(item.duration || 0);
      posText.textContent = '0:00';
      posBar.style.width = '0%';
      bufBar.style.width = '0%';
      if (!musicPaused) { DL.music.pause('clip'); musicPaused = true; }
      let manifest;
      try { manifest = await DL.api.clipManifest(item.id); } catch { manifest = { error: 'read' }; }
      if (my !== token || (sheet && sheet.closed)) return;
      stage.classList.remove('clip-loading');
      if (!manifest || manifest.error) {
        stage.classList.add('clip-error');
        msg.textContent = errorText(manifest ? manifest.error : 'read');
        return;
      }
      player = DL.clips.play(video, manifest, { onState: paint });
      if (!player.info.error) player.play();
      paint(player.info);
    };

    const show = () => {
      const item = items[i];
      stopClip();
      info.textContent = `${i + 1} / ${items.length}  ·  ${DL.fmt.dateTime(item.time)}`;
      if (sheet) sheet.setHints(hintsFor(item));
      if (item.kind === 'clip') {
        img.classList.remove('loaded');
        img.removeAttribute('src');
        startClip(item);
        return;
      }
      img.classList.remove('loaded');
      img.onload = () => img.classList.add('loaded');
      img.src = item.full;
      // Preload the neighbours (screenshots only).
      for (const j of [i + 1, i - 1]) if (items[j] && items[j].kind !== 'clip') { const p = new Image(); p.src = items[j].full; }
    };
    const step = (dir) => {
      const n = i + dir;
      if (n < 0 || n >= items.length) { DL.sound.play('error'); return; }
      i = n;
      DL.sound.play('move');
      show();
    };
    sheet = DL.ui.openSheet({
      id: 'viewer',
      cls: 'viewer',
      title: game.name,
      build(body) {
        const prev = el('button', { class: 'viewer-nav prev', nav: true, attrs: { 'data-silent': true }, on: { click: () => step(-1) } }, DL.icon('chevronLeft'));
        const next = el('button', { class: 'viewer-nav next', nav: true, attrs: { 'data-silent': true }, on: { click: () => step(1) } }, DL.icon('chevron'));
        stage = el('div', { class: 'viewer-stage' }, img, video, bigPlay, spinner, msg, prev, next);
        body.appendChild(stage);
        body.appendChild(bar);
        body.appendChild(info);
      },
      initial: (panel) => panel.querySelector('.viewer-nav.next'),
      hints: hintsFor(items[i]),
      onClose: () => stopClip(),
      onMove(dir) {
        if (dir === 'left' || dir === 'right') { step(dir === 'right' ? 1 : -1); return true; }
        return true;
      },
      onAction(action) {
        const clip = items[i].kind === 'clip';
        if (action === 'x') { showInFolder(); return true; }
        if (action === 'confirm') { if (clip && player) { player.toggle(); DL.sound.play('toggle'); } return true; }
        if (action === 'lb' || action === 'rb') { step(action === 'rb' ? 1 : -1); return true; }
        if (action === 'lt' || action === 'rt') {
          if (clip && player && !player.info.error) { player.seekBy(action === 'rt' ? 10 : -10); DL.sound.play('move'); }
          return true;
        }
        return false;
      },
    });
    show();
  }

  // ---------------------------------------------------------------- public
  DL.hub = {
    init(dashboardApi) {
      api = dashboardApi;
      host = DL.$('#hub');
      host.classList.add('is-hidden');
    },
    isOpen: () => open,
    open(game) {
      open = true;
      host.setAttribute('aria-hidden', 'false');
      show(game);
      host.classList.remove('is-hidden');
    },
    close() {
      open = false;
      host.setAttribute('aria-hidden', 'true');
      host.classList.add('is-hidden');
    },
    prefetch(game) {
      clearTimeout(prefetchTimer);
      if (!game) return;
      prefetchTimer = setTimeout(() => { fetchHub(game).catch(() => {}); }, 900);
    },
    firstCard: () => cards[0] || null,
    cardAt: (i) => (i >= 0 ? cards[i] || null : null),
    focusedIndex() {
      const f = DL.nav.focused();
      return f ? cards.indexOf(f) : -1;
    },
    move(dir) {
      const i = cards.indexOf(DL.nav.focused());
      const n = i + dir;
      if (n >= 0 && n < cards.length) DL.nav.focus(cards[n]);
    },
    invalidate(id) { if (id) cache.delete(id); else cache.clear(); },
    /** Shows the panel again if it is waiting for the Steam key / account (e.g. after the first scan). */
    /** Fetches and shows the open panel again (new friends list). */
    reload() { if (open && current) show(current); },
    retryIfMissing() {
      if (!open || !current) return;
      const hit = cache.get(current.id);
      if (hit && hit.data && (hit.data.needsKey || hit.data.needsId)) show(current);
    },
    get api() { return api; },
  };
})();
