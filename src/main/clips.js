'use strict';
/**
 * Steam Game Recording clips of a game.
 *
 * Steam keeps recordings in its recordings folder (Steam › Settings › Game Recording). By default
 * that is <Steam>\userdata\<account>\gamerecordings; a folder chosen in Steam is stored in
 * userdata\<account>\config\localconfig.vdf as GameRecording › BackgroundRecordPath.
 *
 *   clips\clip_<appid>_<YYYYMMDD>_<HHMMSS>\video\<session>\session.mpd
 *                                                         init-stream0.m4s, chunk-stream0-00001.m4s …  (video)
 *                                                         init-stream1.m4s, chunk-stream1-00001.m4s …  (audio)
 *
 * Every session is MPEG-DASH with fragmented MP4 pieces; a clip can consist of several sessions.
 * The pieces are played as they are (Media Source Extensions in the window), nothing is converted.
 */
const path = require('path');
const fsp = require('fs').promises;
const { parseVdf, vdfGet } = require('./util/vdf');

const MAX_CLIPS = 300;
const IMAGE_RE = /\.(jpe?g|png|webp)$/i;
const CLIP_DIR_RE = /^clip_(\d+)_(\d{8})_(\d{6})/i;

async function readText(p) {
  try { return await fsp.readFile(p, 'utf8'); } catch { return null; }
}

async function isDir(p) {
  try { return (await fsp.stat(p)).isDirectory(); } catch { return false; }
}

async function listDir(p) {
  try { return await fsp.readdir(p, { withFileTypes: true }); } catch { return []; }
}

/** Recording folders to look in: the one chosen in Steam first, then Steam's default. */
async function recordingsDirs(steamPath, accountId) {
  if (!steamPath || !accountId) return [];
  const userDir = path.join(steamPath, 'userdata', String(accountId));
  const out = [];
  const text = await readText(path.join(userDir, 'config', 'localconfig.vdf'));
  if (text) {
    let custom = '';
    try {
      const root = parseVdf(text);
      const rec = findKey(root, 'GameRecording', 4);
      const v = rec && typeof rec === 'object' ? vdfGet(rec, 'BackgroundRecordPath') : undefined;
      if (typeof v === 'string') custom = v.trim();
    } catch { custom = ''; }
    if (custom) out.push(custom);
  }
  out.push(path.join(userDir, 'gamerecordings'));
  const seen = new Set();
  const result = [];
  for (const d of out) {
    const key = path.resolve(d).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (await isDir(d)) result.push(d);
  }
  return result;
}

/** First object stored under `name` (any letter case), searched a few levels deep. */
function findKey(obj, name, depth) {
  if (!obj || typeof obj !== 'object' || depth < 0) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(obj)) {
    if (k.toLowerCase() === lower) return v;
  }
  for (const v of Object.values(obj)) {
    const hit = findKey(v, name, depth - 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** "20261120" + "183005" (local time) → ms. */
function clipTime(date, time) {
  const y = Number(date.slice(0, 4));
  const mo = Number(date.slice(4, 6)) - 1;
  const d = Number(date.slice(6, 8));
  const h = Number(time.slice(0, 2));
  const mi = Number(time.slice(2, 4));
  const s = Number(time.slice(4, 6));
  const t = new Date(y, mo, d, h, mi, s).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** ISO 8601 duration ("PT1M2.5S") → seconds. */
function isoDuration(v) {
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(String(v || '').trim());
  if (!m) return 0;
  return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3] || 0) * 60) + Number(m[4] || 0);
}

// ---------------------------------------------------------------- MPD (the part Steam/ffmpeg write)

function attrs(text) {
  const out = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[2] !== undefined ? m[2] : m[3];
  return out;
}

/** Tiny XML walk: returns a tree of { name, attrs, children } (no text, enough for an MPD). */
function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^>]*?)?)(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g;
  let m;
  while ((m = re.exec(text))) {
    if (!m[2]) continue; // comment / declaration
    const name = m[2].replace(/^.*:/, '');
    if (m[1]) {
      // closing tag: pop to the matching element
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === name) { stack.length = i; break; }
      }
      continue;
    }
    const node = { name, attrs: attrs(m[3] || ''), children: [] };
    stack[stack.length - 1].children.push(node);
    if (!m[4] && !/\/\s*$/.test(m[3] || '')) stack.push(node);
  }
  return root;
}

const kids = (node, name) => (node ? node.children.filter((c) => c.name === name) : []);
const kid = (node, name) => kids(node, name)[0] || null;

