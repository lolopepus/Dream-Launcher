/* Dream Launcher - animated ribbon waves (inspired by the PlayStation 3 menu background). */
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
    { lines: 26, spacing: 6.2, offset: 0, phase: 0, weight: 1 },
    { lines: 14, spacing: 9, offset: 70, phase: 2.1, weight: 0.55 },
  ];

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
  const cur = { ...MODES.intro, r: 185, g: 170, b: 255 };
  let target = { ...MODES.intro, r: 185, g: 170, b: 255 };

  function resize() {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
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
    g.lineWidth = 1.1;
    const step = 16;
    for (const band of BANDS) {
      const n = band.lines;
      for (let k = 0; k < n; k++) {
        const edge = Math.sin((Math.PI * k) / (n - 1));
        g.globalAlpha = cur.alpha * band.weight * (0.12 + 0.88 * edge);
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
    const reduce = DL.state.settings && DL.state.settings.reduceMotion;
    // While a menu is open the waves fade to "calm" and then stop, so the blurred
    // background behind the menu does not have to be redrawn every frame.
    if (mode === 'calm' && freezeAt && performance.now() > freezeAt) { draw(); return; }
    const minDt = mode === 'intro' ? 0 : 30;
    if (now - lastFrame >= minDt) {
      const dt = Math.min(0.1, (now - (lastFrame || now)) / 1000);
      lastFrame = now;
      const k = Math.min(1, dt * 1.6);
      for (const key of Object.keys(target)) cur[key] = lerp(cur[key], target[key], k);
      if (revealStart) {
        const p = Math.min(1, (now - revealStart) / REVEAL_MS);
        reveal = 1 - Math.pow(1 - p, 3);
        if (p >= 1) revealStart = 0;
      }
      if (!reduce) t += dt * cur.speed;
      draw();
    }
    if (!document.hidden && !reduce) raf = requestAnimationFrame(frame);
  }

  function start() {
    if (!canvas) return;
    if (DL.state.settings && DL.state.settings.reduceMotion) {
      // Reduced motion: no animation, jump straight to the target look.
      Object.assign(cur, target);
      draw();
      return;
    }
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
    setTint(rgb) {
      if (!rgb) return;
      // Keep the waves light: mix the accent colour with white.
      target.r = Math.round(rgb[0] * 0.55 + 255 * 0.45);
      target.g = Math.round(rgb[1] * 0.55 + 255 * 0.45);
      target.b = Math.round(rgb[2] * 0.55 + 255 * 0.45);
      start();
    },
    /** Draws the ribbons in from the left (start-up animation). */
    playIntro() {
      if (DL.state.settings && DL.state.settings.reduceMotion) return;
      reveal = 0;
      revealStart = performance.now();
      start();
    },
    refresh() {
      const reduce = DL.state.settings && DL.state.settings.reduceMotion;
      if (reduce) {
        Object.assign(cur, target);
        draw();
      } else {
        start();
      }
    },
  };
})();
