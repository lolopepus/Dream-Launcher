'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVdf, vdfGet, toInt } = require('../src/main/util/vdf');
const { splitArgs, fillArgs } = require('../src/main/util/args');
const { createRegistryReader } = require('../src/main/util/registry');
const { buildProbeScript, extractJson, encodeCommand } = require('../src/main/util/powershell');
const { sanitizeSettings, sanitizeOverrides, DEFAULT_SETTINGS } = require('../src/main/defaults');
const { libraryPathsFromVdf, statusFromFlags } = require('../src/main/sources/steam');

test('vdf: libraryfolders (new format) with escaped Windows paths', () => {
  const text = `"libraryfolders"
{
\t"0"
\t{
\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"
\t\t"label"\t\t""
\t\t"apps"
\t\t{
\t\t\t"228980"\t\t"123"
\t\t\t"570"\t\t"456"
\t\t}
\t}
\t"1"
\t{
\t\t"path"\t\t"D:\\\\SteamLibrary"
\t}
}`;
  const data = parseVdf(text);
  assert.deepEqual(libraryPathsFromVdf(data), ['C:\\Program Files (x86)\\Steam', 'D:\\SteamLibrary']);
  assert.equal(vdfGet(data, 'LIBRARYFOLDERS', '0', 'apps', '570'), '456');
});

test('vdf: old libraryfolders format, comments, conditionals, unquoted tokens', () => {
  const text = `// comment
"LibraryFolders"
{
  "TimeNextStatsReport" "1"
  "1" "E:\\\\Games\\\\Steam" [$WIN32]
  unquoted value
  "nested" { "a" "b" } // trailing comment
}`;
  const data = parseVdf(text);
  assert.deepEqual(libraryPathsFromVdf(data), ['E:\\Games\\Steam']);
  assert.equal(vdfGet(data, 'LibraryFolders', 'unquoted'), 'value');
  assert.equal(vdfGet(data, 'LibraryFolders', 'nested', 'a'), 'b');
});

test('vdf: escapes and BOM', () => {
  const data = parseVdf('\ufeff"a" { "q" "say \\"hi\\"\\n" "tab" "x\\ty" }');
  assert.equal(vdfGet(data, 'a', 'q'), 'say "hi"\n');
  assert.equal(vdfGet(data, 'a', 'tab'), 'x\ty');
  assert.equal(toInt('42'), 42);
  assert.equal(toInt('x', 7), 7);
});

test('vdf: malformed input does not throw', () => {
  assert.doesNotThrow(() => parseVdf('"a" { "b" "c"'));
  assert.doesNotThrow(() => parseVdf('}}} "x"'));
  assert.doesNotThrow(() => parseVdf('"unterminated'));
});

test('steam state flags', () => {
  assert.equal(statusFromFlags(4), 'installed');
  assert.equal(statusFromFlags(6), 'updateRequired');
  assert.equal(statusFromFlags(1026), 'installing');
  assert.equal(statusFromFlags(1030), 'updating');
  assert.equal(statusFromFlags(4 | 1048576), 'updating');
  assert.equal(statusFromFlags(514), 'installing');
});

test('args: split and fill', () => {
  assert.deepEqual(splitArgs('-b -e "{rom}"'), ['-b', '-e', '{rom}']);
  assert.deepEqual(splitArgs('-f -L "cores\\snes9x_libretro.dll" "{rom}"'), ['-f', '-L', 'cores\\snes9x_libretro.dll', '{rom}']);
  assert.deepEqual(splitArgs('  '), []);
  assert.deepEqual(splitArgs('""'), ['']);
  assert.deepEqual(fillArgs(['-e', '{rom}', '{x}'], { rom: 'C:\\A B\\c.iso' }), ['-e', 'C:\\A B\\c.iso', '{x}']);
});

