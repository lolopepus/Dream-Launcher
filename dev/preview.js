/*
 * Browser preview of the interface with sample data (no Windows or Electron needed).
 *   node dev/preview.js      ->  http://localhost:5173
 * The real app does not use this file.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src', 'renderer');
// Optional: a Steam-like folder with game recordings, to try clips in the preview
// (DL_PREVIEW_STEAM=<folder with userdata\<account>\gamerecordings>, DL_PREVIEW_ACCOUNT=<account id>).
const CLIP_STEAM = process.env.DL_PREVIEW_STEAM || '';
const CLIP_ACCOUNT = process.env.DL_PREVIEW_ACCOUNT || '42';
const clipTokens = new Map();
const MOCK = path.join(__dirname, 'mock-api.js');
const PORT = Number(process.env.PORT) || 5173;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff': 'font/woff', '.txt': 'text/plain', '.mp3': 'audio/mpeg',
};

/** Clips for the preview, read with the app's own clip reader (src/main/clips.js). */
async function serveClips(req, res, p) {
  const { listClips, clipManifest } = require('../src/main/clips');
  const json = (v) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
  if (p === '/__clips/list') {
    const appId = new URL(req.url, 'http://x').searchParams.get('appid') || '';
    const list = CLIP_STEAM ? await listClips({ steamPath: CLIP_STEAM, accountId: CLIP_ACCOUNT, appId }) : [];
    return json(list.map((c, i) => {
      const token = `c${appId}-${i}`;
      clipTokens.set(token, c);
      return { id: token, kind: 'clip', time: c.time, duration: c.duration, thumb: c.thumb ? `/__clips/thumb/${token}` : null };
    }));
  }
  const parts = p.split('/').slice(2); // [kind, token, ...]
  const clip = clipTokens.get(parts[1]);
  if (!clip) { res.writeHead(404); res.end(); return; }
  if (parts[0] === 'manifest') return json(await clipManifest(clip, (i, f) => `/__clips/file/${parts[1]}/${i}/${encodeURIComponent(f)}`));
  let file = null;
  if (parts[0] === 'thumb') file = clip.thumb;
  if (parts[0] === 'file' && clip.sessions[Number(parts[2])] && /^[\w.-]+\.m4s$/.test(parts[3] || '')) file = path.join(clip.sessions[Number(parts[2])], parts[3]);
  if (!file) { res.writeHead(404); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': file.endsWith('.jpg') ? 'image/jpeg' : 'application/octet-stream', 'content-length': data.length });
    res.end(data);
  });
}

http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  if (p.startsWith('/__clips/')) { serveClips(req, res, p).catch(() => { res.writeHead(500); res.end(); }); return; }
  if (p === '/__mock.js') {
    res.writeHead(200, { 'content-type': TYPES['.js'] });
    fs.createReadStream(MOCK).pipe(res);
    return;
  }
  const file = path.resolve(ROOT, `.${p}`);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    if (p === '/index.html') {
      // Inject the fake API before the app scripts.
      data = Buffer.from(String(data).replace('<script src="js/locales/en.js"></script>', '<script src="/__mock.js"></script>\n  <script src="js/locales/en.js"></script>'));
    }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    // Byte ranges, like the real app's server (the audio player needs them to seek).
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      const size = data.length;
      const start = m[1] ? Number(m[1]) : size - Number(m[2]);
      const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size || start > end) { res.writeHead(416, { 'content-range': `bytes */${size}` }); res.end(); return; }
      res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
      res.end(data.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': data.length });
    res.end(data);
  });
})
  .listen(PORT, () => console.log(`Dream Launcher preview: http://localhost:${PORT}`));
