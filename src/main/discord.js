'use strict';
/*
 * Dream Launcher - Discord status ("Rich Presence").
 * Talks to the Discord desktop app over its local IPC pipe (no extra packages, no internet of
 * our own): \\?\pipe\discord-ipc-N on Windows, $XDG_RUNTIME_DIR/discord-ipc-N elsewhere.
 * Shows "Playing Dream Launcher" on the profile while the launcher is open (no game names).
 * If Discord isn't running it tries again every 20 seconds, quietly.
 */
const net = require('net');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// The ID of the "Dream Launcher" application in the Discord Developer Portal. Its name is what
// Discord shows ("Playing Dream Launcher"), and its Rich Presence art asset "logo" is the picture.
const CLIENT_ID = process.env.DL_DISCORD_CLIENT_ID || '1576206694986416198';

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const RETRY_MS = 20000;
const SEND_DELAY_MS = 1500; // Discord accepts ~5 updates per 20 s: wait for things to settle.

const TEXT = {
  en: { launcher: 'Dream Launcher', github: 'Dream Launcher on GitHub' },
  de: { launcher: 'Dream Launcher', github: 'Dream Launcher auf GitHub' },
  pl: { launcher: 'Dream Launcher', github: 'Dream Launcher na GitHubie' },
};

function pipePath(i) {
  if (process.platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${i}`;
  const dir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || os.tmpdir();
  return path.join(dir, `discord-ipc-${i}`);
}

function encode(op, data) {
  const json = Buffer.from(JSON.stringify(data), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

/** Splits incoming bytes into frames: [{op, data}], plus the bytes left over. */
function decode(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 8) {
    const op = buf.readInt32LE(off);
    const len = buf.readInt32LE(off + 4);
    if (len < 0 || len > 1 << 20) return { frames, rest: Buffer.alloc(0), bad: true };
    if (buf.length - off - 8 < len) break;
    let data = null;
    try { data = JSON.parse(buf.slice(off + 8, off + 8 + len).toString('utf8')); } catch { /* ignore */ }
    frames.push({ op, data });
    off += 8 + len;
  }
  return { frames, rest: buf.slice(off) };
}

const clip = (s, max = 128) => {
  s = String(s || '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s.length === 1 ? `${s} ` : s; // Discord needs 2+ chars
};

/**
 * What to show: only "Dream Launcher" with its logo and how long it's been open, no game names.
 * state: { enabled, lang, playing, since, repo }. While a game runs nothing is shown, so Discord's
 * own game detection is what friends see. Returns null for "nothing".
 */
function buildActivity(state) {
  if (!state || !state.enabled || state.playing) return null;
  const tx = TEXT[state.lang] || TEXT.en;
  const act = { assets: { large_image: 'logo', large_text: tx.launcher }, instance: false };
  if (state.since) act.timestamps = { start: Math.floor(state.since) };
  if (state.repo) act.buttons = [{ label: tx.github, url: `https://github.com/${state.repo}` }];
  return act;
}

class DiscordPresence {
  constructor({ clientId = CLIENT_ID, log = console, pid = process.pid } = {}) {
    this.clientId = clientId;
    this.log = log;
    this.pid = pid;
    this.sock = null;
    this.ready = false;
    this.buf = Buffer.alloc(0);
    this.activity = null;
    this.sent = undefined; // last activity sent (JSON) while connected
    this.retryTimer = null;
    this.sendTimer = null;
    this.running = false;
    this.user = null;
  }

  get available() { return !!this.clientId; }

  start() {
    if (this.running || !this.available) return;
    this.running = true;
    this._connect(0);
  }

  stop() {
    this.running = false;
    clearTimeout(this.retryTimer);
    clearTimeout(this.sendTimer);
    if (this.sock && this.ready) {
      // Clear the status before leaving, so it doesn't linger.
      try { this.sock.write(encode(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: this.pid }, nonce: crypto.randomUUID() })); } catch { /* closing anyway */ }
    }
    this._drop();
  }

  /** Sets what is shown (null clears). Sent after a short pause, only when it changed. */
  set(activity) {
    this.activity = activity || null;
    if (!this.running || !this.ready) return;
    clearTimeout(this.sendTimer);
    this.sendTimer = setTimeout(() => this._send(), SEND_DELAY_MS);
    if (this.sendTimer.unref) this.sendTimer.unref();
  }

  _send() {
    if (!this.sock || !this.ready) return;
    const json = JSON.stringify(this.activity);
    if (json === this.sent) return;
    this.sent = json;
    const args = { pid: this.pid };
    if (this.activity) args.activity = this.activity;
    this.sock.write(encode(OP.FRAME, { cmd: 'SET_ACTIVITY', args, nonce: crypto.randomUUID() }));
  }

  _drop() {
    const s = this.sock;
    this.sock = null;
    this.ready = false;
    this.sent = undefined;
    this.buf = Buffer.alloc(0);
    if (s) { s.removeAllListeners(); s.on('error', () => {}); s.destroy(); }
  }

  _retry() {
    this._drop();
    if (!this.running) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this._connect(0), RETRY_MS);
    if (this.retryTimer.unref) this.retryTimer.unref();
  }

  _connect(i) {
    if (!this.running) return;
    if (i > 9) { this._retry(); return; }
    const sock = net.createConnection(pipePath(i));
    let opened = false;
    sock.once('connect', () => {
      opened = true;
      this.sock = sock;
      sock.write(encode(OP.HANDSHAKE, { v: 1, client_id: this.clientId }));
    });
    sock.on('error', () => {
      if (!opened) { sock.destroy(); this._connect(i + 1); } else this._retry();
    });
    sock.on('close', () => { if (opened && this.sock === sock) this._retry(); });
    sock.on('data', (chunk) => {
      const { frames, rest, bad } = decode(Buffer.concat([this.buf, chunk]));
      this.buf = rest;
      if (bad) { this._retry(); return; }
      for (const f of frames) this._frame(sock, f);
    });
  }

  _frame(sock, { op, data }) {
    if (op === OP.PING) { sock.write(encode(OP.PONG, data)); return; }
    if (op === OP.CLOSE) { this.log.warn && this.log.warn('discord closed the connection', data && data.message); this._retry(); return; }
    if (op !== OP.FRAME || !data) return;
    if (data.cmd === 'DISPATCH' && data.evt === 'READY') {
      this.ready = true;
      this.user = data.data && data.data.user ? data.data.user.username : null;
      this._send();
    } else if (data.evt === 'ERROR') {
      this.log.warn && this.log.warn('discord', data.data && data.data.message);
    }
  }
}

module.exports = { DiscordPresence, buildActivity, encode, decode, pipePath, CLIENT_ID, TEXT };
