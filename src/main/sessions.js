'use strict';
/**
 * Starts games and tracks play sessions.
 *
 * - Store games (Steam, Epic, Ubisoft, Xbox) are started through their store client
 *   (protocol URL / shell:AppsFolder). The game is then recognised as a running process:
 *     - a process whose file lies inside the game's folder, or
 *     - a process with one of the game's own program names (Xbox games declare them in
 *       MicrosoftGame.config; for games running as administrator Windows hides the file path,
 *       so the program names found in the game folder are used instead).
 * - Direct games (GOG, manual .exe, emulators) are started as child processes.
 *
 * While waiting for the game to appear, the full process list (with paths) is read every 6 s.
 * Once the game runs, a light check (tasklist.exe, names only) runs every 5 s; when the game's
 * processes are gone, one full check confirms it and the session ends. Returning to the launcher
 * window triggers an immediate check, and a session can also be ended by hand.
 * Playtime is recorded for every source except Steam, which tracks its own playtime.
 */
const EventEmitter = require('events');
const path = require('path');
const fsp = require('fs').promises;
const { spawn } = require('child_process');
const { splitArgs } = require('./util/args');
const { normKey } = require('./util/fsx');

const DETECT_POLL_MS = 6000;
const TRACK_POLL_MS = 5000;
const FIRST_POLL_MS = 3500;
const DETECT_TIMEOUT_MS = 4 * 60 * 1000;
const STUB_EXIT_MS = 15000;
const CHECK_NOW_GAP_MS = 1500;

// Programs that ship inside game folders but are not the game (installers, crash reporters,
// anti-cheat services, browser helpers). They are never used to recognise a game by name.
const HELPER_PATTERNS = [
  /^unins\d*\.exe$/, /setup/, /install/, /redist/, /^dxsetup\.exe$/, /^vc_?redist/, /^dotnet/, /^ndp\d/,
  /crash/, /^unitycrashhandler/, /reporter/, /^cefsharp/, /^qtwebengineprocess\.exe$/, /^crashpad/,
  /^easyanticheat/, /^start_protected_game\.exe$/, /^beservice/, /^battleye/, /^eac_/, /^notification_helper\.exe$/,
  /^ue4prereq/, /^ueprereq/, /^physx/, /^oalinst\.exe$/, /^gamelaunchhelper\.exe$/, /^launcherpatcher/,
  /^updater\.exe$/, /^update\.exe$/, /^vcredist/, /^directx/, /^dxwebsetup/, /^touchup\.exe$/, /^cleanup\.exe$/,
];
const SKIP_DIRS = /^(_?commonredist|redist|redistributables?|directx|dotnet|vcredist|support|installers?|__installer|_installer|prereq(uisites)?|easyanticheat|battleye|crashreport.*|\.git)$/i;

function isHelperExe(name) {
  return HELPER_PATTERNS.some((re) => re.test(name));
}

/** Lists the program names (lower-case) inside a game folder, a few levels deep. */
async function findExecutables(dir, { maxDepth = 3, maxDirs = 300, maxFiles = 400 } = {}) {
  const names = new Set();
  if (!dir) return names;
  const queue = [[dir, 0]];
  let dirs = 0;
  while (queue.length && dirs < maxDirs && names.size < maxFiles) {
    const [cur, depth] = queue.shift();
    dirs++;
    let entries;
    try { entries = await fsp.readdir(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.test(e.name)) queue.push([path.join(cur, e.name), depth + 1]);
      } else if (e.isFile() && /\.exe$/i.test(e.name)) {
        const n = e.name.toLowerCase();
        if (!isHelperExe(n)) names.add(n);
      }
    }
  }
  return names;
}

