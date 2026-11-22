'use strict';
/**
 * Online / offline state.
 *
 * Mode "auto": online whenever the internet can be reached (checked with the same test page
 * Windows itself uses, with Steam's public server-info call as a second opinion).
 * Mode "offline": everything that needs the internet is switched off, even with a connection.
 *
 * While offline, onlineFetch() refuses requests right away, so nothing waits on timeouts.
 */
const EventEmitter = require('events');

const PROBES = [
  { url: 'http://www.msftconnecttest.com/connecttest.txt', check: (status, text) => status === 200 && /Microsoft Connect Test/i.test(text) },
  { url: 'https://api.steampowered.com/ISteamWebAPIUtil/GetServerInfo/v1/', check: (status, text) => status === 200 && /servertime/i.test(text) },
];
const PROBE_TIMEOUT_MS = 6000;
const ONLINE_RECHECK_MS = 5 * 60 * 1000;
const OFFLINE_RECHECK_MS = 30 * 1000;
const LINK_POLL_MS = 10 * 1000;
const FAILURE_RECHECK_MS = 2500;

class OfflineError extends Error {
  constructor() {
    super('offline');
    this.offline = true;
  }
}

/** True for errors that mean "no connection" (not HTTP errors from a server that answered). */
function isNetworkError(err) {
  if (!err) return false;
  if (err.offline) return true;
  const msg = `${err.name || ''} ${err.code || ''} ${err.message || ''}`;
  return /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_CONNECTION_(REFUSED|RESET|TIMED_OUT|CLOSED|ABORTED)|ERR_ADDRESS_UNREACHABLE|ERR_PROXY_CONNECTION_FAILED|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|AbortError|aborted|network|fetch failed/i.test(msg);
}

class Connectivity extends EventEmitter {
  /**
   * @param {object} o
   * @param {Function} o.fetch       raw fetch (not gated)
   * @param {Function} o.getMode     () => 'auto' | 'offline'
   * @param {Function} [o.linkUp]    () => boolean, does the PC have any network at all (Electron net.isOnline)
   */
  constructor({ fetch, getMode, linkUp = () => true, log = console, timers = { setTimeout, clearTimeout }, now = Date.now }) {
    super();
    this.fetch = fetch;
    this.getMode = getMode;
    this.linkUp = linkUp;
    this.log = log;
    this.timers = timers;
    this.now = now;
    // Optimistic until the first check: start-up should not wait for the network.
    this.state = { online: true, mode: 'auto', reason: null, checkedAt: 0, since: now() };
    this._timer = null;
    this._linkTimer = null;
    this._checking = null;
    this._lastLink = null;
  }

  isOnline() { return this.state.online; }

  snapshot() { return { ...this.state }; }

  start() {
    this.check().catch(() => {});
    const poll = () => {
      this._linkTimer = this._later(() => {
        // Cable unplugged / Wi-Fi gone: notice within seconds, without network traffic.
        const up = this._safeLinkUp();
        if (this._lastLink !== null && up !== this._lastLink) this.check().catch(() => {});
        this._lastLink = up;
        poll();
      }, LINK_POLL_MS);
    };
    poll();
  }

  stop() {
    if (this._timer) this.timers.clearTimeout(this._timer);
    if (this._linkTimer) this.timers.clearTimeout(this._linkTimer);
    this._timer = null;
    this._linkTimer = null;
  }

  /** Timers must not keep the process alive on their own. */
  _later(fn, ms) {
    const t = this.timers.setTimeout(fn, ms);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  }

  _safeLinkUp() {
    try { return this.linkUp() !== false; } catch { return true; }
  }

  _schedule(ms) {
    if (this._timer) this.timers.clearTimeout(this._timer);
    this._timer = this._later(() => { this._timer = null; this.check().catch(() => {}); }, ms);
  }

  /** Re-evaluates the state now. Several calls at once share one check. */
  check() {
    if (this._checking) return this._checking;
    this._checking = this._check().finally(() => { this._checking = null; });
    return this._checking;
  }

  async _check() {
    const mode = this.getMode() === 'offline' ? 'offline' : 'auto';
    let online = false;
    let reason = null;
    if (mode === 'offline') {
      reason = 'forced';
    } else if (!this._safeLinkUp()) {
      reason = 'noNetwork';
    } else if (await this._probe()) {
      online = true;
    } else {
      reason = 'noInternet';
    }
    this._lastLink = this._safeLinkUp();
    this._set({ online, mode, reason });
    if (mode === 'auto') this._schedule(online ? ONLINE_RECHECK_MS : OFFLINE_RECHECK_MS);
    return this.snapshot();
  }

  async _probe() {
    for (const p of PROBES) {
      let timer = null;
      try {
        const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        if (ctrl) timer = this._later(() => ctrl.abort(), PROBE_TIMEOUT_MS);
        const res = await this.fetch(p.url, { cache: 'no-store', ...(ctrl ? { signal: ctrl.signal } : {}) });
        const text = await res.text();
        if (p.check(res.status, text)) return true;
      } catch {
        // try the next one
      } finally {
        if (timer) this.timers.clearTimeout(timer);
      }
    }
    return false;
  }

  _set({ online, mode, reason }) {
    const prev = this.state;
    const changed = prev.online !== online || prev.mode !== mode || prev.reason !== reason;
    this.state = { online, mode, reason, checkedAt: this.now(), since: changed ? this.now() : prev.since };
    if (changed) {
      this.log.info && this.log.info(`[net] ${online ? 'online' : `offline (${reason})`}`);
      this.emit('change', this.snapshot(), prev);
    }
  }

  /** The offline setting was changed: apply it right away. */
  modeChanged() { return this.check(); }

  /** A request failed with a network error: look again soon (debounced). */
  reportFailure(err) {
    if (!this.state.online || !isNetworkError(err) || (err && err.offline)) return;
    this._schedule(FAILURE_RECHECK_MS);
  }

  /** fetch() for everything that needs the internet: refuses at once while offline. */
  onlineFetch() {
    return (url, opts) => {
      if (!this.state.online) return Promise.reject(new OfflineError());
      return Promise.resolve(this.fetch(url, opts)).catch((err) => {
        this.reportFailure(err);
        throw err;
      });
    };
  }
}

module.exports = { Connectivity, OfflineError, isNetworkError };