test('registry reader: direct, nested and case-insensitive lookups', () => {
  const reg = createRegistryReader({
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher': {
      InstallDir: 'C:/Ubi/',
      __subkeys: { Installs: { __subkeys: { 4: { InstallDir: 'C:/Games/AC/' } } } },
    },
    'HKEY_CURRENT_USER\\Software\\Valve\\Steam': { SteamPath: 'c:/program files (x86)/steam' },
  });
  assert.equal(reg.value('HKCU\\Software\\Valve\\Steam', 'steampath'), 'c:/program files (x86)/steam');
  assert.equal(reg.value('HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher', 'InstallDir'), 'C:/Ubi/');
  const subs = reg.subkeys('HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs');
  assert.equal(subs.length, 1);
  assert.equal(subs[0].name, '4');
  assert.equal(reg.get(subs[0].data, 'installdir'), 'C:/Games/AC/');
  assert.equal(reg.key('HKLM\\SOFTWARE\\Nope'), null);
  assert.deepEqual(reg.subkeys('HKLM\\SOFTWARE\\Nope'), []);
});

test('powershell: probe script structure and JSON extraction', () => {
  const s = buildProbeScript({ registry: [["HKEY_LOCAL_MACHINE\\SOFTWARE\\O'Brien", 1, 'Uplay Install']], appx: true, battery: true });
  assert.match(s, /\[void\]\$dlPaths\.Add\(@\('HKEY_LOCAL_MACHINE\\SOFTWARE\\O''Brien', 1, 'Uplay Install'\)\)/);
  assert.match(s, /Get-AppxPackage/);
  assert.match(s, /Win32_Battery/);
  assert.match(s, /\$prefix -ne ''/);
  // Backslash in the recursive call must reach PowerShell as a single '\'.
  assert.ok(s.includes("($path + '\\' + $s)"));
  assert.ok(s.includes('-join "`n"'));
  const none = buildProbeScript({ registry: [], appx: false, battery: false });
  assert.doesNotMatch(none, /Get-AppxPackage/);
  assert.deepEqual(extractJson('noise <<<DLJSON{"a":1}DLJSON>>> more'), { a: 1 });
  assert.equal(extractJson('nothing'), null);
  assert.equal(Buffer.from(encodeCommand('hi'), 'base64').toString('utf16le'), 'hi');
});

test('settings: sanitize fills defaults, rejects bad types and values', () => {
  const s = sanitizeSettings({ language: 'xx', soundVolume: 250, showClock: 'yes', sources: { steam: false }, steamApiKey: ' AB-cd12 ', steamId: '7656x1197', emulators: [{ id: 'a b', exe: 'x.exe', extensions: '.ISO, chd;*.cue' }, { nope: 1 }], unknown: 5 });
  assert.equal(s.language, 'auto');
  assert.equal(s.soundVolume, 100);
  assert.equal(s.showClock, true);
  assert.equal(s.sources.steam, false);
  assert.equal(s.sources.epic, true);
  assert.equal(s.steamApiKey, 'ABcd12');
  assert.equal(s.steamId, '76561197');
  assert.equal(s.emulators.length, 1);
  assert.equal(s.emulators[0].id, 'ab');
  assert.deepEqual(s.emulators[0].extensions, ['iso', 'chd', 'cue']);
  assert.equal('unknown' in s, false);
  // Partial update keeps everything else.
  const next = sanitizeSettings({ showDate: true }, s);
  assert.equal(next.showDate, true);
  assert.equal(next.sources.steam, false);
  assert.equal(next.emulators.length, 1);
  assert.deepEqual(Object.keys(sanitizeSettings(null)).sort(), Object.keys(DEFAULT_SETTINGS).sort());
});

test('overrides: sanitize', () => {
  const o = sanitizeOverrides({ 'steam:1': { favorite: true, hidden: 'x', subscription: 'gamepass', customArt: { cover: '../evil.png', hero: 'ok-file.jpg' } }, 'x': { favorite: false } });
  assert.deepEqual(o, { 'steam:1': { favorite: true, subscription: 'gamepass', customArt: { hero: 'ok-file.jpg' } } });
});
