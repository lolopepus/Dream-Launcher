'use strict';
/**
 * Read-only access to a registry dump produced by the PowerShell probe.
 * Dump format: { "<FULL KEY PATH>": { valueName: value, ..., __subkeys: { name: {...} } } }
 * Lookups are case-insensitive (like the real registry).
 */

function findKeyCI(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return key;
  const lower = key.toLowerCase();
  return Object.keys(obj).find((k) => k.toLowerCase() === lower);
}

function normalizeRegPath(p) {
  return String(p)
    .replace(/\//g, '\\')
    .replace(/^HKLM\\/i, 'HKEY_LOCAL_MACHINE\\')
    .replace(/^HKCU\\/i, 'HKEY_CURRENT_USER\\')
    .replace(/\\+$/g, '');
}

function createRegistryReader(dump) {
  const root = dump && typeof dump === 'object' ? dump : {};
  /** Returns the key node ({values..., __subkeys}) or null. */
  function key(p) {
    const full = normalizeRegPath(p);
    const direct = findKeyCI(root, full);
    if (direct !== undefined) return root[direct] || null;
    // Walk up to find a dumped ancestor, then descend through __subkeys.
    const parts = full.split('\\');
    for (let cut = parts.length - 1; cut > 0; cut--) {
      const ancestor = parts.slice(0, cut).join('\\');
      const ak = findKeyCI(root, ancestor);
      if (ak === undefined) continue;
      let node = root[ak];
      for (const part of parts.slice(cut)) {
        if (!node || !node.__subkeys) return null;
        const sk = findKeyCI(node.__subkeys, part);
        if (sk === undefined) return null;
        node = node.__subkeys[sk];
      }
      return node || null;
    }
    return null;
  }
  function value(p, name) {
    const node = key(p);
    if (!node) return undefined;
    const k = findKeyCI(node, name);
    return k === undefined || k === '__subkeys' ? undefined : node[k];
  }
  function subkeys(p) {
    const node = key(p);
    if (!node || !node.__subkeys || typeof node.__subkeys !== 'object') return [];
    return Object.entries(node.__subkeys).map(([name, data]) => ({ name, data: data || {} }));
  }
  function get(node, name) {
    if (!node) return undefined;
    const k = findKeyCI(node, name);
    return k === undefined || k === '__subkeys' ? undefined : node[k];
  }
  return { key, value, subkeys, get };
}

module.exports = { createRegistryReader, normalizeRegPath };
