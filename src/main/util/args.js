'use strict';

/**
 * Splits a command-line argument template into an array, honouring double quotes.
 * Example: '-b -e "{rom}"' -> ['-b', '-e', '{rom}'].
 * Backslashes are kept literally (Windows paths), only "" pairs are treated as quotes.
 */
function splitArgs(input) {
  const out = [];
  if (!input) return out;
  const s = String(input);
  let cur = '';
  let inQuotes = false;
  let hasToken = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      hasToken = true;
      continue;
    }
    if (!inQuotes && (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r')) {
      if (hasToken) { out.push(cur); cur = ''; hasToken = false; }
      continue;
    }
    cur += ch;
    hasToken = true;
  }
  if (hasToken) out.push(cur);
  return out;
}

/** Replaces {placeholders} in each argument. Unknown placeholders are left as-is. */
function fillArgs(args, values) {
  return args.map((a) => a.replace(/\{(\w+)\}/g, (m, key) => (Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : m)));
}

module.exports = { splitArgs, fillArgs };
