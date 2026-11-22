/* Dream Launcher - importer: store sources, manually added games and emulators. */
(function () {
  'use strict';
  const DL = (window.DL = window.DL || {});
  const { el, ui } = DL;
  const t = (k, p) => DL.t(k, p);

  const SOURCES = ['steam', 'epic', 'gog', 'ubisoft', 'xbox'];

  function sourceStatus(id) {
    const s = DL.state.settings;
    const st = DL.state.sources[id];
    if (!s.sources[id]) return { text: t('options.sourceOff'), tone: 'off' };
    if (!st) return { text: DL.state.scanning ? t('importer.scanning') : '', tone: '' };
    if (st.error) return { text: t('options.sourceError'), tone: 'warn' };
    if (!st.available && !st.count) return { text: t('options.sourceMissing'), tone: 'off' };
    let text = t('home.gamesCount', { n: DL.fmt.number(st.count), count: st.count });
    if (st.owned) text += ` · ${t('importer.ownedExtra', { n: DL.fmt.number(st.owned), count: st.owned })}`;
    return { text, tone: 'good' };
  }

  function open() {
    if (DL.nav.has('importer')) return;
    let sheet;
    const render = (body) => {
      body.textContent = '';
      body.appendChild(el('p', { class: 'opt-note top', text: t('importer.intro') }));
      const list = el('div', { class: 'importer-list', attrs: { 'data-scroll': true } });
      list.appendChild(ui.sectionTitle(t('importer.stores')));
      for (const id of SOURCES) {
        const st = sourceStatus(id);
        const row = ui.toggleRow({
          label: t(`sources.${id}`), desc: st.text,
          get: () => DL.state.settings.sources[id],
          set: (v) => DL.saveSettings({ sources: { [id]: v } }),
        });
        row.classList.add(`tone-${st.tone || 'none'}`);
        list.appendChild(row);
      }
      list.appendChild(ui.actionRow({ label: t('importer.scanNow'), icon: 'refresh', onClick: async () => {
        DL.toast({ title: t('options.scanning'), icon: 'refresh', duration: 1500 });
        const lib = await DL.api.scanLibrary();
        if (lib && lib.games) { DL.setLibrary(lib); DL.toast({ title: t('options.scanDone'), sub: t('home.gamesCount', { n: lib.games.length, count: lib.games.length }), icon: 'check', tone: 'good' }); }
      } }));

      list.appendChild(ui.sectionTitle(t('importer.otherGames')));
      list.appendChild(ui.actionRow({ label: t('importer.addGame'), desc: t('importer.addGameDesc'), icon: 'plus', onClick: addManual }));
      const manual = DL.state.games.filter((g) => g.source === 'manual');
      for (const g of manual) {
        list.appendChild(ui.actionRow({ label: g.name, value: g.installed ? '' : t('status.missing'), icon: 'edit', onClick: () => editManual(g.id) }));
      }

      list.appendChild(ui.sectionTitle(t('importer.emulators')));
      list.appendChild(ui.actionRow({ label: t('importer.addEmulator'), desc: t('importer.addEmulatorDesc'), icon: 'plus', onClick: () => editEmulator(null) }));
      const details = (DL.state.sources.emulators && DL.state.sources.emulators.details) || {};
      for (const e of DL.state.settings.emulators) {
        const d = details[e.id];
        let value = '';
        if (d && d.error) value = t(`importer.emuError.${d.error}`);
        else if (d) value = t('home.gamesCount', { n: d.count, count: d.count });
        list.appendChild(ui.actionRow({ label: e.name || e.platform || t('importer.emulator'), desc: e.platform || '', value, icon: 'edit', onClick: () => editEmulator(e) }));
      }
      body.appendChild(list);
    };
    sheet = ui.openSheet({
      id: 'importer',
      cls: 'side wide',
      title: t('importer.title'),
      build: (body, s) => { sheet = s; render(body); },
    });
    const off = DL.bus.on('library', () => {
      if (sheet.closed) { off(); return; }
      const f = DL.nav.focused();
      const label = f && f.querySelector('.row-label') ? f.querySelector('.row-label').textContent : null;
      render(sheet.body);
      const again = label ? [...sheet.body.querySelectorAll('.opt-row')].find((r) => r.querySelector('.row-label') && r.querySelector('.row-label').textContent === label) : null;
      if (again && DL.nav.top() === sheet.scope) DL.nav.focus(again, { sound: false, force: true });
      else DL.nav.refresh();
    });
  }

  // ---------------------------------------------------------------- manual games
  async function addManual() {
    const picked = await DL.api.pickManualGame();
    if (!picked || picked.canceled || picked.error) return;
    editManualForm({ path: picked.path, name: picked.name, args: '' }, true);
  }

  async function editManual(gameId) {
    const entry = await DL.api.getManualGame(gameId);
    if (!entry) return;
    editManualForm(entry, false);
  }

  function editManualForm(entry, isNew) {
    const draft = { ...entry };
    let sheet;
    sheet = ui.openSheet({
      id: 'manual-edit',
      cls: 'side',
      title: isNew ? t('importer.addGame') : t('menu.edit'),
      subtitle: draft.path,
      build(body) {
        body.appendChild(el('div', { class: 'form-list' },
          ui.textRow({ label: t('importer.name'), get: () => draft.name, set: (v) => { draft.name = v; } }),
          ui.textRow({ label: t('importer.arguments'), desc: t('importer.argumentsDesc'), get: () => draft.args, placeholder: t('importer.none'), set: (v) => { draft.args = v; } }),
          ui.actionRow({ label: t('common.save'), icon: 'check', onClick: async () => {
            const res = await DL.api.saveManualGame(draft);
            if (res && res.ok) { sheet.close(true); DL.toast({ title: t('importer.saved'), icon: 'check', tone: 'good' }); }
            else DL.showError(res);
          } }),
          !isNew ? ui.actionRow({ label: t('menu.remove'), icon: 'trash', danger: true, onClick: async () => {
            await DL.api.removeManualGame(`manual:${draft.id}`);
            sheet.close(true);
          } }) : null,
          ui.actionRow({ label: t('common.cancel'), icon: 'chevron', onClick: () => sheet.close() })));
      },
    });
  }

  // ---------------------------------------------------------------- emulators
  function editEmulator(existing) {
    const presets = DL.state.presets || [];
    const draft = existing ? { ...existing, extensions: [...(existing.extensions || [])] } : (() => {
      const p = presets.find((x) => x.id === 'pcsx2') || presets[0] || { id: 'custom', name: '', platform: '', args: '"{rom}"', extensions: [] };
      return { id: null, preset: p.id, name: p.name, platform: p.platform, args: p.args, extensions: [...p.extensions], exe: '', romDir: '' };
    })();
    let sheet;
    const fileName = (p) => (p ? String(p).split(/[\\/]/).pop() : '');
    const build = (body) => {
      body.textContent = '';
      const exeRow = ui.actionRow({ label: t('importer.emuExe'), value: fileName(draft.exe) || t('importer.browse'), icon: 'folder', onClick: async (row) => {
        const r = await DL.api.pickEmulatorExe();
        if (r && r.path) { draft.exe = r.path; row._dlSetValue(fileName(r.path)); }
      } });
      const dirRow = ui.actionRow({ label: t('importer.romFolder'), value: draft.romDir || t('importer.browse'), icon: 'folder', onClick: async (row) => {
        const r = await DL.api.pickRomFolder();
        if (r && r.path) { draft.romDir = r.path; row._dlSetValue(r.path); }
      } });
      body.appendChild(el('div', { class: 'form-list', attrs: { 'data-scroll': true } },
        ui.choiceRow({
          label: t('importer.preset'), list: true,
          options: presets.map((p) => ({ value: p.id, label: p.id === 'custom' ? t('importer.custom') : p.name })),
          get: () => draft.preset,
          set: (v) => {
            const p = presets.find((x) => x.id === v);
            draft.preset = v;
            if (p) {
              draft.name = p.id === 'custom' ? draft.name : p.name;
              draft.platform = p.platform || draft.platform;
              draft.args = p.args;
              draft.extensions = [...p.extensions];
            }
            build(body);
            const again = body.querySelector('.choice-row');
            if (again) DL.nav.focus(again, { sound: false, force: true });
          },
        }),
        exeRow,
        dirRow,
        ui.textRow({ label: t('importer.name'), get: () => draft.name, set: (v) => { draft.name = v; } }),
        ui.textRow({ label: t('importer.platform'), get: () => draft.platform, set: (v) => { draft.platform = v; } }),
        ui.textRow({ label: t('importer.fileTypes'), desc: t('importer.fileTypesDesc'), get: () => draft.extensions.join(', '), set: (v) => { draft.extensions = v.split(/[\s,;]+/).map((x) => x.replace(/^\*?\./, '').toLowerCase()).filter(Boolean); } }),
        ui.textRow({ label: t('importer.arguments'), desc: t('importer.emuArgsDesc'), get: () => draft.args, set: (v) => { draft.args = v; } }),
        ui.actionRow({ label: t('common.save'), icon: 'check', onClick: save }),
        existing ? ui.actionRow({ label: t('importer.removeEmulator'), icon: 'trash', danger: true, onClick: remove }) : null,
        ui.actionRow({ label: t('common.cancel'), icon: 'chevron', onClick: () => sheet.close() })));
    };
    async function save() {
      if (!draft.exe || !draft.romDir) {
        DL.toast({ title: t('importer.needExeAndFolder'), icon: 'warn', tone: 'error' });
        return;
      }
      if (!draft.extensions.length) {
        DL.toast({ title: t('importer.needFileTypes'), icon: 'warn', tone: 'error' });
        return;
      }
      const res = await DL.api.saveEmulator(draft);
      if (res && res.ok) {
        if (res.settings) { DL.state.settings = res.settings; DL.bus.emit('settings', {}); }
        sheet.close(true);
        DL.toast({ title: t('importer.emuSaved'), sub: t('importer.emuSavedSub'), icon: 'check', tone: 'good' });
      } else DL.showError(res);
    }
    async function remove() {
      const c = await ui.confirm({ title: t('importer.removeEmulator'), message: t('importer.removeEmulatorText'), buttons: [{ id: 'cancel', label: t('common.cancel'), primary: true }, { id: 'ok', label: t('menu.remove'), danger: true }] });
      if (c !== 'ok') return;
      const res = await DL.api.removeEmulator(existing.id);
      if (res && res.settings) { DL.state.settings = res.settings; DL.bus.emit('settings', {}); }
      sheet.close(true);
    }
    sheet = ui.openSheet({
      id: 'emulator',
      cls: 'side wide',
      title: existing ? t('importer.editEmulator') : t('importer.addEmulator'),
      build: (body, s) => { sheet = s; build(body); },
    });
  }

  DL.importer = { open, editManual };
})();
