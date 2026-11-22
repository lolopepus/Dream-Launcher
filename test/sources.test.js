'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { tmpDir, write, makeCtx, vdfPath } = require('./helpers');
const { scanSteam } = require('../src/main/sources/steam');
const { scanEpic, launchUrl } = require('../src/main/sources/epic');
const { scanGog } = require('../src/main/sources/gog');
const { scanUbisoft } = require('../src/main/sources/ubisoft');
const { scanXbox, parseGameConfig } = require('../src/main/sources/xbox');
const { scanEmulators, cleanRomName } = require('../src/main/sources/emulators');
const { scanManual } = require('../src/main/sources/manual');

function acf(appid, name, flags, extra = '') {
  return `"AppState"
{
\t"appid"\t\t"${appid}"
\t"name"\t\t"${name}"
\t"StateFlags"\t\t"${flags}"
\t"installdir"\t\t"${name.replace(/[^A-Za-z0-9]/g, '')}"
\t"SizeOnDisk"\t\t"1073741824"
${extra}
}`;
}

test('steam: libraries, manifests, exclusions, user playtime', async () => {
  const root = tmpDir();
  const steam = path.join(root, 'Steam');
  const lib2 = path.join(root, 'Lib2');
  write(path.join(steam, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders"
{
  "0" { "path" "${vdfPath(steam)}" }
  "1" { "path" "${vdfPath(lib2)}" }
}`);
  write(path.join(steam, 'steamapps', 'appmanifest_570.acf'), acf(570, 'Dota 2', 4, '"LastPlayed" "1700000000"'));
  write(path.join(steam, 'steamapps', 'appmanifest_228980.acf'), acf(228980, 'Steamworks Common Redistributables', 4));
  write(path.join(lib2, 'steamapps', 'appmanifest_1145360.acf'), acf(1145360, 'Hades', 1026, '"BytesToDownload" "1000"\n"BytesDownloaded" "250"'));
  write(path.join(lib2, 'steamapps', 'appmanifest_620.acf'), acf(620, 'Portal 2', 6));
  write(path.join(lib2, 'steamapps', 'appmanifest_bad.acf'), 'garbage');
  write(path.join(steam, 'config', 'loginusers.vdf'), `"users"
{
  "76561197960287930" { "AccountName" "old" "PersonaName" "Old" "MostRecent" "0" "Timestamp" "1" }
  "76561198000000001" { "AccountName" "lolo" "PersonaName" "Lolo" "MostRecent" "1" "Timestamp" "2" }
}`);
  // accountId = 76561198000000001 - 76561197960265728 = 39734273
  write(path.join(steam, 'userdata', '39734273', 'config', 'localconfig.vdf'), `"UserLocalConfigStore"
{
  "Software" { "Valve" { "Steam" { "apps" {
    "570" { "LastPlayed" "1700000500" "Playtime" "18720" }
    "620" { "Playtime" "95" }
  } } } }
}`);
  write(path.join(steam, 'config', 'avatarcache', '76561198000000001.png'), 'png');

  const ctx = makeCtx({ registry: { 'HKEY_CURRENT_USER\\Software\\Valve\\Steam': { SteamPath: steam } } });
  const res = await scanSteam(ctx);
  assert.equal(res.available, true);
  const byId = Object.fromEntries(res.games.map((g) => [g.id, g]));
  assert.deepEqual(Object.keys(byId).sort(), ['steam:1145360', 'steam:570', 'steam:620']);
  assert.equal(byId['steam:570'].playtimeMinutes, 18720);
  assert.equal(byId['steam:570'].lastPlayed, 1700000500 * 1000);
  assert.equal(byId['steam:570'].status, 'installed');
  assert.equal(byId['steam:570'].launch.url, 'steam://rungameid/570');
  assert.equal(byId['steam:570'].installDir, path.join(steam, 'steamapps', 'common', 'Dota2'));
  assert.equal(byId['steam:1145360'].status, 'installing');
  assert.equal(byId['steam:1145360'].installed, false);
  assert.equal(byId['steam:1145360'].progress, 0.25);
  assert.equal(byId['steam:620'].status, 'updateRequired');
  assert.equal(byId['steam:620'].playtimeMinutes, 95);
  assert.equal(res.meta.user.id64, '76561198000000001');
  assert.equal(res.meta.user.accountId, '39734273');
  assert.equal(res.meta.user.personaName, 'Lolo');
  assert.ok(res.meta.user.avatarPath.endsWith('76561198000000001.png'));
});

test('steam: not installed', async () => {
  const ctx = makeCtx({ registry: { 'HKEY_CURRENT_USER\\Software\\Valve\\Steam': { SteamPath: path.join(tmpDir(), 'none') } }, env: { 'ProgramFiles(x86)': '/nonexistent' } });
  const res = await scanSteam(ctx);
  assert.equal(res.available, false);
  assert.deepEqual(res.games, []);
});

test('epic: manifests, DLC and engine filtering, launch URL', async () => {
  const root = tmpDir();
  const pd = path.join(root, 'ProgramData');
  const manifests = path.join(pd, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  const fnDir = path.join(root, 'Fortnite');
  fs.mkdirSync(fnDir, { recursive: true });
  write(path.join(manifests, 'a.item'), JSON.stringify({ DisplayName: 'Fortnite', AppName: 'Fortnite', MainGameAppName: 'Fortnite', CatalogNamespace: 'fn', CatalogItemId: '4fe75bbc5a674f4f9b356b5c90567da5', InstallLocation: fnDir, InstallSize: 5, AppCategories: ['public', 'games', 'applications'] }));
  write(path.join(manifests, 'b.item'), JSON.stringify({ DisplayName: 'Some DLC', AppName: 'Dlc1', MainGameAppName: 'Fortnite', InstallLocation: fnDir }));
  write(path.join(manifests, 'c.item'), JSON.stringify({ DisplayName: 'Unreal Engine', AppName: 'UE_5.4', InstallLocation: fnDir, AppCategories: ['engines'] }));
  write(path.join(manifests, 'd.item'), JSON.stringify({ DisplayName: 'Gone', AppName: 'Gone', InstallLocation: path.join(root, 'missing') }));
  write(path.join(manifests, 'e.item'), '{not json');
  const res = await scanEpic(makeCtx({ env: { ProgramData: pd } }));
  assert.equal(res.available, true);
  assert.equal(res.games.length, 1);
  assert.equal(res.games[0].id, 'epic:Fortnite');
  assert.equal(res.games[0].launch.url, 'com.epicgames.launcher://apps/fn%3A4fe75bbc5a674f4f9b356b5c90567da5%3AFortnite?action=launch&silent=true');
  assert.equal(launchUrl({ AppName: 'Guppy' }), 'com.epicgames.launcher://apps/Guppy?action=launch&silent=true');
});

test('gog: registry + goggame info play task, DLC skipped, Galaxy option', async () => {
  const root = tmpDir();
  const dir = path.join(root, 'GOG Games', 'Witcher');
  write(path.join(dir, 'bin', 'witcher3.exe'), 'exe');
  write(path.join(dir, 'goggame-1207664663.info'), JSON.stringify({ gameId: '1207664663', playTasks: [
    { type: 'URLTask', link: 'https://example.com' },
    { type: 'FileTask', isPrimary: true, path: 'bin\\witcher3.exe'.replace(/\\/g, path.sep), arguments: '-debug', category: 'game' },
  ] }));
  const dir2 = path.join(root, 'GOG Games', 'Old');
  write(path.join(dir2, 'old.exe'), 'exe');
  const registry = {
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games': { __subkeys: {
      1207664663: { gameID: '1207664663', gameName: 'The Witcher 3', path: dir },
      1207658930: { gameID: '1207658930', gameName: 'Old Game', path: dir2, exe: path.join(dir2, 'old.exe'), launchParam: '-x', workingDir: dir2 },
      1111: { gameID: '1111', gameName: 'A DLC', path: dir, dependsOn: '1207664663' },
    } },
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\GalaxyClient': { clientExecutable: 'GalaxyClient.exe', __subkeys: { paths: { client: path.join(root, 'Galaxy') } } },
  };
  let res = await scanGog(makeCtx({ registry }));
  assert.equal(res.games.length, 2);
  const w = res.games.find((g) => g.sourceId === '1207664663');
  assert.equal(w.launch.type, 'exe');
  assert.equal(w.launch.path, path.join(dir, 'bin', 'witcher3.exe'));
  assert.equal(w.launch.args, '-debug');
  const o = res.games.find((g) => g.sourceId === '1207658930');
  assert.equal(o.launch.path, path.join(dir2, 'old.exe'));
  assert.equal(o.launch.args, '-x');
  assert.ok(w.client && w.client.path.endsWith('GalaxyClient.exe'));
  res = await scanGog(makeCtx({ registry, settings: { launchGogViaGalaxy: true } }));
  const w2 = res.games.find((g) => g.sourceId === '1207664663');
  assert.deepEqual(w2.launch.args, ['/command=runGame', '/gameId=1207664663', `/path=${dir}`]);
});

test('ubisoft: installs + display name from uninstall key', async () => {
  const root = tmpDir();
  const ac = path.join(root, 'AC Valhalla');
  fs.mkdirSync(ac, { recursive: true });
  const registry = {
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher': { InstallDir: root, __subkeys: { Installs: { __subkeys: {
      13504: { InstallDir: `${ac}/` },
      99: { InstallDir: path.join(root, 'gone') },
    } } } },
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall': { __subkeys: {
      'Uplay Install 13504': { DisplayName: "Assassin's Creed Valhalla" },
    } },
  };
  const res = await scanUbisoft(makeCtx({ registry }));
  assert.equal(res.games.length, 1);
  assert.equal(res.games[0].name, "Assassin's Creed Valhalla");
  assert.equal(res.games[0].launch.url, 'uplay://launch/13504/0');
});

test('xbox: MicrosoftGame.config + AppxManifest', async () => {
  const root = tmpDir();
  const loc = path.join(root, 'XboxGames', 'Forza', 'Content');
  write(path.join(loc, 'MicrosoftGame.config'), `<?xml version="1.0" encoding="utf-8"?>
<Game configVersion="1">
  <Identity Name="Microsoft.ForzaHorizon5" Publisher="CN=x" Version="1.0.0.0"/>
  <ShellVisuals DefaultDisplayName="Forza Horizon 5 &amp; More" PublisherDisplayName="Xbox Game Studios"
    Square150x150Logo="Logo150.png" Square44x44Logo="Logo44.png" SplashScreenImage="Splash.png" StoreLogo="Store.png"/>
</Game>`);
  write(path.join(loc, 'AppxManifest.xml'), `<Package><Properties><DisplayName>ms-resource:Name</DisplayName></Properties>
<Applications><Application Id="Game" Executable="gamelaunchhelper.exe"/></Applications></Package>`);
  write(path.join(loc, 'Splash.png'), 'png');
  write(path.join(loc, 'Logo150.png'), 'png');
  const res = await scanXbox(makeCtx({ appx: [{ name: 'Microsoft.ForzaHorizon5', family: 'Microsoft.ForzaHorizon5_8wekyb3d8bbwe', location: loc }, { name: 'Broken', family: 'B_1', location: path.join(root, 'none') }] }));
  assert.equal(res.games.length, 1);
  const g = res.games[0];
  assert.equal(g.name, 'Forza Horizon 5 & More');
  assert.equal(g.launch.target, 'shell:AppsFolder\\Microsoft.ForzaHorizon5_8wekyb3d8bbwe!Game');
  assert.equal(g.localArt.hero, path.join(loc, 'Splash.png'));
  assert.equal(g.localArt.square, path.join(loc, 'Logo150.png'));
  assert.equal(parseGameConfig(null), null);
});

test('emulators: scan, cue/bin dedupe, names and args', async () => {
  const root = tmpDir();
  const roms = path.join(root, 'roms');
  write(path.join(roms, 'Final Fantasy X (USA) [!].iso'), 'x');
  write(path.join(roms, 'sub', 'Crash_Bandicoot.chd'), 'x');
  write(path.join(roms, 'disc', 'Game (Track 1).bin'), 'x');
  write(path.join(roms, 'disc', 'Game.cue'), 'x');
  write(path.join(roms, 'readme.txt'), 'x');
  const exe = write(path.join(root, 'pcsx2', 'pcsx2-qt.exe'), 'x');
  const settings = { emulators: [
    { id: 'ps2', name: 'PCSX2', exe, romDir: roms, extensions: ['iso', 'chd', 'cue', 'bin'], args: '-fullscreen -batch -- "{rom}"', platform: 'PlayStation 2' },
    { id: 'bad', name: 'Missing', exe: path.join(root, 'nope.exe'), romDir: roms, extensions: ['iso'] },
  ] };
  const res = await scanEmulators(makeCtx({ settings }));
  const names = res.games.map((g) => g.name).sort();
  assert.deepEqual(names, ['Crash Bandicoot', 'Final Fantasy X', 'Game']);
  const ff = res.games.find((g) => g.name === 'Final Fantasy X');
  assert.deepEqual(ff.launch.args, ['-fullscreen', '-batch', '--', path.join(roms, 'Final Fantasy X (USA) [!].iso')]);
  assert.equal(ff.launch.trackChild, true);
  assert.equal(res.status.ps2.count, 3);
  assert.equal(res.status.bad.error, 'exeMissing');
  assert.equal(cleanRomName('Super_Mario_World.sfc'), 'Super Mario World');
  assert.equal(cleanRomName('(Beta).iso'), '(Beta)');
});

test('manual: exe vs shortcut', async () => {
  const root = tmpDir();
  const exe = write(path.join(root, 'game.exe'), 'x');
  const lnk = write(path.join(root, 'Other.lnk'), 'x');
  const res = await scanManual(makeCtx({ settings: { manualGames: [
    { id: 'a', name: 'My Game', path: exe, args: '-windowed "a b"' },
    { id: 'b', name: '', path: lnk },
    { id: 'c', name: 'Gone', path: path.join(root, 'gone.exe') },
  ] } }));
  assert.equal(res.games.length, 3);
  assert.deepEqual(res.games[0].launch.args, ['-windowed', 'a b']);
  assert.equal(res.games[1].name, 'Other');
  assert.equal(res.games[1].launch.type, 'open');
  assert.equal(res.games[2].status, 'missing');
  assert.equal(res.games[2].installed, false);
});

test('emulators: Wii U folder games use the title from meta.xml, updates and DLC are skipped', async () => {
  const os = require('os');
  const fsp = require('fs').promises;
  const p = require('path');
  const { scanEmulator } = require('../src/main/sources/emulators');
  const root = await fsp.mkdtemp(p.join(os.tmpdir(), 'dl-wiiu-'));
  const mk = async (dir, rpx, xml) => {
    await fsp.mkdir(p.join(root, dir, 'code'), { recursive: true });
    await fsp.writeFile(p.join(root, dir, 'code', rpx), 'x');
    if (xml) { await fsp.mkdir(p.join(root, dir, 'meta'), { recursive: true }); await fsp.writeFile(p.join(root, dir, 'meta', 'meta.xml'), xml); }
  };
  const meta = (id, short, long) => `<?xml version="1.0" encoding="utf-8"?>\n<menu type="complex" access="777">\n  <title_id type="hexBinary" length="8">${id}</title_id>\n  <longname_en type="string" length="512">${long}</longname_en>\n  <shortname_en type="string" length="256">${short}</shortname_en>\n</menu>`;
  await mk('Splatoon [AGMP01]', 'Gambit.rpx', meta('0005000010176900', 'Splatoon', 'Splatoon'));
  await mk('Splatoon Update', 'Gambit.rpx', meta('0005000E10176900', 'Splatoon', 'Splatoon'));
  await mk('Splatoon DLC', 'Gambit.rpx', meta('0005000C10176900', 'Splatoon', 'Splatoon'));
  await mk('Zelda', 'U-King.rpx', meta('00050000101C9400', '', 'The Legend of Zelda\n Breath of the Wild'));
  await mk('Mario Kart 8 [AMKP01]', 'Turbo.rpx', null);
  await mk('Tom &amp; Jerry', 'game.rpx', meta('0005000010000001', 'Tom &amp; Jerry', ''));
  const exe = p.join(root, 'Cemu.exe');
  await fsp.writeFile(exe, 'x');
  const r = await scanEmulator({ id: 'cemu', name: 'Cemu', platform: 'Wii U', exe, romDir: root, extensions: ['rpx', 'wua'], args: '-f -g "{rom}"' });
  const names = r.games.map((g) => g.name).sort();
  assert.deepEqual(names, ['Mario Kart 8', 'Splatoon', 'The Legend of Zelda Breath of the Wild', 'Tom & Jerry']);
  await fsp.rm(root, { recursive: true, force: true });
});
