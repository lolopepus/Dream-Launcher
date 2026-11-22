/*
 * Dream Launcher - plays Steam clips (Steam game recording) inside the app.
 * Steam stores a clip as MPEG-DASH pieces (fragmented MP4, one or more recording sessions).
 * The pieces are handed to the video element with Media Source Extensions: nothing is converted,
 * and only the part around the playhead is kept in memory.
 */
(function () {
  'use strict';
  const DL = (window.DL = window.DL || {});

  const AHEAD = 20; // seconds loaded ahead of the playhead
  const BEHIND = 10; // seconds kept behind it (for short jumps back)
  const TICK_MS = 200;

  function canPlay(type) {
    try { return !!(window.MediaSource && MediaSource.isTypeSupported(type)); } catch { return false; }
  }

  /** "1:05" / "1:02:05" */
  function clock(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
  }

  /**
   * Lays the recording sessions of a clip end to end. Returns, per kind (video / audio), one list
   * of pieces with their place on the clip's timeline, and the init piece + shift of each session.
   */
  function layout(manifest) {
    const sessions = (manifest && manifest.sessions) || [];
    // Only kinds every session has: a kind missing in one session would stop playback there.
    const kindsIn = (s) => new Set(s.tracks.map((tr) => tr.kind));
    const common = ['video', 'audio'].filter((k) => sessions.length && sessions.every((s) => kindsIn(s).has(k)));
    const kinds = {};
    for (const k of common) kinds[k] = { kind: k, pieces: [], inits: [] };
    let offset = 0;
    let duration = 0;
    sessions.forEach((session, si) => {
      const tracks = session.tracks.filter((tr) => common.includes(tr.kind) && tr.segments.length);
      if (!tracks.length) return;
      const first = Math.min(...tracks.map((tr) => tr.segments[0].t));
      const ends = tracks.map((tr) => { const l = tr.segments[tr.segments.length - 1]; return l.t + l.d - first; });
      // The next session starts where the shorter track ends, so there is no hole to get stuck in
      // (the longer track's last moment is replaced by the start of the next session).
      const length = Math.max(0.1, Math.min(...ends));
      const shift = offset - first;
      for (const tr of tracks) {
        const k = kinds[tr.kind];
        k.inits[si] = { url: tr.init, shift, type: tr.type };
        for (const s of tr.segments) k.pieces.push({ url: s.url, session: si, start: s.t + shift, end: s.t + s.d + shift });
      }
      duration = offset + Math.max(...ends);
      offset += length;
    });
    return { kinds: common.map((k) => kinds[k]), duration };
  }

  /**
   * Plays one clip in `video`. Returns a controller: { ready (Promise), play(), pause(), toggle(),
   * seek(t), seekBy(dt), destroy(), info }. `onState` is called when anything visible changes.
   */
  function play(video, manifest, { onState } = {}) {
    const plan = layout(manifest);
    const info = { duration: plan.duration, error: null, codec: '' };
    const video0 = plan.kinds.find((k) => k.kind === 'video');
    const notify = () => { try { if (onState) onState(info); } catch { /* ignore */ } };

    if (!window.MediaSource) info.error = 'unsupported';
    else if (!video0) info.error = 'empty';
    else {
      const type = video0.inits.find(Boolean).type;
      info.codec = /hvc1|hev1/i.test(type) ? 'hevc' : /av01/i.test(type) ? 'av1' : /avc/i.test(type) ? 'h264' : '';
      if (!canPlay(type)) info.error = 'codec';
    }
    if (info.error) {
      // Nothing to play: a stand-in with the same shape, so the caller can show the reason.
      return {
        ready: Promise.resolve(info), info, currentTime: 0, paused: true, ended: false, state: 'none',
        buffered: () => 0, play() {}, pause() {}, toggle() {}, seek() {}, seekBy() {}, destroy() {},
      };
    }
    // Audio in a format this PC can't play: show the video without sound.
    const kinds = plan.kinds.filter((k) => k.kind === 'video' || canPlay(k.inits.find(Boolean).type));
    info.muted = kinds.length < plan.kinds.length;

    const ms = new MediaSource();
    const url = URL.createObjectURL(ms);
    const ctrl = new AbortController();
    let destroyed = false;
    let timer = null;
    let lastT = -1;
    let stuckSince = 0;
    let quotaHits = 0;
    let readyResolve;
    const ready = new Promise((r) => { readyResolve = r; });

    const tracks = kinds.map((k) => ({ ...k, sb: null, appended: new Set(), lastInit: -1, busy: false, type: '' }));

    const fail = (code) => {
      if (destroyed || info.error) return;
      info.error = code;
      notify();
      readyResolve(info);
    };

    const appendTo = (tr, data) => new Promise((resolve, reject) => {
      const sb = tr.sb;
      const done = () => { sb.removeEventListener('updateend', done); sb.removeEventListener('error', bad); resolve(); };
      const bad = () => { sb.removeEventListener('updateend', done); sb.removeEventListener('error', bad); reject(new Error('append')); };
      sb.addEventListener('updateend', done);
      sb.addEventListener('error', bad);
      try { sb.appendBuffer(data); } catch (err) { sb.removeEventListener('updateend', done); sb.removeEventListener('error', bad); reject(err); }
    });

    const removeFrom = (tr, start, end) => new Promise((resolve) => {
      const sb = tr.sb;
      const done = () => { sb.removeEventListener('updateend', done); resolve(); };
      sb.addEventListener('updateend', done);
      try { sb.remove(start, end); } catch { sb.removeEventListener('updateend', done); resolve(); }
    });

    const fetchBuf = async (u) => {
      const res = await fetch(u, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.arrayBuffer();
    };

    /**
     * What a track should do next, decided right away (no waiting): drop data far behind or far
     * ahead of the playhead (memory is limited), load a session's init piece, or load a piece.
     */
    function nextWork(tr, t, hard) {
      const b = tr.sb.buffered;
      if (b.length) {
        const cutBack = t - (hard ? 2 : BEHIND);
        if (b.start(0) < cutBack - 1) return { type: 'drop', from: 0, to: cutBack };
        const cutAhead = t + (hard ? Math.max(6, AHEAD / 2) : AHEAD + 8);
        if (b.end(b.length - 1) > cutAhead + 1 && cutAhead < ms.duration) return { type: 'drop', from: cutAhead, to: Infinity };
      }
      if (hard) return null;
      const idx = tr.pieces.findIndex((p, i) => p.end > t + 0.05 && p.start < t + AHEAD && !tr.appended.has(i));
      if (idx < 0) return null;
      const p = tr.pieces[idx];
      if (tr.lastInit !== p.session) return { type: 'init', session: p.session };
      return { type: 'piece', idx };
    }

    async function drop(tr, from, to) {
      await removeFrom(tr, from, to);
      tr.pieces.forEach((p, i) => { if (to === Infinity ? p.end > from : p.start < to) tr.appended.delete(i); });
    }

    /** One step for one track. */
    async function feed(tr) {
      if (tr.busy || destroyed || !tr.sb || tr.sb.updating) return;
      const work = nextWork(tr, video.currentTime, false);
      if (!work) return;
      tr.busy = true;
      try {
        if (work.type === 'drop') {
          await drop(tr, work.from, work.to);
        } else if (work.type === 'init') {
          // A recording session starts with its own init piece, placed on the clip's timeline.
          const init = tr.inits[work.session];
          const data = await fetchBuf(init.url);
          if (destroyed) return;
          if (init.type !== tr.type && typeof tr.sb.changeType === 'function') { tr.sb.changeType(init.type); tr.type = init.type; }
          tr.sb.timestampOffset = init.shift;
          await appendTo(tr, data);
          tr.lastInit = work.session;
        } else {
          const data = await fetchBuf(tr.pieces[work.idx].url);
          if (destroyed) return;
          try {
            await appendTo(tr, data);
            tr.appended.add(work.idx);
            quotaHits = 0;
          } catch (err) {
            if (!err || err.name !== 'QuotaExceededError') throw err;
            // Too much in memory: keep only what is right around the playhead, then try again.
            quotaHits++;
            if (quotaHits > 6) { fail('memory'); return; }
            const hard = nextWork(tr, video.currentTime, true);
            if (hard) await drop(tr, hard.from, hard.to);
          }
        }
      } catch (err) {
        if (!destroyed && !(err && err.name === 'AbortError')) {
          console.warn('[clips]', err);
          fail('read');
        }
      } finally {
        tr.busy = false;
      }
    }

    /** All pieces from the playhead to the end are in: tell the player the clip ends there. */
    function maybeEnd() {
      if (ms.readyState !== 'open') return;
      const t = video.currentTime;
      for (const tr of tracks) {
        if (tr.busy || tr.sb.updating) return;
        const from = tr.pieces.findIndex((p) => p.end > t);
        if (from < 0) continue;
        for (let i = from; i < tr.pieces.length; i++) if (!tr.appended.has(i)) return;
      }
      try { ms.endOfStream(); } catch { /* not yet */ }
    }

    /** Skips small holes between pieces or sessions instead of waiting forever. */
    function unstick() {
      if (video.paused || video.seeking || video.ended) { stuckSince = 0; lastT = video.currentTime; return; }
      const t = video.currentTime;
      if (t !== lastT) { lastT = t; stuckSince = 0; return; }
      if (!stuckSince) { stuckSince = performance.now(); return; }
      if (performance.now() - stuckSince < 400) return;
      const b = video.buffered;
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) > t && b.start(i) - t < 3) {
          video.currentTime = b.start(i) + 0.02;
          stuckSince = 0;
          return;
        }
      }
    }

    function tick() {
      if (destroyed) return;
      // Once the whole end is loaded the player knows the real length: the bar follows it.
      if (ms.readyState === 'ended' && Number.isFinite(video.duration) && video.duration > 0 && video.duration < info.duration) info.duration = video.duration;
      for (const tr of tracks) feed(tr);
      maybeEnd();
      unstick();
      notify();
    }

    ms.addEventListener('sourceopen', () => {
      if (destroyed) return;
      try {
        for (const tr of tracks) {
          const type = tr.inits.find(Boolean).type;
          tr.sb = ms.addSourceBuffer(type);
          tr.sb.mode = 'segments';
          tr.type = type;
        }
        ms.duration = plan.duration;
      } catch (err) {
        console.warn('[clips]', err);
        fail('codec');
        return;
      }
      timer = setInterval(tick, TICK_MS);
      tick();
    }, { once: true });

    const onSeeking = () => { stuckSince = 0; tick(); };
    const onError = () => fail(info.error || 'read');
    const onPlaying = () => readyResolve(info);
    const onEnded = () => { if (video.currentTime > 0 && video.currentTime < info.duration) { info.duration = video.currentTime; notify(); } };
    video.addEventListener('ended', onEnded);
    const onAny = () => notify();
    video.addEventListener('seeking', onSeeking);
    video.addEventListener('error', onError);
    video.addEventListener('playing', onPlaying);
    for (const ev of ['play', 'pause', 'ended', 'timeupdate', 'progress', 'waiting', 'loadeddata']) video.addEventListener(ev, onAny);
    // The very first moment may sit a few frames after 0 (audio/video start a little apart).
    const onData = () => {
      const b = video.buffered;
      if (b.length && video.currentTime < b.start(0)) video.currentTime = b.start(0) + 0.01;
    };
    video.addEventListener('loadeddata', onData, { once: true });
    video.src = url;

    const api = {
      ready,
      info,
      get currentTime() { return video.currentTime; },
      get paused() { return video.paused; },
      get ended() { return video.ended; },
      get state() { return ms.readyState; },
      buffered() {
        const b = video.buffered;
        const t = video.currentTime;
        for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.3 && b.end(i) >= t) return b.end(i);
        return t;
      },
      play() {
        if (info.error || destroyed) return;
        if (video.ended) video.currentTime = 0;
        const p = video.play();
        if (p && p.catch) p.catch(() => {});
      },
      pause() { if (!destroyed) video.pause(); },
      toggle() { if (video.paused || video.ended) api.play(); else api.pause(); },
      seek(sec) {
        if (info.error || destroyed) return;
        const d = Number.isFinite(video.duration) ? video.duration : plan.duration;
        video.currentTime = Math.max(0, Math.min(Math.max(0, d - 0.05), sec));
      },
      seekBy(dt) { api.seek(video.currentTime + dt); },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        clearInterval(timer);
        ctrl.abort();
        video.removeEventListener('seeking', onSeeking);
        video.removeEventListener('error', onError);
        video.removeEventListener('playing', onPlaying);
        video.removeEventListener('ended', onEnded);
        video.removeEventListener('loadeddata', onData);
        for (const ev of ['play', 'pause', 'ended', 'timeupdate', 'progress', 'waiting', 'loadeddata']) video.removeEventListener(ev, onAny);
        try { video.pause(); } catch { /* ignore */ }
        video.removeAttribute('src');
        try { video.load(); } catch { /* ignore */ }
        URL.revokeObjectURL(url);
        readyResolve(info);
      },
    };
    return api;
  }

  DL.clips = { play, layout, clock, canPlay };
})();