class Sessions extends EventEmitter {
  /**
   * @param {object} deps
   * @param {(url:string)=>Promise<void>} deps.openExternal
   * @param {(path:string)=>Promise<string>} deps.openPath  Returns '' on success, error text otherwise.
   * @param {()=>Promise<{name:string,path:string}[]>} deps.listProcesses  Full list with paths (PowerShell).
   * @param {()=>Promise<Set<string>|null>} [deps.listProcessNames]  Fast list of names (tasklist), null on failure.
   * @param {(dir:string)=>Promise<Set<string>>} [deps.findExecutables]
   * @param {import('./store').Store} deps.store
   */
  constructor({ openExternal, openPath, listProcesses, listProcessNames = null, findExecutables: findExes = findExecutables, store, spawnFn = spawn, log = console, now = () => Date.now(), timers = null }) {
    super();
    this.openExternal = openExternal;
    this.openPath = openPath;
    this.listProcesses = listProcesses;
    this.listProcessNames = listProcessNames;
    this.findExecutables = findExes;
    this.store = store;
    this.spawn = spawnFn;
    this.log = log;
    this.now = now;
    this.timers = timers || { setTimeout, clearTimeout };
    this.sessions = new Map();
    this.timer = null;
    this.ticking = false;
    this.again = false;
    this.lastCheckNow = 0;
  }

  isRunning(id) { return this.sessions.has(id); }

  /** Runs a launch/install/update/client action. Throws with a readable message on failure. */
  async run(action) {
    if (!action) throw new Error('nothing to start');
    if (action.type === 'url') {
      await this.openExternal(action.url);
      return null;
    }
    if (action.type === 'open') {
      const err = await this.openPath(action.path);
      if (err) throw new Error(err);
      return null;
    }
    if (action.type === 'shell') {
      return this._spawn('explorer.exe', [action.target], {});
    }
    if (action.type === 'exe') {
      const args = Array.isArray(action.args) ? action.args : splitArgs(action.args || '');
      return this._spawn(action.path, args, { cwd: action.cwd || undefined });
    }
    throw new Error(`unknown action type ${action.type}`);
  }

