/* Dream Launcher - core helpers shared by all interface modules. */
(function () {
  'use strict';
  const DL = (window.DL = window.DL || {});

  DL.api = window.dl;

  DL.state = {
    settings: null,
    system: {},
    profile: {},
    presets: [],
    games: [],
    byId: new Map(),
    sources: {},
    hasBattery: null,
    selectedId: null,
    pinnedId: null,
    details: new Map(),
    friendsSummary: {}, // Steam app id or "xbox:<title id>" -> { count, people } (from saved friend lists)
    net: { online: true, mode: 'auto', reason: null, services: {} }, // online / offline (see net.js)
    inputMode: 'keyboard', // 'keyboard' | 'mouse' | 'gamepad'
    padKind: 'xbox', // 'xbox' | 'playstation' | 'nintendo' | 'generic'
    infoHidden: false,
    gameRunning: false,
    ready: false,
  };

  /** Small DOM builder. el('div', {class:'a', text:'b', on:{click:fn}, data:{x:1}, attrs:{...}}, child...) */
  DL.el = function el(tag, opts, ...children) {
    const node = document.createElement(tag);
    const o = opts || {};
    if (o.class) node.className = o.class;
    if (o.text !== undefined && o.text !== null) node.textContent = String(o.text);
    if (o.id) node.id = o.id;
    if (o.title) node.title = o.title;
    if (o.type) node.type = o.type;
    if (o.nav) node.setAttribute('data-nav', '');
    if (o.data) for (const [k, v] of Object.entries(o.data)) node.dataset[k] = v;
    if (o.attrs) for (const [k, v] of Object.entries(o.attrs)) if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : String(v));
    if (o.style) for (const [k, v] of Object.entries(o.style)) node.style.setProperty(k, v);
    if (o.on) for (const [k, v] of Object.entries(o.on)) node.addEventListener(k, v);
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return node;
  };

  /** Creates an SVG element from trusted, static markup (icons only). */
  DL.svg = function svg(markup) {
    const t = document.createElement('template');
    t.innerHTML = markup.trim();
    return t.content.firstElementChild;
  };

  DL.$ = (sel, root) => (root || document).querySelector(sel);
  DL.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  DL.clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  DL.debounce = (fn, ms) => {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };
  DL.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------------ event bus
  const listeners = new Map();
  DL.bus = {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name).delete(fn);
    },
    emit(name, ...args) {
      const set = listeners.get(name);
      if (!set) return;
      for (const fn of [...set]) {
        try { fn(...args); } catch (err) { console.error(`[bus] ${name}`, err); }
      }
    },
  };

  // ------------------------------------------------------------ library state
  DL.setLibrary = function setLibrary(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.games)) return;
    DL.state.games = snapshot.games;
    DL.state.byId = new Map(snapshot.games.map((g) => [g.id, g]));
    DL.state.sources = snapshot.sources || {};
    if (typeof snapshot.hasBattery === 'boolean') DL.state.hasBattery = snapshot.hasBattery;
    DL.state.scanning = !!snapshot.scanning;
    DL.bus.emit('library');
  };

  DL.visibleGames = function visibleGames() {
    const showHidden = DL.state.settings && DL.state.settings.showHiddenGames;
    return DL.state.games.filter((g) => showHidden || !g.hidden);
  };

  DL.updateGame = function updateGame(game) {
    if (!game || !game.id) return;
    const idx = DL.state.games.findIndex((g) => g.id === game.id);
    if (idx >= 0) DL.state.games[idx] = game; else DL.state.games.push(game);
    DL.state.byId.set(game.id, game);
    DL.bus.emit('library');
  };

  // ------------------------------------------------------------ settings
  DL.saveSettings = async function saveSettings(patch) {
    const before = DL.state.settings;
    // Optimistic update so the interface reacts immediately.
    DL.state.settings = { ...before, ...patch, sources: { ...before.sources, ...(patch.sources || {}) } };
    DL.bus.emit('settings', patch);
    try {
      const fresh = await DL.api.setSettings(patch);
      if (fresh && !fresh.error) {
        DL.state.settings = fresh;
        DL.bus.emit('settings', {});
      }
    } catch (err) {
      console.error('saveSettings', err);
    }
    return DL.state.settings;
  };

  // ------------------------------------------------------------ formatting
  function uiLocale() {
    return (DL.i18n && DL.i18n.locale) || 'en';
  }

  /** Locale for dates/times: interface language + the system's region (e.g. en-DE). */
  DL.formatLocale = function formatLocale() {
    const lang = uiLocale();
    const sys = String(DL.state.system.locale || '');
    const region = /^[a-z]{2,3}-([A-Z]{2})/i.exec(sys);
    const base = lang.split('-')[0];
    if (region) {
      const candidate = `${base}-${region[1].toUpperCase()}`;
      try {
        if (Intl.DateTimeFormat.supportedLocalesOf([candidate]).length) return candidate;
      } catch { /* ignore */ }
    }
    return lang;
  };

  DL.fmt = {
    number(n, opts) {
      try { return new Intl.NumberFormat(uiLocale(), opts).format(n); } catch { return String(n); }
    },
    playtime(minutes) {
      const m = Math.max(0, Math.round(minutes || 0));
      if (m <= 0) return DL.t('meta.neverPlayed');
      if (m < 60) return DL.t('meta.minutesPlayed', { n: m });
      const h = m / 60;
      const value = h < 10 ? DL.fmt.number(Math.round(h * 10) / 10, { maximumFractionDigits: 1 }) : DL.fmt.number(Math.round(h));
      return DL.t('meta.hoursPlayed', { n: value, count: Math.round(h) });
    },
    hours(minutes) {
      return DL.fmt.number(Math.round((minutes || 0) / 60));
    },
    time(date) {
      const fmt = DL.state.settings ? DL.state.settings.clockFormat : 'auto';
      const opts = { hour: 'numeric', minute: '2-digit' };
      if (fmt === '12h') opts.hour12 = true;
      if (fmt === '24h') { opts.hour12 = false; opts.hour = '2-digit'; }
      const loc = fmt === 'auto' ? (DL.state.system.locale || DL.formatLocale()) : DL.formatLocale();
      try { return new Intl.DateTimeFormat(loc, opts).format(date); } catch { return date.toTimeString().slice(0, 5); }
    },
    date(date) {
      try {
        return new Intl.DateTimeFormat(DL.formatLocale(), { weekday: 'short', day: 'numeric', month: 'short' }).format(date);
      } catch { return date.toDateString(); }
    },
    /** "Saturday, 21 November" style date for the top bar. */
    longDate(date) {
      try {
        return new Intl.DateTimeFormat(DL.formatLocale(), { weekday: 'long', day: 'numeric', month: 'long' }).format(date);
      } catch { return date.toDateString(); }
    },
    /** "Mar 2024" (or "Mar 12" within the current year). */
    shortDate(ms) {
      if (!ms) return '';
      const d = new Date(ms);
      const sameYear = d.getFullYear() === new Date().getFullYear();
      try {
        return new Intl.DateTimeFormat(DL.formatLocale(), sameYear ? { day: 'numeric', month: 'short' } : { month: 'short', year: 'numeric' }).format(d);
      } catch { return d.toDateString(); }
    },
    dateTime(ms) {
      if (!ms) return '';
      try {
        return new Intl.DateTimeFormat(DL.formatLocale(), { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
      } catch { return new Date(ms).toLocaleString(); }
    },
    /** Short duration without "played": "45 min", "3.5 h", "120 h". */
    duration(minutes) {
      const m = Math.max(0, Math.round(minutes || 0));
      if (m < 60) return DL.t('meta.minutes', { n: DL.fmt.number(m) });
      const h = m / 60;
      const value = h < 10 ? DL.fmt.number(Math.round(h * 10) / 10, { maximumFractionDigits: 1 }) : DL.fmt.number(Math.round(h));
      return DL.t('meta.hours', { n: value });
    },
    /** "today, 21:30", "yesterday", "3 days ago", "12 Mar". dateOnly: no clock time (day-exact dates). */
    relativeDay(ms, { dateOnly = false } = {}) {
      if (!ms) return '';
      const d = new Date(ms);
      const now = new Date();
      const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
      const days = Math.round((startOf(now) - startOf(d)) / 86400000);
      let rtf = null;
      try { rtf = new Intl.RelativeTimeFormat(uiLocale(), { numeric: 'auto' }); } catch { rtf = null; }
      if (days <= 1 && days >= 0 && rtf) {
        if (dateOnly) return rtf.format(-days, 'day');
        return DL.t('meta.dayTime', { day: rtf.format(-days, 'day'), time: DL.fmt.time(d) });
      }
      if (days > 1 && days < 7 && rtf) return rtf.format(-days, 'day');
      const sameYear = d.getFullYear() === now.getFullYear();
      try {
        return new Intl.DateTimeFormat(DL.formatLocale(), { day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric' }).format(d);
      } catch { return d.toDateString(); }
    },
    bytes(n) {
      if (!n || n <= 0) return '';
      const gb = n / 1024 ** 3;
      if (gb >= 1) return `${DL.fmt.number(gb, { maximumFractionDigits: 1 })} GB`;
      return `${DL.fmt.number(n / 1024 ** 2, { maximumFractionDigits: 0 })} MB`;
    },
    percent(p) {
      return DL.fmt.number(p, { style: 'percent', maximumFractionDigits: 0 });
    },
  };

  // ------------------------------------------------------------ icons
  DL.icons = {
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
    importer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M4 20h16"/></svg>',
    options: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2.3"/><circle cx="10" cy="17" r="2.3"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l12.5-7.5z"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    controller: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 8h10a5 5 0 0 1 4.8 6.3l-1 3.6a2.5 2.5 0 0 1-4.3.9L14.6 16H9.4l-1.9 2.8a2.5 2.5 0 0 1-4.3-.9l-1-3.6A5 5 0 0 1 7 8z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9.5"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 11v6M12 7.5v.5"/><circle cx="12" cy="12" r="9.5"/></svg>',
    library: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"/></svg>',
    trophy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H5v1a3 3 0 0 0 3 3M16 6h3v1a3 3 0 0 1-3 3M12 13v4M8.5 20h7M10 17h4"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 9"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/></svg>',
    external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>',
    chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
    chevronLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>',
    backspace: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M9 5h11v14H9l-6-7z"/><path d="M12.5 9.5l5 5M17.5 9.5l-5 5"/></svg>',
    shift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 4l8 8h-4.5v7h-7v-7H4z"/></svg>',
    space: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 11v4h16v-4"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
    store: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 9l1.5-5h13L20 9M4 9h16v11H4zM9 13h6"/></svg>',
    badge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="6"/></svg>',
    quit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><path d="M12 3v8M6.3 6.6a8 8 0 1 0 11.4 0"/></svg>',
    minimize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 17h14"/></svg>',
  };
  DL.icon = (name, cls) => {
    const node = DL.svg(DL.icons[name] || DL.icons.info);
    node.setAttribute('aria-hidden', 'true');
    if (cls) node.setAttribute('class', cls);
    return node;
  };

  // ------------------------------------------------------------ store / subscription labels
  DL.storeInfo = {
    steam: { label: 'STEAM', color: '#66c0f4' },
    epic: { label: 'EPIC', color: '#e5e5e5' },
    gog: { label: 'GOG', color: '#b57bff' },
    ubisoft: { label: 'UBISOFT', color: '#3d8bff' },
    xbox: { label: 'XBOX', color: '#5dc21e' },
    emulators: { label: 'EMULATOR', color: '#f5a524' },
    manual: { label: 'PC', color: '#a1a1aa' },
  };
  DL.subscriptionInfo = {
    gamepass: { label: 'GAME PASS', color: '#1f9d55' },
    eaplay: { label: 'EA PLAY', color: '#e2353d' },
    ubisoftplus: { label: 'UBISOFT+', color: '#0a6cff' },
  };

  DL.badge = function badge(game, { forHero = false } = {}) {
    const s = DL.state.settings || {};
    const out = [];
    if (s.showStoreBadges !== false || forHero) {
      const info = DL.storeInfo[game.source] || { label: String(game.source).toUpperCase(), color: '#fff' };
      const label = game.source === 'emulators' && game.platform ? game.platform.toUpperCase() : info.label;
      out.push(DL.el('span', { class: 'bd' }, DL.el('i', { style: { background: info.color } }), label));
    }
    if (game.subscription && (s.showSubscriptionBadges !== false || forHero)) {
      const sub = DL.subscriptionInfo[game.subscription];
      if (sub) out.push(DL.el('span', { class: 'bd sub', style: { background: sub.color } }, DL.el('i', { style: { background: '#fff' } }), sub.label));
    }
    return out;
  };

  /** Fallback art: a gradient tile with the game's initials, colour derived from the name. */
  DL.fallbackHue = function fallbackHue(name) {
    let h = 0;
    for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  };

  // ------------------------------------------------------------ toast
  let toastTimer = null;
  DL.toast = function toast({ title, sub = '', icon = 'info', tone = '', duration = 3200 } = {}) {
    const host = document.getElementById('toast-host');
    if (!host) return;
    host.textContent = '';
    const node = DL.el('div', { class: `toast ${tone}` },
      DL.el('span', { class: `toast-ic ${tone}` }, DL.icon(icon)),
      DL.el('b', { text: title }),
      sub ? DL.el('span', { class: 'toast-sub', text: sub }) : null);
    host.appendChild(node);
    requestAnimationFrame(() => node.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      node.classList.remove('show');
      setTimeout(() => node.remove(), 400);
    }, duration);
    if (DL.sound) DL.sound.play(tone === 'error' ? 'error' : 'toast');
  };

  /** Shows a readable message for an error object returned by the main process. */
  DL.showError = function showError(res, fallbackKey = 'errors.generic') {
    const code = res && res.error;
    const key = code && DL.i18n.has(`errors.${code}`) ? `errors.${code}` : fallbackKey;
    DL.toast({ title: DL.t(key), icon: 'warn', tone: 'error' });
  };
})();
