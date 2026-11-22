'use strict';
/**
 * Parser for Valve's text KeyValues format (VDF / ACF files), used by Steam for
 * libraryfolders.vdf, appmanifest_*.acf, loginusers.vdf and localconfig.vdf.
 *
 * - Quoted and unquoted tokens
 * - Escape sequences inside quoted strings (\\ \" \n \t)
 * - // line comments
 * - Conditional tags like [$WIN32] after a value (ignored)
 */

function isWs(code) {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 0xfeff;
}

function parseVdf(text) {
  if (typeof text !== 'string') throw new TypeError('VDF input must be a string');
  const n = text.length;
  let i = 0;

  function skipWsAndComments() {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (isWs(c)) { i++; continue; }
      if (c === 47 /* / */ && text.charCodeAt(i + 1) === 47) {
        const nl = text.indexOf('\n', i);
        i = nl === -1 ? n : nl + 1;
        continue;
      }
      break;
    }
  }

  function readToken() {
    skipWsAndComments();
    if (i >= n) return null;
    const c = text[i];
    if (c === '{' || c === '}') { i++; return { type: c }; }
    if (c === '"') {
      i++;
      let out = '';
      let start = i;
      while (i < n) {
        const ch = text.charCodeAt(i);
        if (ch === 92 /* \ */) {
          out += text.slice(start, i);
          const nx = text[i + 1];
          if (nx === 'n') out += '\n';
          else if (nx === 't') out += '\t';
          else if (nx === '\\') out += '\\';
          else if (nx === '"') out += '"';
          else if (nx === undefined) { i++; start = i; break; }
          else out += '\\' + nx;
          i += 2;
          start = i;
          continue;
        }
        if (ch === 34 /* " */) {
          out += text.slice(start, i);
          i++;
          return { type: 'str', value: out, quoted: true };
        }
        i++;
      }
      // Unterminated string: return what we have.
      out += text.slice(start, i);
      return { type: 'str', value: out, quoted: true };
    }
    const start = i;
    while (i < n) {
      const ch = text.charCodeAt(i);
      if (isWs(ch) || ch === 123 || ch === 125 || ch === 34) break;
      i++;
    }
    return { type: 'str', value: text.slice(start, i), quoted: false };
  }

  function skipConditional() {
    const save = i;
    const tok = readToken();
    if (tok && tok.type === 'str' && !tok.quoted && /^\[.*\]$/.test(tok.value)) return;
    i = save;
  }

  function parseObject(isRoot) {
    const obj = {};
    for (;;) {
      const keyTok = readToken();
      if (keyTok === null) {
        if (isRoot) return obj;
        return obj; // tolerate missing closing brace
      }
      if (keyTok.type === '}') {
        if (isRoot) continue; // stray brace at root: ignore
        return obj;
      }
      if (keyTok.type === '{') {
        // Anonymous block (malformed); parse and discard.
        parseObject(false);
        continue;
      }
      const key = keyTok.value;
      const valTok = readToken();
      if (valTok === null) { obj[key] = ''; return obj; }
      if (valTok.type === '{') {
        const child = parseObject(false);
        skipConditional();
        const existing = obj[key];
        if (existing && typeof existing === 'object') Object.assign(existing, child);
        else obj[key] = child;
      } else if (valTok.type === '}') {
        obj[key] = '';
        if (isRoot) continue;
        return obj;
      } else {
        skipConditional();
        obj[key] = valTok.value;
      }
    }
  }

  return parseObject(true);
}

/** Case-insensitive lookup of a nested key path. Returns undefined if missing. */
function vdfGet(obj, ...keys) {
  let cur = obj;
  for (const key of keys) {
    if (!cur || typeof cur !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(cur, key)) { cur = cur[key]; continue; }
    const lower = String(key).toLowerCase();
    const found = Object.keys(cur).find((k) => k.toLowerCase() === lower);
    if (found === undefined) return undefined;
    cur = cur[found];
  }
  return cur;
}

function toInt(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = { parseVdf, vdfGet, toInt };
