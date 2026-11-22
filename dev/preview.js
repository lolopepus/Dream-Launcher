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
const MOCK = path.join(__dirname, 'mock-api.js');
const PORT = Number(process.env.PORT) || 5173;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff': 'font/woff', '.txt': 'text/plain', '.mp3': 'audio/mpeg',
};

http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
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
}).listen(PORT, () => console.log(`Dream Launcher preview: http://localhost:${PORT}`));