/** Fills $RepresentationID$, $Number$ / $Number%05d$, $Time$, $Bandwidth$ in a template. */
function fillTemplate(tpl, { id, number, time, bandwidth }) {
  return String(tpl || '').replace(/\$(RepresentationID|Number|Time|Bandwidth)(?:%0(\d+)d)?\$|\$\$/g, (all, key, width) => {
    if (all === '$$') return '$';
    let v;
    if (key === 'RepresentationID') v = String(id);
    else if (key === 'Number') v = String(number);
    else if (key === 'Time') v = String(time);
    else v = String(bandwidth || 0);
    return width ? v.padStart(Number(width), '0') : v;
  });
}

/**
 * Reads an MPD. Returns { duration, tracks: [{ kind, mime, codecs, timescale, init, segments: [{ file, t, d }] }] }
 * with t/d in timescale units. Only the first representation of each audio/video set is used.
 */
function parseMpd(text) {
  const tree = parseXml(String(text || ''));
  const mpd = kid(tree, 'MPD');
  if (!mpd) return null;
  const total = isoDuration(mpd.attrs.mediaPresentationDuration);
  const period = kid(mpd, 'Period');
  if (!period) return null;
  const periodDuration = isoDuration(period.attrs.duration) || total;
  const tracks = [];
  for (const set of kids(period, 'AdaptationSet')) {
    const rep = kid(set, 'Representation');
    if (!rep) continue;
    const mime = rep.attrs.mimeType || set.attrs.mimeType || '';
    const codecs = rep.attrs.codecs || set.attrs.codecs || '';
    const contentType = (set.attrs.contentType || rep.attrs.contentType || mime.split('/')[0] || '').toLowerCase();
    if (contentType !== 'video' && contentType !== 'audio') continue;
    // SegmentTemplate may sit on the Representation or (inherited) on the AdaptationSet.
    const tplRep = kid(rep, 'SegmentTemplate');
    const tplSet = kid(set, 'SegmentTemplate');
    const a = { ...(tplSet ? tplSet.attrs : {}), ...(tplRep ? tplRep.attrs : {}) };
    const timelineNode = kid(tplRep, 'SegmentTimeline') || kid(tplSet, 'SegmentTimeline');
    if (!a.media) continue;
    const timescale = Number(a.timescale) > 0 ? Number(a.timescale) : 1;
    const startNumber = Number.isFinite(Number(a.startNumber)) && a.startNumber !== undefined ? Number(a.startNumber) : 1;
    const ctx = { id: rep.attrs.id !== undefined ? rep.attrs.id : '', bandwidth: rep.attrs.bandwidth };
    const segments = [];
    if (timelineNode) {
      let time = 0;
      let number = startNumber;
      const entries = kids(timelineNode, 'S');
      entries.forEach((s, idx) => {
        if (s.attrs.t !== undefined && Number.isFinite(Number(s.attrs.t))) time = Number(s.attrs.t);
        const d = Number(s.attrs.d);
        if (!(d > 0)) return;
        let r = Number(s.attrs.r || 0);
        if (r < 0) {
          // repeat until the next S (or the end of the period)
          const next = entries[idx + 1];
          const until = next && next.attrs.t !== undefined ? Number(next.attrs.t) : (periodDuration > 0 ? periodDuration * timescale : time + d);
          r = Math.max(0, Math.ceil((until - time) / d) - 1);
        }
        for (let k = 0; k <= r && segments.length < 100000; k++) {
          segments.push({ file: fillTemplate(a.media, { ...ctx, number, time }), t: time, d });
          time += d;
          number++;
        }
      });
    } else if (Number(a.duration) > 0 && periodDuration > 0) {
      const d = Number(a.duration);
      const count = Math.ceil((periodDuration * timescale) / d);
      for (let k = 0; k < count && k < 100000; k++) {
        const time = k * d;
        segments.push({ file: fillTemplate(a.media, { ...ctx, number: startNumber + k, time }), t: time, d });
      }
    }
    if (!segments.length) continue;
    // Fixed-length pieces: the last one is usually shorter (Steam: 3 s pieces, 9.6 s clip).
    // The playlist's total length says where the clip really ends.
    if (!timelineNode && periodDuration > 0) {
      const end = periodDuration * timescale;
      const last = segments[segments.length - 1];
      if (last.t + last.d > end && end > last.t) last.d = end - last.t;
    }
    tracks.push({
      kind: contentType,
      mime: mime || `${contentType}/mp4`,
      codecs,
      timescale,
      init: a.initialization ? fillTemplate(a.initialization, { ...ctx, number: startNumber, time: segments[0].t }) : '',
      segments,
    });
  }
  return { duration: total, tracks };
}

// ---------------------------------------------------------------- fragmented MP4 (start time check)

