/* Dream Launcher - per-game options menu and the artwork picker. */
(function () {
  'use strict';
  const DL = (window.DL = window.DL || {});
  const { el } = DL;

  function menuItem(icon, label, onClick, { danger = false, value = '' } = {}) {
    return el('button', { class: `menu-item ${danger ? 'danger' : ''}`, nav: true, on: { click: onClick } },
      DL.icon(icon, 'menu-ic'), el('span', { class: 'menu-label', text: label }), value ? el('span', { class: 'menu-value', text: value }) : null);
  }

  function openGameMenu(gameArg) {
    const id = gameArg.id;
    const game = () => DL.state.byId.get(id) || gameArg;
    let sheet;
    const build = (body) => {
      body.textContent = '';
      const g = game();
      const list = el('div', { class: 'menu-list', attrs: { 'data-scroll': true } });
      const close = () => sheet.close(true);
      // Installing and updating download through the store app: they need the internet.
      const offline = DL.state.net.online === false;
      const needsNet = (fn) => () => {
        if (offline) { DL.sound.play('error'); DL.toast({ title: DL.t('net.needsInternet'), sub: DL.t('net.needsInternetText'), icon: 'wifiOff' }); return; }
        fn();
      };
      const netValue = offline ? { value: DL.t('net.needsInternetShort') } : {};
      if (g.actions.install) list.appendChild(menuItem('download', DL.t('actions.install'), needsNet(() => { close(); DL.actions.install(g); }), netValue));
      else if (g.actions.play && g.status !== 'running') list.appendChild(menuItem('play', DL.t('actions.play'), () => { close(); DL.actions.play(g); }));
      if (g.status === 'running') list.appendChild(menuItem('check', DL.t('actions.notPlaying'), () => { close(); DL.actions.stopTracking(g); }));
      if (g.actions.update) list.appendChild(menuItem('download', DL.t('actions.update'), needsNet(() => { close(); DL.actions.update(g); }), netValue));
      if (g.actions.checkUpdates) list.appendChild(menuItem('refresh', DL.t('actions.checkUpdates'), needsNet(() => { close(); DL.actions.update(g); }), netValue));
      if (g.actions.openClient) list.appendChild(menuItem('store', DL.t('menu.openClient', { store: g.sourceLabel }), () => { close(); DL.actions.openClient(g); }));
      list.appendChild(menuItem('star', DL.t(g.favorite ? 'menu.unfavorite' : 'menu.favorite'), async () => {
        await DL.actions.setFlags(g, { favorite: !g.favorite });
        DL.sound.play('toggle');
        build(body);
        DL.nav.refresh();
      }));
      list.appendChild(menuItem('image', DL.t('menu.changeArtwork'), () => openArtworkPicker(g)));
      const subLabel = g.subscription ? DL.subscriptionInfo[g.subscription].label : DL.t('menu.subscriptionNone');
      list.appendChild(menuItem('badge', DL.t('menu.subscription'), async () => {
        const v = await DL.ui.choose({
          title: DL.t('menu.subscription'),
          value: g.subscription || '',
          options: [
            { value: '', label: DL.t('menu.subscriptionNone') },
            { value: 'gamepass', label: 'PC Game Pass' },
            { value: 'eaplay', label: 'EA Play' },
            { value: 'ubisoftplus', label: 'Ubisoft+' },
          ],
        });
        if (v !== null && v !== undefined) {
          await DL.actions.setFlags(g, { subscription: v || null });
          build(body);
          DL.nav.refresh();
        }
      }, { value: subLabel }));
      if (g.actions.showFolder) list.appendChild(menuItem('folder', DL.t('menu.showFolder'), () => DL.actions.showFolder(g)));
      if (g.actions.editable) list.appendChild(menuItem('edit', DL.t('menu.edit'), () => { close(); DL.importer.editManual(g.id); }));
      list.appendChild(menuItem(g.hidden ? 'eye' : 'eyeOff', DL.t(g.hidden ? 'menu.unhide' : 'menu.hide'), async () => {
        const hiding = !g.hidden;
        await DL.actions.setFlags(g, { hidden: hiding });
        DL.toast({ title: DL.t(hiding ? 'toast.hidden' : 'toast.unhidden', { name: g.name }), icon: hiding ? 'eyeOff' : 'eye' });
        close();
      }));
      if (g.actions.removable) {
        list.appendChild(menuItem('trash', DL.t('menu.remove'), async () => {
          const choice = await DL.ui.confirm({
            title: DL.t('menu.removeTitle', { name: g.name }),
            message: DL.t('menu.removeText'),
            buttons: [{ id: 'cancel', label: DL.t('common.cancel'), primary: true }, { id: 'remove', label: DL.t('menu.remove'), danger: true }],
          });
          if (choice === 'remove') {
            await DL.api.removeManualGame(g.id);
            close();
          }
        }, { danger: true }));
      }
      body.appendChild(list);
    };
    sheet = DL.ui.openSheet({
      id: 'game-menu',
      cls: 'side',
      title: game().name,
      subtitle: game().sourceLabel + (game().platform && game().source === 'emulators' ? ` · ${game().platform}` : ''),
      build,
    });
  }

  // ---------------------------------------------------------------- artwork picker
  function openArtworkPicker(gameArg) {
    const id = gameArg.id;
    const game = () => DL.state.byId.get(id) || gameArg;
    const KINDS = ['cover', 'hero', 'logo'];
    const LABELS = { cover: 'art.cover', hero: 'art.background', logo: 'art.logo' };
    let kind = 'cover';
    let sheet;
    let loadToken = 0;

    const render = (body) => {
      body.textContent = '';
      const tabs = el('div', { class: 'chips' },
        ...KINDS.map((k) => el('button', {
          class: `chip ${k === kind ? 'active' : ''}`, nav: true, text: DL.t(LABELS[k]),
          on: { click: () => { if (kind !== k) { kind = k; render(body); DL.nav.refresh(); } } },
        })));
      body.appendChild(tabs);
      // Note: kind-* class names; a plain "hero" class would pick up the dashboard's styles.
      const grid = el('div', { class: `art-grid kind-${kind}`, attrs: { 'data-scroll': true } });
      grid.appendChild(el('button', { class: 'art-option action', nav: true, on: { click: pickFile } }, DL.icon('folder'), el('span', { text: DL.t('art.chooseFile') })));
      grid.appendChild(el('button', { class: 'art-option action', nav: true, on: { click: reset } }, DL.icon('refresh'), el('span', { text: DL.t('art.reset') })));
      const status = el('div', { class: 'art-status', text: DL.t('art.loading') });
      body.appendChild(grid);
      body.appendChild(status);
      const token = ++loadToken;
      DL.api.artworkOptions(id, kind).then((res) => {
        if (token !== loadToken || sheet.closed) return;
        if (!res || res.error) { status.textContent = DL.t('art.failed'); return; }
        if (res.needsKey) { status.textContent = DL.t('art.needsKey'); return; }
        if (res.offline) { status.textContent = DL.t('art.offline'); return; }
        if (!res.items.length) { status.textContent = DL.t('art.none'); return; }
        status.textContent = DL.t('art.fromSgdb');
        for (const item of res.items) {
          const img = el('img', { attrs: { alt: '', src: item.thumb, loading: 'lazy', referrerpolicy: 'no-referrer', draggable: 'false' } });
          const btn = el('button', { class: 'art-option', nav: true, on: { click: () => apply(item.url) } }, img);
          img.onerror = () => btn.remove();
          grid.appendChild(btn);
        }
      }).catch(() => { if (token === loadToken) status.textContent = DL.t('art.failed'); });
    };

    async function done(res) {
      if (res && res.error) { DL.showError(res); return; }
      if (res && res.canceled) return;
      if (res && res.game) DL.updateGame(res.game);
      DL.toast({ title: DL.t('art.saved'), icon: 'check', tone: 'good' });
    }
    async function pickFile() { done(await DL.api.pickArtwork(id, kind)); }
    async function reset() { done(await DL.api.resetArtwork(id, kind)); }
    async function apply(url) {
      DL.toast({ title: DL.t('art.downloading'), icon: 'download', duration: 1500 });
      done(await DL.api.applyArtwork(id, kind, url));
    }

    sheet = DL.ui.openSheet({
      id: 'artwork',
      cls: 'wide-sheet',
      title: DL.t('menu.changeArtwork'),
      subtitle: game().name,
      build: (body) => render(body),
      hints: [['confirm', DL.t('hints.select')], ['lbrb', DL.t('art.switchKind')], ['back', DL.t('hints.back')]],
      onAction(action) {
        if (action === 'lb' || action === 'rb') {
          const k = KINDS[(KINDS.indexOf(kind) + (action === 'rb' ? 1 : -1) + KINDS.length) % KINDS.length];
          kind = k;
          render(sheet.body);
          DL.sound.play('toggle');
          const first = sheet.body.querySelector('.art-option');
          if (first) DL.nav.focus(first, { sound: false, force: true }); else DL.nav.refresh();
          return true;
        }
        return false;
      },
    });
  }

  DL.gameMenu = { open: openGameMenu, openArtwork: openArtworkPicker };
})();
