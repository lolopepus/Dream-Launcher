/*
 * Dream Launcher - focus and navigation.
 * Every screen/overlay is a "scope". Elements with [data-nav] can be focused with the
 * controller or arrow keys; directions use spatial navigation (nearest element in that direction).
 */
(function () {
  'use strict';
  const DL = (window.DL = window.DL || {});

  const scopes = [];
  let globalHandler = null;

  function isDisabled(el) {
    return el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
  }

  function isVisible(el) {
    if (!el.isConnected || el.closest('[hidden], .is-hidden')) return false;
    return el.getClientRects().length > 0;
  }

  function candidates(scope) {
    return Array.from(scope.root.querySelectorAll('[data-nav]')).filter((el) => !isDisabled(el) && isVisible(el));
  }

  function center(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

  function overlap(a1, a2, b1, b2) { return Math.min(a2, b2) - Math.max(a1, b1); }

  /** Picks the best element in a direction. Elements sharing a row/column win over diagonal ones. */
  function pick(from, list, dir) {
    const fr = from.getBoundingClientRect();
    const fc = center(fr);
    let best = null;
    let bestScore = Infinity;
    for (const el of list) {
      if (el === from) continue;
      const r = el.getBoundingClientRect();
      const c = center(r);
      let primary;
      let ov;
      let cross;
      if (dir === 'left' || dir === 'right') {
        const ahead = dir === 'right' ? c.x > fc.x + 1 && r.right > fr.right - 1 : c.x < fc.x - 1 && r.left < fr.left + 1;
        if (!ahead) continue;
        primary = dir === 'right' ? Math.max(0, r.left - fr.right) : Math.max(0, fr.left - r.right);
        ov = overlap(fr.top, fr.bottom, r.top, r.bottom);
        cross = Math.abs(c.y - fc.y);
      } else {
        const ahead = dir === 'down' ? c.y > fc.y + 1 && r.bottom > fr.bottom - 1 : c.y < fc.y - 1 && r.top < fr.top + 1;
        if (!ahead) continue;
        primary = dir === 'down' ? Math.max(0, r.top - fr.bottom) : Math.max(0, fr.top - r.bottom);
        ov = overlap(fr.left, fr.right, r.left, r.right);
        cross = Math.abs(c.x - fc.x);
      }
      const score = ov > 0 ? primary + cross * 0.05 : 100000 + primary * 2 + cross;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  function scrollIntoView(el) {
    const container = el.closest('[data-scroll]');
    if (!container) return;
    const reduce = DL.state.settings && DL.state.settings.reduceMotion;
    const cr = container.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const scale = cr.height / container.clientHeight || 1;
    const pad = 40 * scale;
    let delta = 0;
    if (er.top - pad < cr.top) delta = (er.top - pad - cr.top) / scale;
    else if (er.bottom + pad > cr.bottom) delta = (er.bottom + pad - cr.bottom) / scale;
    if (delta) container.scrollBy({ top: delta, behavior: reduce ? 'auto' : 'smooth' });
  }

  const nav = {
    /** Adds a scope on top. scope: { id, root, onAction, onMove, onBack, onFocus, initial } */
    push(scope) {
      const prev = nav.top();
      if (prev) prev.root.classList.add('scope-inactive');
      scope.focused = null;
      scopes.push(scope);
      const first = typeof scope.initial === 'function' ? scope.initial() : scope.initial;
      const target = first || candidates(scope)[0];
      if (target) nav.focus(target, { sound: false });
      return scope;
    },
    pop(scope) {
      const idx = scope ? scopes.indexOf(scope) : scopes.length - 1;
      if (idx < 0) return;
      const [removed] = scopes.splice(idx, 1);
      if (removed && removed.focused) removed.focused.classList.remove('is-focused');
      const top = nav.top();
      if (top) {
        top.root.classList.remove('scope-inactive');
        if (top.focused && top.focused.isConnected && isVisible(top.focused)) nav.focus(top.focused, { sound: false, force: true });
        else {
          const first = typeof top.initial === 'function' ? top.initial() : top.initial;
          const target = first || candidates(top)[0];
          if (target) nav.focus(target, { sound: false });
        }
      }
    },
    top() { return scopes[scopes.length - 1] || null; },
    depth() { return scopes.length; },
    has(id) { return scopes.some((s) => s.id === id); },
    focused() { const t = nav.top(); return t ? t.focused : null; },
    setGlobalHandler(fn) { globalHandler = fn; },

    focus(el, { sound = true, force = false } = {}) {
      const scope = nav.top();
      if (!scope || !el) return;
      if (scope.focused === el && !force) return;
      if (scope.focused) scope.focused.classList.remove('is-focused');
      scope.focused = el;
      el.classList.add('is-focused');
      scrollIntoView(el);
      if (sound) {
        // The move sound is panned slightly towards the element's side of the screen.
        const r = el.getBoundingClientRect();
        DL.sound.play('move', { x: (r.left + r.width / 2) / Math.max(1, window.innerWidth) });
      }
      if (scope.onFocus) scope.onFocus(el);
      el.dispatchEvent(new CustomEvent('dl-focus'));
    },

    /** Re-validates focus after the DOM changed (e.g. a list was re-rendered). */
    refresh() {
      const scope = nav.top();
      if (!scope) return;
      if (scope.focused && scope.focused.isConnected && isVisible(scope.focused)) {
        scope.focused.classList.add('is-focused');
        return;
      }
      const first = typeof scope.initial === 'function' ? scope.initial() : scope.initial;
      const target = first || candidates(scope)[0];
      if (target) nav.focus(target, { sound: false, force: true });
    },

    move(dir) {
      const scope = nav.top();
      if (!scope) return false;
      const list = candidates(scope);
      if (!list.length) return false;
      const cur = scope.focused && list.includes(scope.focused) ? scope.focused : null;
      if (!cur) { nav.focus(list[0]); return true; }
      const next = pick(cur, list, dir);
      if (next) { nav.focus(next); return true; }
      return false;
    },

    handle(action, source) {
      const scope = nav.top();
      if (!scope) return;
      const el = scope.focused && scope.focused.isConnected ? scope.focused : null;
      if (scope.onAction && scope.onAction(action, el, source) === true) return;
      if (['up', 'down', 'left', 'right'].includes(action)) {
        if ((action === 'left' || action === 'right') && el && typeof el._dlAdjust === 'function') {
          if (el._dlAdjust(action === 'right' ? 1 : -1) !== false) return;
        }
        if (scope.onMove && scope.onMove(action, el) === true) return;
        if (!nav.move(action) && scope.onEdge) scope.onEdge(action, el);
        return;
      }
      if (action === 'confirm') {
        if (el && !isDisabled(el)) {
          if (!el.hasAttribute('data-silent')) DL.sound.play(el.dataset.sound || 'select');
          DL.input.rumble(0.15, 0.35, 45);
          el._dlViaNav = true;
          try { el.click(); } finally { el._dlViaNav = false; }
        }
        return;
      }
      if (action === 'back') {
        if (scope.onBack) { scope.onBack(); return; }
        if (scopes.length > 1) { DL.sound.play('back'); nav.pop(scope); }
        return;
      }
      if (globalHandler) globalHandler(action, el, source);
    },
  };

  // Mouse: clicking an element focuses it (inside the active scope only).
  document.addEventListener('pointerdown', (e) => {
    const scope = nav.top();
    if (!scope) return;
    const el = e.target.closest && e.target.closest('[data-nav]');
    if (el && scope.root.contains(el) && !isDisabled(el)) nav.focus(el, { sound: false });
  }, true);

  DL.nav = nav;
})();
