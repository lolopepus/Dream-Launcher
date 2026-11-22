'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRegistryReader } = require('../src/main/util/registry');

function tmpDir(prefix = 'dl-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function makeCtx({ registry = {}, env = {}, appx = [], settings = {} } = {}) {
  const { sanitizeSettings } = require('../src/main/defaults');
  return { reg: createRegistryReader(registry), env, appx, settings: sanitizeSettings(settings) };
}

/** Escapes a path for embedding inside a VDF quoted string. */
function vdfPath(p) {
  return p.replace(/\\/g, '\\\\');
}

module.exports = { tmpDir, write, makeCtx, vdfPath };
