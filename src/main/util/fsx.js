'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

async function exists(p) {
  if (!p) return false;
  try { await fsp.access(p); return true; } catch { return false; }
}

async function isDir(p) {
  if (!p) return false;
  try { return (await fsp.stat(p)).isDirectory(); } catch { return false; }
}

async function isFile(p) {
  if (!p) return false;
  try { return (await fsp.stat(p)).isFile(); } catch { return false; }
}

async function readText(p) {
  try {
    let t = await fsp.readFile(p, 'utf8');
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    return t;
  } catch { return null; }
}

async function readJson(p) {
  const t = await readText(p);
  if (t === null) return null;
  try { return JSON.parse(t); } catch { return null; }
}

async function listDir(p) {
  try { return await fsp.readdir(p, { withFileTypes: true }); } catch { return []; }
}

let tmpCounter = 0;
async function writeFileAtomic(p, data) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.${tmpCounter++}.tmp`;
  await fsp.writeFile(tmp, data);
  try {
    await fsp.rename(tmp, p);
  } catch {
    // On Windows, rename can fail if the target is briefly locked (antivirus, indexer).
    // Fall back to writing the file directly; if that fails too, the error propagates.
    try { await fsp.writeFile(p, data); } finally { await fsp.unlink(tmp).catch(() => {}); }
  }
}

async function writeJsonAtomic(p, value) {
  await writeFileAtomic(p, JSON.stringify(value, null, 2));
}

/** Normalizes a Windows-ish path for comparisons (case-insensitive, unified separators, no trailing slash). */
function normKey(p) {
  if (!p) return '';
  let s = String(p).replace(/\//g, '\\').replace(/\\+$/g, '');
  return s.toLowerCase();
}

module.exports = { exists, isDir, isFile, readText, readJson, listDir, writeFileAtomic, writeJsonAtomic, normKey };
