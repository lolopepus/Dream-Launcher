/* Dream Launcher - game actions (play, install, update, ...) with feedback. */
(function () {
  'use strict';
  const DL = (window.DL = window.DL || {});
  const { el } = DL;

  let launchTimer = null;

  function showLaunching(game) {
    const host = document.getElementById('launch-overlay');
    if (!host) return;
    host.textContent = '';
    const art = game.art && (game.art.cover || game.art.hero);
    const card = el('div', { class: 'launch-card' });
    if (art) {
      const img = el('img', { attrs: { alt: '', src: art, draggable: 'false' } });
      img.onerror = () => img.remove();
      card.appendChild(img);
    }
    // The game's logo when it is known (and logos are on), otherwise its name.
    const logo = DL.state.settings.showLogos !== false && DL.dashboard && DL.dashboard.logo(game);
    const title = logo
      ? el('img', { class: `launch-logo ${logo.dark ? 'dark' : ''}`, attrs: { alt: game.name, src: logo.src, draggable: 'false' } })
      : el('div', { class: 'launch-name', text: game.name });
    host.appendChild(el('div', { class: 'launch-inner' },
      card,
      el('div', { class: 'launch-text' },
        el('div', { class: 'launch-label', text: DL.t('launch.starting') }),
        title),
      el('div', { class: 'launch-spinner' })));
    host.classList.add('show');
    clearTimeout(launchTimer);
    launchTimer = setTimeout(hideLaunching, 3200);
  }

  function hideLaunching() {
    const host = document.getElementById('launch-overlay');
    if (host) host.classList.remove('show');
  }

  async function call(fn, okToast) {
    try {
      const res = await fn();
      if (res && res.error) { DL.showError(res); return false; }
      if (res && res.canceled) return false;
      if (okToast) DL.toast(okToast);
      return true;
    } catch (err) {
      console.error(err);
      DL.showError({ error: 'generic' });
      return false;
    }
  }

  DL.actions = {
    async primary(game) {
      if (!game || game.status === 'running') return;
      if (game.actions.install) return DL.actions.install(game);
      if (!game.actions.play) { DL.sound.play('error'); return; }
      return DL.actions.play(game);
    },
    async play(game) {
      DL.sound.play('launch');
      DL.input.rumble(0.45, 0.8, 140);
      showLaunching(game);
      try {
        const res = await DL.api.launch(game.id);
        if (res && res.error) { hideLaunching(); DL.showError(res, 'errors.launchFailed'); }
      } catch (err) {
        console.error(err);
        hideLaunching();
        DL.showError({ error: 'launchFailed' });
      }
    },
    install(game) {
      return call(() => DL.api.install(game.id), { title: DL.t('toast.openingStore', { store: game.sourceLabel }), icon: 'download' });
    },
    update(game) {
      return call(() => DL.api.update(game.id), { title: DL.t('toast.openingStore', { store: game.source === 'xbox' ? 'Microsoft Store' : game.sourceLabel }), icon: 'download' });
    },
    openClient(game) {
      return call(() => DL.api.openClient(game.id), { title: DL.t('toast.openingStore', { store: game.sourceLabel }), icon: 'store' });
    },
    showFolder(game) {
      return call(() => DL.api.showFolder(game.id));
    },
    /** "Not playing anymore": ends the play session by hand. */
    async stopTracking(game) {
      try {
        const res = await DL.api.stopTracking(game.id);
        if (res && res.ok) DL.toast({ title: DL.t('toast.stoppedTracking', { name: game.name }), icon: 'check' });
      } catch (err) {
        console.error(err);
      }
    },
    async setFlags(game, patch) {
      try {
        const updated = await DL.api.setGameFlags(game.id, patch);
        if (updated && !updated.error) DL.updateGame(updated);
        return updated;
      } catch (err) {
        console.error(err);
        return null;
      }
    },
    hideLaunching,
  };
})();