function readBoxes(buf, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = Number(buf.readBigUInt64BE(p + 8));
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header) break;
    out.push({ type, data: p + header, end: Math.min(end, p + size) });
    p += size;
  }
  return out;
}

function findBox(buf, types, start = 0, end = buf.length) {
  let range = { data: start, end };
  for (const type of types) {
    const hit = readBoxes(buf, range.data, range.end).find((b) => b.type === type);
    if (!hit) return null;
    range = hit;
  }
  return range;
}

/** Track timescale from an init segment (moov › trak › mdia › mdhd). */
function initTimescale(buf) {
  const b = findBox(buf, ['moov', 'trak', 'mdia', 'mdhd']);
  if (!b || b.end - b.data < 24) return 0;
  const version = buf.readUInt8(b.data);
  const off = b.data + 4 + (version === 1 ? 16 : 8);
  return off + 4 <= b.end ? buf.readUInt32BE(off) : 0;
}

/** Decode time of the first sample in a media segment (moof › traf › tfdt), in track units. */
function firstDecodeTime(buf) {
  const b = findBox(buf, ['moof', 'traf', 'tfdt']);
  if (!b || b.end - b.data < 8) return null;
  const version = buf.readUInt8(b.data);
  if (version === 1) return b.end - b.data >= 12 ? Number(buf.readBigUInt64BE(b.data + 4)) : null;
  return buf.readUInt32BE(b.data + 4);
}

/** Default sample duration for a track from its init piece (moov › mvex › trex), or 0. */
function initDefaultDuration(buf) {
  const b = findBox(buf, ['moov', 'mvex', 'trex']);
  return b && b.end - b.data >= 16 ? buf.readUInt32BE(b.data + 12) : 0;
}

/** Total length of the samples in one moof (track units), or null if it can't be read. */
function moofDuration(buf, fallback) {
  let total = 0;
  let any = false;
  for (const traf of readBoxes(buf, 0, buf.length).filter((x) => x.type === 'traf')) {
    const inner = readBoxes(buf, traf.data, traf.end);
    let def = fallback;
    const tfhd = inner.find((x) => x.type === 'tfhd');
    if (tfhd && tfhd.end - tfhd.data >= 8) {
      const flags = buf.readUInt32BE(tfhd.data) & 0xffffff;
      let p = tfhd.data + 8;
      if (flags & 0x1) p += 8;
      if (flags & 0x2) p += 4;
      if ((flags & 0x8) && p + 4 <= tfhd.end) def = buf.readUInt32BE(p);
    }
    for (const trun of inner.filter((x) => x.type === 'trun')) {
      if (trun.end - trun.data < 8) return null;
      const flags = buf.readUInt32BE(trun.data) & 0xffffff;
      const count = buf.readUInt32BE(trun.data + 4);
      let p = trun.data + 8;
      if (flags & 0x1) p += 4;
      if (flags & 0x4) p += 4;
      const per = [0x100, 0x200, 0x400, 0x800].filter((f) => flags & f).length * 4;
      if (flags & 0x100) {
        for (let i = 0; i < count; i++) {
          if (p + 4 > trun.end) return null;
          total += buf.readUInt32BE(p);
          p += per;
        }
      } else {
        if (!def) return null;
        total += def * count;
      }
      any = true;
    }
  }
  return any ? total : null;
}

/**
 * Real length of a media piece in seconds, from its own sample tables (the playlist's numbers can
 * be rounded up, e.g. for the last piece of a clip). Walks the file's boxes without reading the
 * video data. Returns null if it can't be read.
 */
