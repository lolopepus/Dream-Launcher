/* Dream Launcher - translations. Locale files live in js/locales/*.js */
(function () {
  'use strict';
  const DL = (window.DL = window.DL || {});
  const LOCALES = (window.DL_LOCALES = window.DL_LOCALES || {});

  const SUPPORTED = ['en', 'de', 'pl'];
  const NAMES = {
    en: 'English', de: 'Deutsch', pl: 'Polski',
  };

  function lookup(table, key) {
    let cur = table;
    for (const part of key.split('.')) {
      if (!cur || typeof cur !== 'object' || !(part in cur)) return undefined;
      cur = cur[part];
    }
    return cur;
  }

  function resolveAuto(candidates) {
    for (const raw of candidates) {
      if (!raw) continue;
      const tag = String(raw).replace('_', '-');
      const lower = tag.toLowerCase();
      const base = lower.split('-')[0];
      const hit = SUPPORTED.find((s) => s.toLowerCase() === base);
      if (hit) return hit;
    }
    return 'en';
  }

  const i18n = {
    locale: 'en',
    supported: SUPPORTED,
    names: NAMES,
    /** Sets the interface language ('auto' follows the system). */
    set(setting) {
      let lang = setting;
      if (!lang || lang === 'auto' || !SUPPORTED.includes(lang)) {
        const sys = DL.state && DL.state.system ? DL.state.system : {};
        lang = resolveAuto([...(sys.languages || []), sys.locale, ...(navigator.languages || []), navigator.language]);
      }
      this.locale = LOCALES[lang] ? lang : 'en';
      document.documentElement.lang = this.locale;
      this.plural = new Intl.PluralRules(this.locale);
      return this.locale;
    },
    has(key) {
      return lookup(LOCALES[this.locale] || {}, key) !== undefined || lookup(LOCALES.en || {}, key) !== undefined;
    },
    t(key, params) {
      let v = lookup(LOCALES[this.locale] || {}, key);
      if (v === undefined) v = lookup(LOCALES.en || {}, key);
      if (v === undefined) return key;
      if (v && typeof v === 'object') {
        const n = params && (params.count !== undefined ? params.count : params.n);
        const cat = typeof n === 'number' && this.plural ? this.plural.select(n) : 'other';
        v = v[cat] !== undefined ? v[cat] : v.other;
        if (v === undefined) return key;
      }
      if (params) {
        v = String(v).replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined && params[k] !== null ? String(params[k]) : m));
      }
      return String(v);
    },
    /** Applies translations to elements with data-i18n / data-i18n-title attributes. */
    apply(root) {
      for (const node of (root || document).querySelectorAll('[data-i18n]')) node.textContent = this.t(node.getAttribute('data-i18n'));
      for (const node of (root || document).querySelectorAll('[data-i18n-label]')) node.setAttribute('aria-label', this.t(node.getAttribute('data-i18n-label')));
    },
  };
  i18n.plural = new Intl.PluralRules('en');

  DL.i18n = i18n;
  DL.t = (key, params) => i18n.t(key, params);
})();
