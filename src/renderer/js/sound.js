/*
 * Dream Launcher - sounds and music.
 *
 * Interface sounds are designed in code and rendered once at start-up into audio buffers
 * (layered tones, soft FM bells, filtered noise sweeps and a shared reverb), then played
 * instantly from memory. The background music is the bundled track "Memory Loop" by
 * Abstract Aprils (Uppbeat) or a music file chosen in Options; it loops with a crossfade and
 * can be played slowed down.
 */
(function () {
  'use strict';
  const DL = (window.DL = window.DL || {});

  const SR = 48000;
  let ctx = null;
  let uiGain = null;
  const bank = new Map();
  let bankReady = null;

  // ---------------------------------------------------------------- sound design
  function seeded(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  function makeImpulse(c, seconds, decay, rnd) {
    const len = Math.floor(SR * seconds);
    const pre = Math.floor(SR * 0.012);
    const buf = c.createBuffer(2, len, SR);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = pre; i < len; i++) {
        const t = (i - pre) / (len - pre);
        const k = 0.6 - 0.48 * t; // the tail gets darker over time
        lp += k * ((rnd() * 2 - 1) - lp);
        d[i] = lp * Math.pow(1 - t, decay) * 1.4;
      }
    }
    return buf;
  }

  function noiseBuffer(c, seconds, rnd) {
    const buf = c.createBuffer(1, Math.floor(SR * seconds), SR);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1;
    return buf;
  }

  /** Small toolkit bound to one offline context. */
  function kit(c, seed) {
    const rnd = seeded(seed);
    const out = c.createGain();
    out.connect(c.destination);
    const verb = c.createConvolver();
    verb.buffer = makeImpulse(c, 2.8, 3.2, rnd);
    const verbIn = c.createGain();
    verbIn.connect(verb);
    verb.connect(out);
    const noise = noiseBuffer(c, 3, rnd);

    function env(g, t0, attack, peak, tau) {
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + attack);
      g.gain.setTargetAtTime(0, t0 + attack, tau);
    }
    function route(node, { wet = 0, pan = null } = {}) {
      let last = node;
      if (pan !== null) {
        const p = c.createStereoPanner();
        p.pan.value = pan;
        last.connect(p);
        last = p;
      }
      last.connect(out);
      if (wet > 0) {
        const send = c.createGain();
        send.gain.value = wet;
        last.connect(send);
        send.connect(verbIn);
      }
      return last;
    }
    function tone(freq, t0, { type = 'sine', to = null, glide = 0.05, attack = 0.002, peak = 0.3, tau = 0.05, wet = 0, dur = null, detune = 0, pan = null } = {}) {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq, t0);
      if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + glide);
      o.detune.value = detune;
      const g = c.createGain();
      env(g, t0, attack, peak, tau);
      o.connect(g);
      route(g, { wet, pan });
      o.start(t0);
      o.stop(t0 + (dur || attack + tau * 9));
      return g;
    }
    /** Soft FM bell: a sine carrier modulated at `ratio` times its pitch, brightness fading out. */
    function bell(freq, t0, { ratio = 2, index = 0.8, peak = 0.25, tau = 0.2, wet = 0.3, pan = null } = {}) {
      const car = c.createOscillator();
      car.frequency.value = freq;
      const mod = c.createOscillator();
      mod.frequency.value = freq * ratio;
      const depth = c.createGain();
      depth.gain.setValueAtTime(freq * index, t0);
      depth.gain.setTargetAtTime(0, t0, tau * 0.6);
      mod.connect(depth);
      depth.connect(car.frequency);
      const g = c.createGain();
      env(g, t0, 0.003, peak, tau);
      car.connect(g);
      route(g, { wet, pan });
      const end = t0 + tau * 9;
      car.start(t0); mod.start(t0); car.stop(end); mod.stop(end);
    }
    /** Marimba-like note: fundamental plus a quickly fading 3.9x partial. */
    function mallet(freq, t0, { peak = 0.3, tau = 0.22, wet = 0.3 } = {}) {
      tone(freq, t0, { peak, tau, wet, attack: 0.002 });
      tone(freq * 3.9, t0, { peak: peak * 0.22, tau: tau * 0.14, wet: wet * 0.5, attack: 0.001 });
    }
    /** Filtered noise with a frequency sweep and a gain envelope. */
    function sweep(t0, dur, { type = 'bandpass', from = 500, to = 3000, q = 0.9, peak = 0.4, at = 0.5, tau = 0.06, wet = 0, pan = null, panTo = null } = {}) {
      const src = c.createBufferSource();
      src.buffer = noise;
      const f = c.createBiquadFilter();
      f.type = type;
      f.Q.value = q;
      f.frequency.setValueAtTime(from, t0);
      f.frequency.exponentialRampToValueAtTime(to, t0 + dur);
      const g = c.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + dur * at);
      g.gain.setTargetAtTime(0, t0 + dur * at, tau);
      src.connect(f);
      f.connect(g);
      let last = g;
      if (pan !== null) {
        const p = c.createStereoPanner();
        p.pan.setValueAtTime(pan, t0);
        if (panTo !== null) p.pan.linearRampToValueAtTime(panTo, t0 + dur);
        g.connect(p);
        last = p;
      }
      route(last, { wet });
      src.start(t0);
      src.stop(t0 + dur + tau * 9);
    }
    function click(t0, { peak = 0.2, hp = 3000, tau = 0.004 } = {}) {
      const src = c.createBufferSource();
      src.buffer = noise;
      // Band-limited so the tick stays soft (no harsh content near 20 kHz).
      const f = c.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = 0.8;
      f.frequency.value = hp * 1.5;
      const g = c.createGain();
      env(g, t0, 0.0005, peak, tau);
      src.connect(f);
      f.connect(g);
      route(g);
      src.start(t0, rnd() * 2);
      src.stop(t0 + 0.08);
    }
    return { c, out, verbIn, tone, bell, mallet, sweep, click, env, route, noise, rnd };
  }

  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

  /** name: [duration seconds, target peak, builder] */
  const DESIGNS = {
    move: [0.14, 0.3, (k) => {
      k.tone(2100, 0, { to: 1650, glide: 0.03, peak: 0.5, tau: 0.012 });
      k.tone(780, 0, { peak: 0.22, tau: 0.018 });
      k.click(0, { peak: 0.2, hp: 3200 });
    }],
    select: [1.15, 0.42, (k) => {
      k.tone(520, 0, { to: 980, glide: 0.04, peak: 0.55, tau: 0.03 });
      k.click(0, { peak: 0.12, hp: 2500 });
      k.bell(midi(88), 0.025, { ratio: 2, index: 0.8, peak: 0.32, tau: 0.12, wet: 0.25 });
      k.bell(midi(95), 0.06, { ratio: 2, index: 0.6, peak: 0.26, tau: 0.16, wet: 0.3 });
    }],
    back: [0.4, 0.34, (k) => {
      k.tone(980, 0, { to: 540, glide: 0.09, peak: 0.5, tau: 0.035 });
      k.sweep(0, 0.07, { from: 1600, to: 700, q: 1.2, peak: 0.16, at: 0.2, tau: 0.02 });
    }],
    toggle: [0.14, 0.28, (k) => {
      k.tone(1900, 0, { peak: 0.5, tau: 0.008 });
      k.click(0, { peak: 0.2, hp: 4000, tau: 0.003 });
      k.tone(2600, 0.03, { peak: 0.36, tau: 0.008 });
    }],
    open: [1.05, 0.34, (k) => {
      k.sweep(0, 0.24, { from: 500, to: 3600, q: 0.9, peak: 0.5, at: 0.45, tau: 0.05, wet: 0.15 });
      k.tone(midi(84), 0.04, { attack: 0.03, peak: 0.12, tau: 0.12, wet: 0.35 });
      k.tone(midi(91), 0.06, { attack: 0.03, peak: 0.1, tau: 0.12, wet: 0.35 });
    }],
    close: [0.7, 0.3, (k) => {
      k.sweep(0, 0.2, { from: 3200, to: 600, q: 0.9, peak: 0.45, at: 0.3, tau: 0.05, wet: 0.1 });
      k.tone(440, 0, { to: 300, glide: 0.08, peak: 0.14, tau: 0.04 });
    }],
    slide: [0.85, 0.26, (k) => {
      k.sweep(0, 0.2, { from: 400, to: 1800, q: 0.8, peak: 0.4, at: 0.45, tau: 0.06, wet: 0.2 });
      k.tone(660, 0.02, { to: 880, glide: 0.1, attack: 0.01, peak: 0.1, tau: 0.06, wet: 0.2 });
    }],
    slideBack: [0.85, 0.24, (k) => {
      k.sweep(0, 0.2, { from: 1800, to: 400, q: 0.8, peak: 0.4, at: 0.4, tau: 0.06, wet: 0.2 });
      k.tone(880, 0.02, { to: 660, glide: 0.1, attack: 0.01, peak: 0.1, tau: 0.06, wet: 0.2 });
    }],
    toast: [1.9, 0.4, (k) => {
      k.mallet(midi(79), 0, { peak: 0.3, tau: 0.22, wet: 0.3 });
      k.mallet(midi(86), 0.09, { peak: 0.3, tau: 0.3, wet: 0.35 });
    }],
    error: [0.7, 0.4, (k) => {
      for (const [t, f] of [[0, 233], [0.13, 196]]) {
        const o = k.c.createOscillator();
        o.type = 'triangle';
        o.frequency.value = f;
        const lp = k.c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 900;
        const g = k.c.createGain();
        k.env(g, t, 0.003, 0.6, 0.05);
        o.connect(lp); lp.connect(g); k.route(g, { wet: 0.08 });
        o.start(t); o.stop(t + 0.5);
        k.tone(f / 2, t, { peak: 0.2, tau: 0.05 });
      }
    }],
    launch: [3.3, 0.55, (k) => {
      k.sweep(0, 0.55, { type: 'highpass', from: 200, to: 5000, q: 0.7, peak: 0.42, at: 0.98, tau: 0.04, wet: 0.2 });
      const sub = k.c.createOscillator();
      sub.frequency.value = 55;
      const sg = k.c.createGain();
      sg.gain.setValueAtTime(0, 0);
      sg.gain.linearRampToValueAtTime(0.45, 0.55);
      sg.gain.setTargetAtTime(0, 0.55, 0.45);
      sub.connect(sg); k.route(sg);
      sub.start(0); sub.stop(3.3);
      [84, 88, 91, 96].forEach((n, i) => k.bell(midi(n), 0.5 + i * 0.08, { ratio: 2, index: 0.7, peak: 0.2, tau: 0.45, wet: 0.45, pan: -0.3 + i * 0.2 }));
      k.tone(midi(100), 0.82, { attack: 0.05, peak: 0.05, tau: 0.5, wet: 0.6 });
      k.tone(midi(103), 0.86, { attack: 0.05, peak: 0.04, tau: 0.5, wet: 0.6 });
    }],
    whoosh: [2.3, 0.45, (k) => {
      const src = k.c.createBufferSource();
      src.buffer = k.noise;
      const f = k.c.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = 0.8;
      f.frequency.setValueAtTime(300, 0);
      f.frequency.exponentialRampToValueAtTime(2200, 0.45);
      f.frequency.exponentialRampToValueAtTime(700, 1.0);
      const g = k.c.createGain();
      g.gain.setValueAtTime(0, 0);
      g.gain.linearRampToValueAtTime(0.6, 0.4);
      g.gain.setTargetAtTime(0, 0.5, 0.2);
      const p = k.c.createStereoPanner();
      p.pan.setValueAtTime(-0.6, 0);
      p.pan.linearRampToValueAtTime(0.6, 1.0);
      src.connect(f); f.connect(g); g.connect(p); k.route(p, { wet: 0.25 });
      src.start(0); src.stop(2.3);
      k.tone(80, 0.1, { attack: 0.3, peak: 0.2, tau: 0.25 });
    }],
    intro: [6.8, 0.7, (k) => {
      const c = k.c;
      // Reverse swell rising into the logo reveal.
      const src = c.createBufferSource();
      src.buffer = k.noise;
      const hp = c.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.setValueAtTime(150, 0);
      hp.frequency.exponentialRampToValueAtTime(3000, 1.1);
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 6500;
      const sg = c.createGain();
      sg.gain.setValueAtTime(0.0001, 0);
      sg.gain.exponentialRampToValueAtTime(0.42, 1.08);
      sg.gain.setTargetAtTime(0, 1.1, 0.012);
      src.connect(hp); hp.connect(lp); lp.connect(sg); k.route(sg, { wet: 0.35 });
      src.start(0); src.stop(1.3);
      // Impact: deep drop with a soft body.
      const sub = c.createOscillator();
      sub.frequency.setValueAtTime(72, 1.1);
      sub.frequency.exponentialRampToValueAtTime(38, 2.0);
      const subG = c.createGain();
      k.env(subG, 1.1, 0.004, 0.85, 0.45);
      sub.connect(subG); k.route(subG);
      sub.start(1.1); sub.stop(6.8);
      k.sweep(1.1, 0.2, { type: 'lowpass', from: 400, to: 160, q: 0.7, peak: 0.45, at: 0.02, tau: 0.08 });
      // Warm pad (D major add 9) that opens up.
      const harmonics = Array.from({ length: 10 }, (_, i) => 1 / ((i + 1) * (i + 1) * 0.6 + 0.4));
      const real = new Float32Array(harmonics.length + 1);
      const imag = new Float32Array(harmonics.length + 1);
      harmonics.forEach((a, i) => { imag[i + 1] = a; });
      const wave = c.createPeriodicWave(real, imag);
      const filt = c.createBiquadFilter();
      filt.type = 'lowpass';
      filt.Q.value = 0.5;
      filt.frequency.setValueAtTime(600, 1.0);
      filt.frequency.exponentialRampToValueAtTime(2200, 3.0);
      const pad = c.createGain();
      pad.gain.setValueAtTime(0, 0.9);
      pad.gain.linearRampToValueAtTime(0.075, 2.2);
      pad.gain.setValueAtTime(0.075, 3.6);
      pad.gain.setTargetAtTime(0, 3.6, 0.6);
      filt.connect(pad);
      k.route(pad, { wet: 0.5 });
      [50, 57, 64, 66, 69].forEach((n, i) => {
        for (const det of [-7, 6]) {
          const o = c.createOscillator();
          o.setPeriodicWave(wave);
          o.frequency.value = midi(n);
          o.detune.value = det + i;
          o.connect(filt);
          o.start(0.9); o.stop(6.8);
        }
      });
      // Sparkles.
      [81, 86, 88, 90, 93].forEach((n, i) => k.bell(midi(n), 1.25 + i * 0.13, { ratio: 3, index: 0.5, peak: 0.11, tau: 0.6, wet: 0.6, pan: -0.5 + i * 0.25 }));
    }],
  };

  async function renderOne(name) {
    const [dur, target, build] = DESIGNS[name];
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const c = new OAC(2, Math.ceil(SR * dur), SR);
    let seed = 0;
    for (const ch of name) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    build(kit(c, seed || 7));
    const buf = await c.startRendering();
    let peak = 0;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
    }
    const g = peak > 0 ? target / peak : 1;
    // Normalise, and fade the last part out smoothly so no reverb tail is cut off with a click.
    const fadeLen = Math.min(Math.floor(SR * 0.3), Math.floor(buf.length * 0.2));
    const fadeStart = buf.length - fadeLen;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) {
        let k = g;
        if (i >= fadeStart) k *= 0.5 + 0.5 * Math.cos((Math.PI * (i - fadeStart)) / fadeLen);
        d[i] *= k;
      }
    }
    return buf;
  }

  /**
   * Renders the interface sounds once. The start-up sounds come first (the intro waits only for
   * those); the rest follow right after in the background.
   */
  function prepare() {
    if (bankReady) return bankReady;
    const first = ['intro', 'whoosh'];
    const renderAll = async (names) => {
      for (const name of names) {
        if (bank.has(name)) continue;
        try { bank.set(name, await renderOne(name)); } catch (err) { console.warn('sound', name, err); }
      }
    };
    bankReady = renderAll(first);
    bankReady.then(() => renderAll(Object.keys(DESIGNS)));
    return bankReady;
  }

  // ---------------------------------------------------------------- playback
  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC({ latencyHint: 'interactive', sampleRate: SR }); } catch {
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch { ctx = null; return null; }
    }
    uiGain = ctx.createGain();
    uiGain.connect(ctx.destination);
    applyUiVolume();
    return ctx;
  }

  function applyUiVolume() {
    if (!ctx) return;
    const s = DL.state.settings || {};
    const v = s.uiSounds === false ? 0 : (Number(s.soundVolume ?? 70) / 100) * 0.9;
    uiGain.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
  }

  let lastMove = 0;
  function play(name, { pan = 0, detune = 0 } = {}) {
    const s = DL.state.settings || {};
    if (s.uiSounds === false) return;
    const c = ensure();
    if (!c) return;
    if (c.state === 'suspended') c.resume().catch(() => {});
    const buf = bank.get(name);
    if (!buf) { prepare(); return; }
    if (name === 'move') {
      const now = performance.now();
      if (now - lastMove < 35) return; // no buzzing while a direction is held
      lastMove = now;
    }
    try {
      const src = c.createBufferSource();
      src.buffer = buf;
      src.detune.value = detune;
      let last = src;
      if (pan) {
        const p = c.createStereoPanner();
        p.pan.value = DL.clamp(pan, -1, 1);
        src.connect(p);
        last = p;
      }
      last.connect(uiGain);
      src.start();
    } catch (err) {
      console.warn('sound', err);
    }
  }

  DL.sound = {
    unlock() {
      const c = ensure();
      if (c && c.state === 'suspended') c.resume().catch(() => {});
    },
    prepare,
    /** Plays a sound. For 'move', opts.x (0..1, position on screen) pans it slightly. */
    play(name, opts = {}) {
      if (name === 'move') {
        const pan = typeof opts.x === 'number' ? (opts.x * 2 - 1) * 0.35 : 0;
        play(name, { pan, detune: (Math.random() * 2 - 1) * 25 });
        return;
      }
      play(name, opts);
    },
    applySettings: applyUiVolume,
    context: () => ensure(),
    names: () => Object.keys(DESIGNS),
    /** For tests and previews: renders one sound and returns its AudioBuffer. */
    render: renderOne,
  };

  // ---------------------------------------------------------------- music
  // Built-in track: "Memory Loop" by Abstract Aprils (Uppbeat), bundled unchanged in audio/.
  // The track fades in over ~1.5 s and fades out from 178 s; the next pass starts at 179 s so
  // the two overlap inside the track's own fade (seamless loop).
  const BUILT_IN = { src: 'audio/memory-loop.mp3', loopAt: 179.0, xfade: 4.5 };
  const SPEEDS = { normal: 1, slowed: 0.9, slower: 0.8 };
  const CUSTOM_XFADE = 3.5;

  const players = [];
  let active = -1;
  let currentSrc = '';
  let musicMode = 'off';
  let watcher = 0;
  const pauseReasons = new Set();

  function musicVolume() {
    const s = DL.state.settings || {};
    return DL.clamp(Number(s.musicVolume ?? 35) / 100, 0, 1) * 0.8;
  }

  function speed() {
    const s = DL.state.settings || {};
    return SPEEDS[s.musicSpeed] || 1;
  }

  function applyVolume(p) {
    p.el.volume = DL.clamp(musicVolume() * p.level, 0, 1);
  }

  /** Animates one player's level (0..1) over `seconds`, then calls done(). */
  function fade(p, target, seconds, done) {
    clearInterval(p.timer);
    const from = p.level;
    const steps = Math.max(1, Math.round((seconds * 1000) / 40));
    let i = 0;
    p.timer = setInterval(() => {
      i++;
      const k = i / steps;
      p.level = from + (target - from) * (k * k * (3 - 2 * k));
      applyVolume(p);
      if (i >= steps) {
        clearInterval(p.timer);
        p.timer = 0;
        if (done) done();
      }
    }, 40);
  }

  function makePlayer(src) {
    const el = new Audio();
    el.preload = 'auto';
    el.loop = false;
    el.preservesPitch = false; // slowed = lower and slower, like a slowed record
    el.webkitPreservesPitch = false;
    el.src = src;
    el.volume = 0;
    const p = { el, level: 0, timer: 0, src };
    el.addEventListener('ended', () => {
      // Safety net if the crossfade point was missed (e.g. the window was hidden).
      if (players[active] === p && !pauseReasons.size) startNext(true);
    });
    return p;
  }

  function stopAll() {
    clearInterval(watcher);
    watcher = 0;
    for (const p of players) {
      clearInterval(p.timer);
      p.el.pause();
      p.el.removeAttribute('src');
      p.el.load();
    }
    players.length = 0;
    active = -1;
    currentSrc = '';
  }

  function loopPoint(p) {
    const d = p.el.duration;
    if (!Number.isFinite(d) || d <= 0) return Infinity;
    if (p.src === BUILT_IN.src) return Math.min(BUILT_IN.loopAt, d - 0.5);
    if (d < 20) return Infinity; // short files simply loop
    return d - CUSTOM_XFADE;
  }

  function startNext(immediate) {
    const cur = players[active];
    const nextIndex = active === 0 ? 1 : 0;
    if (!players[nextIndex]) players[nextIndex] = makePlayer(currentSrc);
    const next = players[nextIndex];
    next.el.playbackRate = speed();
    try { next.el.currentTime = 0; } catch { /* not loaded yet */ }
    next.level = 0;
    applyVolume(next);
    const pr = next.el.play();
    if (pr && pr.catch) pr.catch(() => {});
    const xf = cur && cur.src === BUILT_IN.src ? BUILT_IN.xfade : CUSTOM_XFADE;
    fade(next, 1, immediate ? 0.6 : Math.min(2.5, xf));
    if (cur) fade(cur, 0, immediate ? 0.2 : xf, () => { cur.el.pause(); });
    active = nextIndex;
  }

  function watch() {
    clearInterval(watcher);
    watcher = setInterval(() => {
      const p = players[active];
      if (!p || p.el.paused || pauseReasons.size) return;
      const lp = loopPoint(p);
      if (lp === Infinity) { p.el.loop = true; return; }
      p.el.loop = false;
      if (p.el.currentTime >= lp && !p.handedOver) {
        p.handedOver = true;
        startNext(false);
        setTimeout(() => { p.handedOver = false; }, 8000);
      }
    }, 200);
  }

  function sourceFor(mode) {
    const s = DL.state.settings || {};
    if (mode === 'builtin') return BUILT_IN.src;
    if (mode === 'custom' && s.customMusicFile) return `dl://media/${encodeURIComponent(s.customMusicFile)}`;
    return '';
  }

  function applyMusic() {
    const s = DL.state.settings || {};
    let mode = s.music || 'off';
    if (mode === 'ambient') mode = 'builtin';
    if (mode === 'custom' && !s.customMusicFile) mode = 'off';
    musicMode = mode;
    const src = sourceFor(mode);
    if (!src) { stopAll(); return; }
    if (src !== currentSrc) {
      stopAll();
      currentSrc = src;
      players[0] = makePlayer(src);
      active = 0;
    }
    for (const p of players) { p.el.playbackRate = speed(); applyVolume(p); }
    const p = players[active];
    if (pauseReasons.size > 0) {
      for (const q of players) if (!q.el.paused) fade(q, 0, 0.8, () => { if (pauseReasons.size > 0) q.el.pause(); });
      return;
    }
    if (p.el.paused) {
      const pr = p.el.play();
      if (pr && pr.catch) pr.catch(() => {});
      fade(p, 1, p.el.currentTime > 0.5 ? 1.2 : 2.5);
    } else if (p.level < 1 && !p.timer) {
      fade(p, 1, 1.2);
    }
    watch();
  }

  DL.music = {
    apply: applyMusic,
    pause(reason) { pauseReasons.add(reason); applyMusic(); },
    resume(reason) { pauseReasons.delete(reason); applyMusic(); },
    get mode() { return musicMode; },
    /** True while music is audible (used by tests). */
    get playing() { const p = players[active]; return !!(p && !p.el.paused && pauseReasons.size === 0); },
    get rate() { const p = players[active]; return p ? p.el.playbackRate : 0; },
    get src() { return currentSrc; },
    /** State of both players (for tests). */
    debug() {
      return { active, players: players.map((p) => ({ t: Math.round(p.el.currentTime * 10) / 10, paused: p.el.paused, level: Math.round(p.level * 100) / 100, rate: p.el.playbackRate, pitch: p.el.preservesPitch })) };
    },
    /** Jumps the playing track to a position in seconds (for tests). */
    seek(t) { const p = players[active]; if (p) p.el.currentTime = t; },
  };

  // Render the interface sounds as early as possible (needed for the intro).
  prepare();
})();