async function pieceLength(file, timescale, fallbackDuration) {
  if (!(timescale > 0)) return null;
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const { size } = await fh.stat();
    const head = Buffer.alloc(16);
    let pos = 0;
    let total = 0;
    let found = false;
    for (let guard = 0; pos + 8 <= size && guard < 10000; guard++) {
      const { bytesRead } = await fh.read(head, 0, 16, pos);
      if (bytesRead < 8) break;
      let len = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      let hdr = 8;
      if (len === 1) { len = Number(head.readBigUInt64BE(8)); hdr = 16; } else if (len === 0) len = size - pos;
      if (len < hdr) break;
      if (type === 'moof' && len < 16 * 1024 * 1024) {
        const body = Buffer.alloc(len - hdr);
        await fh.read(body, 0, body.length, pos + hdr);
        const d = moofDuration(body, fallbackDuration);
        if (d === null) return null;
        total += d;
        found = true;
      }
      pos += len;
    }
    return found ? total / timescale : null;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/**
 * Full codec name from an init segment's sample description (avcC / hvcC / av1C), for when the
 * playlist only says "hvc1" or "avc1": the window's video player needs the complete name.
 */
function codecFromInit(buf) {
  const stsd = findBox(buf, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']);
  if (!stsd || stsd.end - stsd.data < 16) return '';
  // stsd: version/flags (4) + entry count (4), then sample entries.
  const entries = readBoxes(buf, stsd.data + 8, stsd.end);
  const entry = entries[0];
  if (!entry) return '';
  const fourcc = entry.type;
  if (!/^(avc1|avc3|hvc1|hev1|av01)$/.test(fourcc)) return '';
  // Visual sample entry: 78 bytes of fixed fields before its child boxes.
  const children = readBoxes(buf, entry.data + 78, entry.end);
  const hex2 = (n) => n.toString(16).padStart(2, '0');
  if (fourcc.startsWith('avc')) {
    const c = children.find((b) => b.type === 'avcC');
    if (!c || c.end - c.data < 4) return '';
    return `${fourcc}.${hex2(buf[c.data + 1])}${hex2(buf[c.data + 2])}${hex2(buf[c.data + 3])}`;
  }
  if (fourcc === 'av01') {
    const c = children.find((b) => b.type === 'av1C');
    if (!c || c.end - c.data < 3) return '';
    const profile = buf[c.data + 1] >> 5;
    const level = buf[c.data + 1] & 0x1f;
    const tier = (buf[c.data + 2] >> 7) & 1;
    const high = (buf[c.data + 2] >> 6) & 1;
    const twelve = (buf[c.data + 2] >> 5) & 1;
    const depth = high ? (twelve ? 12 : 10) : 8;
    return `av01.${profile}.${String(level).padStart(2, '0')}${tier ? 'H' : 'M'}.${String(depth).padStart(2, '0')}`;
  }
  const c = children.find((b) => b.type === 'hvcC');
  if (!c || c.end - c.data < 13) return '';
  const b1 = buf[c.data + 1];
  const space = ['', 'A', 'B', 'C'][b1 >> 6];
  const tier = (b1 >> 5) & 1 ? 'H' : 'L';
  const profile = b1 & 0x1f;
  // Compatibility flags are written bit-reversed.
  let compat = buf.readUInt32BE(c.data + 2);
  let rev = 0;
  for (let i = 0; i < 32; i++) { rev = (rev << 1) | (compat & 1); compat >>>= 1; }
  const constraints = [];
  for (let i = 0; i < 6; i++) constraints.push(buf[c.data + 6 + i]);
  while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
  const level = buf[c.data + 12];
  const parts = [fourcc, `${space}${profile}`, (rev >>> 0).toString(16), `${tier}${level}`];
  if (constraints.length) parts.push(constraints.map((x) => x.toString(16)).join('.'));
  return parts.join('.');
}

async function readHead(file, bytes) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

// ---------------------------------------------------------------- clips

/** Folders with a session.mpd inside a clip (in recording order). */
async function sessionDirs(clipDir) {
  const out = [];
  const visit = async (dir, depth) => {
    const entries = await listDir(dir);
    if (entries.some((e) => e.isFile() && e.name.toLowerCase() === 'session.mpd')) out.push(dir);
    if (depth <= 0) return;
    const sub = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort((x, y) => x.localeCompare(y, 'en', { numeric: true }));
    for (const name of sub) await visit(path.join(dir, name), depth - 1);
  };
  await visit(clipDir, 3);
  return out;
}

/** Clips of one game, newest first: [{ dir, time, sessions, thumb, duration }]. */
async function listClips({ steamPath, accountId, appId }) {
  if (!appId) return [];
  const result = [];
  for (const root of await recordingsDirs(steamPath, accountId)) {
    const clipsDir = path.join(root, 'clips');
    for (const e of await listDir(clipsDir)) {
      if (!e.isDirectory()) continue;
      const m = CLIP_DIR_RE.exec(e.name);
      if (!m || m[1] !== String(appId)) continue;
      const dir = path.join(clipsDir, e.name);
      const sessions = await sessionDirs(dir);
      if (!sessions.length) continue;
      let duration = 0;
      for (const s of sessions) {
        const mpd = parseMpd(await readText(path.join(s, 'session.mpd')));
        duration += mpd ? await sessionDuration(s, mpd) : 0;
      }
      const files = await listDir(dir);
      const thumb = files.find((f) => f.isFile() && IMAGE_RE.test(f.name));
      result.push({
        dir,
        name: e.name,
        time: clipTime(m[2], m[3]),
        sessions,
        thumb: thumb ? path.join(dir, thumb.name) : null,
        duration: Math.round(duration * 10) / 10,
      });
      if (result.length >= MAX_CLIPS) break;
    }
  }
  result.sort((a, b) => b.time - a.time);
  return result;
}

/** Length of a session as shown: the video track, with its last piece measured from the file. */
async function sessionDuration(dir, mpd) {
  const v = mpd.tracks.find((tr) => tr.kind === 'video');
  if (!v) return sessionLength(mpd) || mpd.duration;
  const first = v.segments[0];
  const last = v.segments[v.segments.length - 1];
  let lastD = last.d / v.timescale;
  const initBuf = v.init ? await readHead(path.join(dir, v.init), 64 * 1024) : null;
  const ts = initBuf ? initTimescale(initBuf) : 0;
  if (ts > 0) {
    const real = await pieceLength(path.join(dir, last.file), ts, initDefaultDuration(initBuf));
    if (real !== null && real > 0 && real <= lastD + 1) lastD = real;
  }
  return (last.t - first.t) / v.timescale + lastD;
}

/** Length of a session in seconds from its segments (the longest track). */
function sessionLength(mpd) {
  let best = 0;
  for (const tr of mpd.tracks) {
    const first = tr.segments[0];
    const last = tr.segments[tr.segments.length - 1];
    best = Math.max(best, (last.t + last.d - first.t) / tr.timescale);
  }
  return best;
}

/**
 * Everything needed to play a clip: per session the tracks with their pieces, times in seconds.
 * Only pieces that exist on disk are listed. `url(sessionIndex, fileName)` makes the address.
 * { duration, sessions: [{ duration, tracks: [{ kind, type, init, segments: [{ url, t, d }] }] }] }
 */
async function clipManifest(clip, url) {
  const sessions = [];
  for (let i = 0; i < clip.sessions.length; i++) {
    const dir = clip.sessions[i];
    const mpd = parseMpd(await readText(path.join(dir, 'session.mpd')));
    if (!mpd) continue;
    const present = new Set((await listDir(dir)).filter((e) => e.isFile()).map((e) => e.name));
    const tracks = [];
    for (const tr of mpd.tracks) {
      if (!tr.init || !present.has(tr.init)) continue;
      const segs = tr.segments.filter((s) => present.has(s.file));
      if (!segs.length) continue;
      // The playlist's times should match the pieces; if they don't (e.g. missing "t"), trust the
      // pieces themselves: the first one's decode time tells where the track starts.
      let shift = 0;
      const initBuf = await readHead(path.join(dir, tr.init), 64 * 1024);
      const firstBuf = await readHead(path.join(dir, segs[0].file), 256 * 1024);
      const ts = initBuf ? initTimescale(initBuf) : 0;
      const dts = firstBuf ? firstDecodeTime(firstBuf) : null;
      if (ts > 0 && dts !== null) {
        const real = dts / ts;
        const listed = segs[0].t / tr.timescale;
        if (Math.abs(real - listed) > 1.5) shift = real - listed;
      }
      // The last piece's real length: the playlist can claim more than was recorded, which made
      // the clip look a few seconds longer than it is.
      const segments = segs.map((s) => ({ url: url(i, s.file), t: s.t / tr.timescale + shift, d: s.d / tr.timescale }));
      if (ts > 0 && initBuf) {
        const real = await pieceLength(path.join(dir, segs[segs.length - 1].file), ts, initDefaultDuration(initBuf));
        if (real !== null && real > 0 && real <= segments[segments.length - 1].d + 1) segments[segments.length - 1].d = real;
      }
      // "hvc1" alone (no profile/level) is not enough for the player: read it from the init piece.
      let codecs = tr.codecs;
      if (tr.kind === 'video' && (!codecs || !codecs.includes('.')) && initBuf) codecs = codecFromInit(initBuf) || codecs;
      tracks.push({
        kind: tr.kind,
        type: `${tr.mime}${codecs ? `; codecs="${codecs}"` : ''}`,
        codecs,
        init: url(i, tr.init),
        segments,
      });
    }
    if (!tracks.length) continue;
    const length = Math.max(...tracks.map((tr) => {
      const first = tr.segments[0];
      const last = tr.segments[tr.segments.length - 1];
      return last.t + last.d - first.t;
    }));
    sessions.push({ duration: length, tracks });
  }
  return { duration: sessions.reduce((n, s) => n + s.duration, 0), sessions };
}

module.exports = {
  listClips, clipManifest, recordingsDirs, sessionDirs, parseMpd, parseXml, fillTemplate, isoDuration, clipTime,
  initTimescale, firstDecodeTime, codecFromInit, pieceLength, CLIP_DIR_RE,
};
