/*
 * Dream Launcher - keyboard, mouse and gamepad input.
 * Gamepads use the browser Gamepad API (standard mapping): Xbox (XInput), PlayStation (DualShock 4,
 * DualSense) and Nintendo (Switch Pro, Joy-Con pair) controllers are all reported with the same layout.
 */
(function () {
  'use strict';
  const DL = (window.DL = window.DL || {});

  const REPEAT_DELAY = 380;
  const REPEAT_RATE = 105;
  const REPEAT_FAST = 60;
  const STICK = 0.55;
  const STEAM_INPUT_GUARD_MS = 700;

  let lastPadActivity = 0;
  let timer = 0;
  const padState = new Map();
  let activePad = null;

  function setMode(mode, kind) {
    const changed = DL.state.inputMode !== mode || (kind && DL.state.padKind !== kind);
    DL.state.inputMode = mode;
    if (kind) DL.state.padKind = kind;
    document.body.dataset.input = mode;
    if (changed) DL.bus.emit('inputmode');
  }

  function dispatch(action, source) {
    DL.sound.unlock();
    if (!DL.state.musicUnlocked) {
      DL.state.musicUnlocked = true;
      DL.music.apply();
    }
    DL.bus.emit('input', action, source);
    if (DL.nav) DL.nav.handle(action, source);
  }

  // ---------------------------------------------------------------- keyboard
  function isTextInput(el) {
    return !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'range'].includes(el.type)));
  }

  const KEYMAP = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    Enter: 'confirm', ' ': 'confirm', Escape: 'back', Backspace: 'back',
    x: 'x', X: 'x', i: 'info', I: 'info', y: 'info', Y: 'info', m: 'menu', M: 'menu', ContextMenu: 'menu',
    f: 'view', F: 'view', '/': 'view', q: 'lb', Q: 'lb', e: 'rb', E: 'rb', o: 'options', O: 'options',
    PageUp: 'lt', PageDown: 'rt',
  };

  window.addEventListener('keydown', (e) => {
    if (e.key === 'F11' || e.key === 'F12') return; // handled by the main process
    if (e.ctrlKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); setMode('keyboard'); dispatch('view', 'keyboard'); return; }
    if (e.altKey || e.metaKey || (e.ctrlKey && e.key !== 'Enter')) return;
    const active = document.activeElement;
    if (isTextInput(active)) {
      // Typing: let the field handle everything except leaving it.
      if (e.key === 'Escape') { e.preventDefault(); active.blur(); dispatch('back', 'keyboard'); }
      else if (e.key === 'Enter') { e.preventDefault(); active.dispatchEvent(new CustomEvent('dl-enter')); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); active.blur(); dispatch(KEYMAP[e.key], 'keyboard'); }
      return;
    }
    if (e.key === 'Tab') { e.preventDefault(); return; }
    const action = KEYMAP[e.key];
    if (!action) return;
    e.preventDefault();
    // Steam Input's desktop layout turns controller presses into arrow keys/Enter/Escape.
    // Ignore those while a controller is in use, so nothing happens twice.
    if (performance.now() - lastPadActivity < STEAM_INPUT_GUARD_MS && ['up', 'down', 'left', 'right', 'confirm', 'back'].includes(action)) return;
    setMode('keyboard');
    dispatch(action, 'keyboard');
  });

  // ---------------------------------------------------------------- mouse
  let lastMouse = null;
  window.addEventListener('mousemove', (e) => {
    if (lastMouse && Math.abs(e.screenX - lastMouse[0]) + Math.abs(e.screenY - lastMouse[1]) > 6) {
      if (performance.now() - lastPadActivity > 1000) setMode('mouse');
    }
    lastMouse = [e.screenX, e.screenY];
  }, { passive: true });
  window.addEventListener('pointerdown', () => { DL.sound.unlock(); if (!DL.state.musicUnlocked) { DL.state.musicUnlocked = true; DL.music.apply(); } }, { passive: true });
  window.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------------------------------------------------------------- gamepads
  function kindFromId(id) {
    const s = String(id || '').toLowerCase();
    if (/vendor:\s*054c|^54c-|054c-|dualsense|dualshock|playstation/.test(s)) return 'playstation';
    if (/vendor:\s*057e|^57e-|057e-|pro controller|joy-con|nintendo/.test(s)) return 'nintendo';
    if (/xinput|xbox|vendor:\s*045e|^45e-|045e-/.test(s)) return 'xbox';
    if (/^wireless controller/.test(s)) return 'playstation';
    return 'generic';
  }

  function padName(id, kind) {
    const m = /product:\s*([0-9a-f]{4})/i.exec(String(id || ''));
    const p = m ? m[1].toLowerCase() : '';
    if (kind === 'playstation') {
      if (p === '0ce6') return 'DualSense';
      if (p === '0df2') return 'DualSense Edge';
      if (p === '05c4' || p === '09cc') return 'DualShock 4';
      return 'PlayStation Controller';
    }
    if (kind === 'nintendo') {
      if (p === '2009') return 'Switch Pro Controller';
      if (p === '200e') return 'Joy-Con (L/R)';
      if (p === '2006') return 'Joy-Con (L)';
      if (p === '2007') return 'Joy-Con (R)';
      return 'Nintendo Controller';
    }
    if (kind === 'xbox') return 'Xbox Controller';
    const name = String(id || '').split('(')[0].trim();
    return name || DL.t('controller.generic');
  }

  function buttonDown(gp, i) {
    const b = gp.buttons[i];
    return !!b && (b.pressed || b.value > 0.5);
  }

  function direction(gp) {
    if (buttonDown(gp, 12)) return 'up';
    if (buttonDown(gp, 13)) return 'down';
    if (buttonDown(gp, 14)) return 'left';
    if (buttonDown(gp, 15)) return 'right';
    const x = gp.axes[0] || 0;
    const y = gp.axes[1] || 0;
    if (Math.max(Math.abs(x), Math.abs(y)) < STICK) return null;
    if (Math.abs(x) > Math.abs(y)) return x > 0 ? 'right' : 'left';
    return y > 0 ? 'down' : 'up';
  }

  // Standard mapping indices -> logical actions (confirm/back resolved per layout).
  function buttonAction(i) {
    const right = DL.glyphs.confirmIsRight();
    switch (i) {
      case 0: return right ? 'back' : 'confirm';
      case 1: return right ? 'confirm' : 'back';
      case 2: return 'x';
      case 3: return 'info';
      case 4: return 'lb';
      case 5: return 'rb';
      case 6: return 'lt';
      case 7: return 'rt';
      case 8: return 'view';
      case 9: return 'menu';
      default: return null;
    }
  }

  function poll() {
    const now = performance.now();
    const list = navigator.getGamepads ? navigator.getGamepads() : [];
    let any = false;
    const focused = document.hasFocus();
    for (const gp of list) {
      if (!gp || !gp.connected) continue;
      any = true;
      let st = padState.get(gp.index);
      if (!st) { st = { prev: [], dir: null, since: 0, last: 0, kind: kindFromId(gp.id) }; padState.set(gp.index, st); }
      const pressed = gp.buttons.map((_, i) => buttonDown(gp, i));
      // Only react while the launcher window is focused, so a game running in front never triggers anything here.
      if (focused) {
        let activity = false;
        for (let i = 0; i <= 9; i++) {
          if (pressed[i] && !st.prev[i]) {
            activity = true;
            const action = buttonAction(i);
            if (action) {
              lastPadActivity = performance.now();
              activePad = gp.index;
              setMode('gamepad', st.kind);
              dispatch(action, 'gamepad');
            }
          }
        }
        const dir = direction(gp);
        if (dir) {
          activity = true;
          if (dir !== st.dir) {
            st.dir = dir; st.since = now; st.last = now;
            lastPadActivity = performance.now();
            activePad = gp.index;
            setMode('gamepad', st.kind);
            dispatch(dir, 'gamepad');
          } else {
            const held = now - st.since;
            const rate = held > 1500 ? REPEAT_FAST : REPEAT_RATE;
            if (held > REPEAT_DELAY && now - st.last > rate) {
              st.last = now;
              lastPadActivity = performance.now();
              dispatch(dir, 'gamepad');
            }
          }
        } else {
          st.dir = null;
        }
        if (activity) lastPadActivity = performance.now();
      }
      st.prev = pressed;
    }
    if (!any) stopPolling();
  }

  // Polled with a timer (not requestAnimationFrame) so short button presses are never missed,
  // even when a frame takes longer to draw.
  function startPolling() {
    if (!timer) timer = setInterval(poll, 10);
  }
  function stopPolling() {
    clearInterval(timer);
    timer = 0;
  }

  window.addEventListener('gamepadconnected', (e) => {
    const gp = e.gamepad;
    const kind = kindFromId(gp && gp.id);
    padState.set(gp.index, { prev: gp.buttons.map(() => true), dir: null, since: 0, last: 0, kind });
    setMode('gamepad', kind);
    lastPadActivity = performance.now();
    startPolling();
    const s = DL.state.settings || {};
    if (s.showControllerToast !== false) {
      DL.toast({ title: DL.t('controller.connected'), sub: `${padName(gp.id, kind)} · ${DL.t('controller.player', { n: gp.index + 1 })}`, icon: 'controller', tone: 'good' });
    }
    DL.bus.emit('gamepads');
  });
  window.addEventListener('gamepaddisconnected', (e) => {
    padState.delete(e.gamepad.index);
    const s = DL.state.settings || {};
    if (s.showControllerToast !== false) DL.toast({ title: DL.t('controller.disconnected'), sub: padName(e.gamepad.id, kindFromId(e.gamepad.id)), icon: 'controller' });
    if (!padState.size && DL.state.inputMode === 'gamepad') setMode('keyboard');
    DL.bus.emit('gamepads');
  });
  window.addEventListener('focus', () => { if (padState.size) startPolling(); });

  DL.input = {
    kindFromId,
    padName,
    setMode,
    connected() {
      const list = navigator.getGamepads ? navigator.getGamepads() : [];
      return Array.from(list).filter((g) => g && g.connected).map((g) => ({ index: g.index, kind: kindFromId(g.id), name: padName(g.id, kindFromId(g.id)) }));
    },
    rumble(strong = 0.35, weak = 0.6, ms = 70) {
      const s = DL.state.settings || {};
      if (s.vibration === false || activePad === null) return;
      const list = navigator.getGamepads ? navigator.getGamepads() : [];
      const gp = list[activePad];
      const act = gp && gp.vibrationActuator;
      if (act && typeof act.playEffect === 'function') {
        act.playEffect('dual-rumble', { startDelay: 0, duration: ms, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {});
      }
    },
    startPolling,
  };
  document.body.dataset.input = DL.state.inputMode;
})();
