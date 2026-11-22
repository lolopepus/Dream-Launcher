'use strict';
/** Every language must have exactly the same texts and placeholders as English. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = path.join(__dirname, '..', 'src', 'renderer', 'js', 'locales');

function loadLocales() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.js'))) {
    vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sandbox, { filename: f });
  }
  return sandbox.window.DL_LOCALES;
}

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !('other' in v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

const placeholders = (v) => new Set(JSON.stringify(v).match(/\{\w+\}/g) || []);

test('all languages are complete and consistent', () => {
  const L = loadLocales();
  assert.deepEqual(Object.keys(L).sort(), ['de', 'en', 'pl']);
  const en = flatten(L.en);
  for (const [lang, table] of Object.entries(L)) {
    const t = flatten(table);
    assert.deepEqual(Object.keys(t).sort(), Object.keys(en).sort(), `${lang}: keys differ from English`);
    for (const [key, value] of Object.entries(t)) {
      if (value && typeof value === 'object') assert.equal(typeof value.other, 'string', `${lang}.${key}: plural needs "other"`);
      else assert.equal(typeof value, 'string', `${lang}.${key}: must be text`);
      assert.deepEqual([...placeholders(value)].sort(), [...placeholders(en[key])].sort(), `${lang}.${key}: placeholders differ`);
    }
  }
});
