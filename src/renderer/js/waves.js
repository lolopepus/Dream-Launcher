/*
 * Dream Launcher - animated ribbon waves (inspired by the PlayStation 3 menu background).
 *
 * The waves are drawn on every display refresh while they move. Drawing at an uneven, lower rate
 * (the old ~30 fps limit) made screens with variable refresh rate (G-Sync / FreeSync) keep changing
 * their refresh rate, which shows as the whole background flickering on some monitors. Lines are
 * a little thicker than a hairline and scale with the window, so they don't shimmer while moving.
 */
(function () {
  'use strict';
  const DL = (window.DL = window.DL || {});

  const MODES = {
    intro: { yBase: 0.6, amp: 1.25, alpha: 0.75, speed: 1.6, spread: 1.15 },
    dashboard: { yBase: 0.6, amp: 1.0, alpha: 0.46, speed: 1.0, spread: 1.0 },
    calm: { yBase: 0.6, amp: 0.9, alpha: 0.22, speed: 0.6, spread: 1.0 },
    hub: { yBase: 0.34, amp: 0.8, alpha: 0.3, speed: 0.8, spread: 0.9 },
  };
  const REVEAL_MS = 1900;
  const BANDS = [
    { lines: 24, spacing: 6.8, offset: 0, phase: 0, weight: 1 },
    { lines: 13, spacing: 9.6, offset: 70, phase: 2.1, weight: 0.55 },
  ];
  const LINE_WIDTH = 1.35; // at 1080p; scales with the window height
  const ALPHA_FIX = 0.86; // thicker lines, same brightness as before

  let canvas = null;
  let g = null;
  let w = 0;
  let h = 0;
  let dpr = 1;
  let raf = 0;
  let lastFrame = 0;
  let t = 0;
  let mode = 'intro';
  // Start-up: the ribbons are drawn in from left to right ("reveal" goes 0 -> 1).
  let reveal = 1;
  let revealStart = 0;
  // k: strength of the lines (colour themes: calmer on black and OLED black).
  const cur = { ...MODES.intro, r: 185, g: 170, b: 255, k: 1 };
  let target = { ...MODES.intro, r: 185, g: 170, b: 255, k: 1 };

  const S = () => DL.state.settings || {};
  /** Waves move: not with reduced motion or while a game is running. */
  const moving = () => !S().reduceMotion && !DL.state.gameRunning;

  function resize() {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function lerp(a, b, k) { return a + (b - a) * k; }

  function draw() {
    if (!g) return;
    g.clearRect(0, 0, w, h);
    const scale = h / 1080;
    const colour = `${Math.round(cur.r)},${Math.round(cur.g)},${Math.round(cur.b)}`;
    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, `rgba(${colour},0)`);
    grad.addColorStop(0.18, `rgba(${colour},1)`);
    grad.addColorStop(0.82, `rgba(${colour},1)`);
    grad.addColorStop(1, `rgba(${colour},0)`);
    g.strokeStyle = grad;
    g.lineWidth = Math.max(1, LINE_WIDTH * scale);
    const step = 16;
    for (const band of BANDS) {
      const n = band.lines;
      for (let k = 0; k < n; k++) {
        const edge = Math.sin((Math.PI * k) / (n - 1));
        g.globalAlpha = cur.alpha * cur.k * ALPHA_FIX * band.weight * (0.12 + 0.88 * edge);
        g.beginPath();
        for (let x = -step; x <= w + step; x += step) {
          const xs = x / scale;
          const y = h * cur.yBase
            + scale * cur.amp * (
              110 * Math.sin(xs / 330 + t * 0.22 + k * 0.085 + band.phase)
              + 38 * Math.sin(xs / 170 - t * 0.31 + k * 0.14)
              + 16 * Math.sin(xs / 95 + t * 0.47 + band.phase * 0.5)
            )
            + scale * (band.offset + (k - n / 2) * band.spacing * cur.spread);
          if (x === -step) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.stroke();
      }
    }
    g.globalAlpha = 1;
    if (reveal < 1) {
      // Hide everything right of the drawing head, with a soft edge and a glow at the head.
      const head = -0.1 * w + reveal * 1.25 * w;
      const soft = 260 * scale;
      g.globalCompositeOperation = 'destination-in';
      const mask = g.createLinearGradient(head - soft, 0, head, 0);
      mask.addColorStop(0, 'rgba(0,0,0,1)');
      mask.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = mask;
      g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'lighter';
      const y = h * cur.yBase;
      const glow = g.createRadialGradient(head - soft * 0.35, y, 0, head - soft * 0.35, y, 360 * scale);
      const a = 0.22 * Math.sin(Math.PI * Math.min(1, reveal * 1.1));
      glow.addColorStop(0, `rgba(${colour},${a.toFixed(3)})`);
      glow.addColorStop(1, `rgba(${colour},0)`);
      g.fillStyle = glow;
      g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'source-over';
    }
  }

  let freezeAt = 0;

  function frame(now) {
    raf = 0;
    if (!moving()) { settle(); return; }
    // While a menu is open the waves fade to "calm" and then stop, so the blurred
    // background behind the menu does not have to be redrawn every frame.
    if (mode === 'calm' && freezeAt && performance.now() > freezeAt) { draw(); return; }
    // One step per display refresh: an even frame rate keeps variable-refresh screens steady.
    const dt = Math.min(0.1, (now - (lastFrame || now)) / 1000);
    lastFrame = now;
    const k = Math.min(1, dt * 1.6);
    for (const key of Object.keys(target)) cur[key] = lerp(cur[key], target[key], k);
    if (revealStart) {
      const p = Math.min(1, (now - revealStart) / REVEAL_MS);
      reveal = 1 - Math.pow(1 - p, 3);
      if (p >= 1) revealStart = 0;
    }
    t += dt * cur.speed;
    draw();
    if (!document.hidden) raf = requestAnimationFrame(frame);
  }

  /** No movement: jump straight to the target look and draw it once. */
  function settle() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    Object.assign(cur, target);
    reveal = 1;
    revealStart = 0;
    draw();
  }

  function start() {
    if (!canvas) return;
    if (!moving()) { settle(); return; }
    if (!raf) {
      lastFrame = 0;
      raf = requestAnimationFrame(frame);
    }
  }

  DL.waves = {
    init(el) {
      canvas = el;
      g = canvas.getContext('2d');
      window.addEventListener('resize', resize);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) start(); });
      resize();
      start();
    },
    setMode(name) {
      if (!MODES[name]) return;
      mode = name;
      freezeAt = name === 'calm' ? performance.now() + 1200 : 0;
      target = { ...target, ...MODES[name] };
      start();
    },
    /**
     * Colour of the lines: the accent mixed with white (`white`: how much), drawn at `strength`.
     */
    setTint(rgb, { white = 0.45, strength = 1 } = {}) {
      if (!rgb) return;
      target.r = Math.round(rgb[0] * (1 - white) + 255 * white);
      target.g = Math.round(rgb[1] * (1 - white) + 255 * white);
      target.b = Math.round(rgb[2] * (1 - white) + 255 * white);
      target.k = strength;
      start();
    },
    /** Draws the ribbons in from the left (start-up animation). */
    playIntro() {
      if (!moving()) return;
      reveal = 0;
      revealStart = performance.now();
      start();
    },
    /** Call after the settings change or a game starts/ends. */
    refresh() { start(); },
  };
})();