  _spawn(file, args, { cwd }) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawn(file, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false });
      } catch (err) {
        reject(err);
        return;
      }
      let done = false;
      child.once('error', (err) => { if (!done) { done = true; reject(err); } });
      child.once('spawn', () => { if (!done) { done = true; resolve(child); } });
      // Older runtimes without the 'spawn' event: assume success shortly after.
      setTimeout(() => { if (!done) { done = true; resolve(child); } }, 1500);
    });
  }

  /** Launches a game (internal library object) and starts tracking it. */
  async launch(game) {
    if (!game || !game.launch) throw new Error('This game cannot be started.');
    const startedAt = this.now();
    const child = await this.run(game.launch);
    this.store.markPlayed(game.id, startedAt);
    const declared = new Set((Array.isArray(game.exeNames) ? game.exeNames : []).map((n) => String(n).toLowerCase()).filter((n) => n && !isHelperExe(n)));
    const session = {
      id: game.id,
      startedAt,
      detectedAt: 0,
      lastSeen: 0,
      dir: game.installDir ? normKey(game.installDir) : '',
      countPlaytime: !game.tracksOwnPlaytime,
      child: null,
      mode: 'poll',
      declared,
      candidates: null,
      names: new Set(),
    };
    if (child && game.launch.trackChild) {
      // Emulators: the emulator process is the game session.
      session.mode = 'child';
      session.child = child;
      session.detectedAt = startedAt;
      child.once('exit', () => this._end(game.id));
    } else if (child && game.launch.type === 'exe') {
      // Direct exe: if it keeps running it is the game; if it exits quickly it was a launcher stub.
      session.mode = 'child';
      session.child = child;
      session.detectedAt = startedAt;
      child.once('exit', () => {
        const s = this.sessions.get(game.id);
        if (!s || s.mode !== 'child') return;
        if (this.now() - startedAt < STUB_EXIT_MS && (s.dir || s.declared.size)) {
          s.mode = 'poll';
          s.child = null;
          s.detectedAt = 0;
          this._schedule(FIRST_POLL_MS);
        } else {
          this._end(game.id);
        }
      });
    }
    if (child && typeof child.unref === 'function') child.unref();
    this.sessions.set(game.id, session);
    this.emit('started', game.id);
    if (session.dir) {
      this.findExecutables(session.dir).then((names) => { session.candidates = names; }).catch(() => {});
    }
    if (session.mode === 'poll') {
      if (!session.dir && !session.declared.size) {
        // Nothing to watch (unknown folder): treat as a short session without playtime.
        const t = this.timers.setTimeout(() => this._end(game.id, { discard: true }), 30000);
        if (t && typeof t.unref === 'function') t.unref();
      } else {
        this._schedule(FIRST_POLL_MS);
      }
    }
    return true;
  }

  /** True if a running process belongs to the session's game. */
  _matches(s, p) {
    if (!p || !p.name) return false;
    if (s.declared.has(p.name)) return true;
    if (p.path) {
      if (!s.dir) return false;
      const k = normKey(p.path);
      const prefix = s.dir.endsWith('\\') ? s.dir : `${s.dir}\\`;
      return k.startsWith(prefix);
    }
    // No path: the process belongs to another (elevated or protected) security context.
    return !!(s.candidates && s.candidates.has(p.name));
  }

  _polled() {
    return [...this.sessions.values()].filter((s) => s.mode === 'poll');
  }

  _schedule(ms) {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
    if (!this._polled().length) return;
    this.timer = this.timers.setTimeout(() => { this.timer = null; this._tick().catch((err) => this.log.warn('[sessions]', err && err.message)); }, ms);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Checks all watched games once, then schedules the next check. */
  async _tick() {
    if (this.ticking) { this.again = true; return; }
    this.ticking = true;
    try {
      const polled = this._polled();
      if (!polled.length) return;
      const now = this.now();
      const waiting = polled.filter((s) => !s.detectedAt);
      const running = polled.filter((s) => s.detectedAt);
      let full = null;
      const fullList = async () => {
        if (!full) full = await this.listProcesses();
        return full;
      };

      if (waiting.length) {
        const procs = await fullList();
        for (const s of waiting) {
          const hits = procs.filter((p) => this._matches(s, p));
          if (hits.length) {
            s.detectedAt = now;
            s.lastSeen = now;
            s.names = new Set(hits.map((p) => p.name));
          } else if (now - s.startedAt > DETECT_TIMEOUT_MS) {
            this._end(s.id, { discard: true });
          }
        }
      }

      if (running.length) {
        const names = full ? null : (this.listProcessNames ? await this.listProcessNames() : null);
        for (const s of running) {
          if (!this.sessions.has(s.id)) continue;
          let alive = false;
          if (names) {
            alive = [...s.names].some((n) => names.has(n));
          } else {
            const hits = (await fullList()).filter((p) => this._matches(s, p));
            alive = hits.length > 0;
            if (alive) s.names = new Set(hits.map((p) => p.name));
          }
          if (!alive && names) {
            // Confirm with the full list: the game may have switched to another program in its folder.
            const hits = (await fullList()).filter((p) => this._matches(s, p));
            if (hits.length) { alive = true; s.names = new Set(hits.map((p) => p.name)); }
          }
          if (alive) s.lastSeen = now;
          else this._end(s.id);
        }
      }
    } finally {
      this.ticking = false;
      if (this.again) {
        this.again = false;
        this._schedule(0);
      } else {
        const polled = this._polled();
        if (polled.length) this._schedule(polled.some((s) => !s.detectedAt) ? DETECT_POLL_MS : TRACK_POLL_MS);
      }
    }
  }

  /** Checks right away (e.g. when the launcher window gets focus again). */
  checkNow() {
    if (!this._polled().length) return;
    const now = this.now();
    if (now - this.lastCheckNow < CHECK_NOW_GAP_MS) return;
    this.lastCheckNow = now;
    this._schedule(0);
  }

  /** Ends a session by hand ("Not playing anymore"). Records playtime up to now. */
  stop(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.mode === 'poll' && s.detectedAt) s.lastSeen = this.now();
    this._end(id, { manual: true });
    return true;
  }

  _end(id, { discard = false, manual = false } = {}) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    if (!discard && s.detectedAt && s.countPlaytime) {
      const end = s.mode === 'poll' ? (s.lastSeen || this.now()) : this.now();
      const minutes = Math.max(0, (end - s.detectedAt) / 60000);
      if (minutes >= 0.5) this.store.addPlaytime(id, minutes, s.startedAt);
    }
    this.emit('ended', id, { detected: !!s.detectedAt, manual });
    if (!this._polled().length && this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  stopAll() {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }
}

module.exports = { Sessions, findExecutables, isHelperExe };
