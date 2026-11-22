'use strict';
/** Update check through GitHub Releases (2.3). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const { tmpDir } = require('./helpers');
const { Updater, compareVersions, parseRelease, pickAsset } = require('../src/main/updater');

const REPO = 'lolopepus/Dream-Launcher';
const installer = Buffer.alloc(3 * 1024 * 1024, 7);
const sha = crypto.createHash('sha256').update(installer).digest('hex');
const DL_URL = `https://github.com/${REPO}/releases/download/v2.3.0/Dream.Launcher.Setup.2.3.0.exe`;

const release = (over = {}) => ({
  tag_name: 'v2.3.0', name: 'Update', body: 'Notes', html_url: `https://github.com/${REPO}/releases/tag/v2.3.0`,
  draft: false, prerelease: false, published_at: '2026-11-22T12:00:00Z',
  assets: [
    { name: 'Dream.Launcher.Setup.2.3.0.exe', size: installer.length, browser_download_url: DL_URL, digest: `sha256:${sha}` },
    { name: 'latest.yml', size: 300, browser_download_url: `https://github.com/${REPO}/releases/download/v2.3.0/latest.yml` },
  ],
  ...over,
});

function fakeGitHub({ rel = release(), file = installer } = {}) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (url.endsWith('/releases/latest')) {
      if (rel === 404) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(rel), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === DL_URL) return new Response(file, { status: 200 });
    return new Response('nope', { status: 404 });
  };
  return { fetch, calls };
}

function makeStore() {
  return { update: {}, save() {} };
}

test('updater: version comparison and release parsing', () => {
  assert.ok(compareVersions('2.3.0', '2.2.2') > 0);
  assert.ok(compareVersions('v2.10.0', '2.9.9') > 0);
  assert.equal(compareVersions('v2.2.2', '2.2.2'), 0);
  assert.ok(compareVersions('2.2.1', '2.2.2') < 0);
  const r = parseRelease(release(), REPO);
  assert.equal(r.version, '2.3.0');
  assert.equal(r.asset.name, 'Dream.Launcher.Setup.2.3.0.exe');
  assert.equal(r.asset.sha256, sha);
  assert.equal(parseRelease(release({ draft: true }), REPO), null);
  assert.equal(parseRelease(release({ prerelease: true }), REPO), null);
  // Only installers from this repository's own release downloads are accepted.
  assert.equal(pickAsset({ assets: [{ name: 'Setup.exe', size: 5e6, browser_download_url: 'https://evil.example/Setup.exe' }] }, REPO), null);
});

test('updater: finds a newer release, downloads and verifies the installer', async () => {
  const gh = fakeGitHub();
  const store = makeStore();
  const up = new Updater({ repo: REPO, currentVersion: '2.2.2', fetch: gh.fetch, store, tempDir: tmpDir(), log: {} });
  const seen = [];
  up.on('change', (s) => seen.push(s.status));
  const s = await up.check();
  assert.equal(s.status, 'available');
  assert.equal(s.latest.version, '2.3.0');
  assert.equal(up.shouldAnnounce(), true);
  up.markAnnounced();
  assert.equal(up.shouldAnnounce(), false, 'announced once per version');
  // Within 6 hours: no new request.
  await up.check();
  assert.equal(gh.calls.length, 1);
  const res = await up.download();
  assert.deepEqual(res, { ok: true, verified: true });
  const file = up.readyFile();
  assert.ok(file && fs.readFileSync(file).equals(installer));
  assert.ok(seen.includes('downloading') && seen.at(-1) === 'ready');
});

test('updater: wrong checksum is rejected and the file removed', async () => {
  const bad = Buffer.alloc(installer.length, 9);
  const gh = fakeGitHub({ file: bad });
  const up = new Updater({ repo: REPO, currentVersion: '2.2.2', fetch: gh.fetch, store: makeStore(), tempDir: tmpDir(), log: {} });
  await up.check({ force: true });
  const res = await up.download();
  assert.equal(res.error, 'checksum');
  assert.equal(up.readyFile(), null);
  assert.equal(up.snapshot().status, 'available');
});

test('updater: up to date, no release yet, offline', async () => {
  const same = new Updater({ repo: REPO, currentVersion: '2.3.0', fetch: fakeGitHub().fetch, store: makeStore(), tempDir: tmpDir(), log: {} });
  assert.equal((await same.check({ force: true })).status, 'upToDate');
  const none = new Updater({ repo: REPO, currentVersion: '2.2.2', fetch: fakeGitHub({ rel: 404 }).fetch, store: makeStore(), tempDir: tmpDir(), log: {} });
  assert.equal((await none.check({ force: true })).status, 'upToDate');
  const offline = new Updater({ repo: REPO, currentVersion: '2.2.2', fetch: async () => { throw Object.assign(new Error('offline'), { offline: true }); }, store: makeStore(), tempDir: tmpDir(), log: {} });
  const s = await offline.check({ force: true });
  assert.equal(s.error, 'offline');
  // After updating, a remembered "newer" version that is now installed is forgotten.
  const store = { update: { latest: { version: '2.3.0' }, checkedAt: Date.now() }, save() {} };
  const after = new Updater({ repo: REPO, currentVersion: '2.3.0', fetch: fakeGitHub().fetch, store, tempDir: tmpDir(), log: {} });
  assert.equal(after.snapshot().latest, null);
});
