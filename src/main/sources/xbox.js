'use strict';
/**
 * Xbox app / Microsoft Store (PC Game Pass) games: packages that contain MicrosoftGame.config
 * (listed by the PowerShell probe via Get-AppxPackage). Launch with
 *   explorer.exe shell:AppsFolder\<PackageFamilyName>!<ApplicationId>
 */
const path = require('path');
const { readText, isFile } = require('../util/fsx');

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function attr(tagText, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i');
  const m = re.exec(tagText);
  return m ? decodeXml(m[1]) : null;
}

function firstTag(xml, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>`, 'i');
  const m = re.exec(xml);
  return m ? m[0] : null;
}

/** Program file names (lower-case, without folders) listed in <ExecutableList>. */
function executableNames(xml) {
  const out = [];
  const re = /<Executable\b[^>]*>/gi;
  let m;
  while ((m = re.exec(String(xml || '')))) {
    const name = attr(m[0], 'Name');
    if (!name) continue;
    const base = name.split(/[\\/]/).pop().trim().toLowerCase();
    if (base.endsWith('.exe') && !out.includes(base)) out.push(base);
  }
  return out;
}

function parseGameConfig(xml) {
  if (!xml) return null;
  const shell = firstTag(xml, 'ShellVisuals') || '';
  const identity = firstTag(xml, 'Identity') || '';
  return {
    executables: executableNames(xml),
    // Xbox title id (hex) used by Xbox network services.
    titleIdHex: (/<TitleId>\s*(?:0x)?([0-9A-Fa-f]{1,8})\s*<\/TitleId>/.exec(xml) || [])[1] || '',
    displayName: attr(shell, 'DefaultDisplayName'),
    identityName: attr(identity, 'Name'),
    splash: attr(shell, 'SplashScreenImage'),
    square480: attr(shell, 'Square480x480Logo'),
    square150: attr(shell, 'Square150x150Logo'),
    storeLogo: attr(shell, 'StoreLogo'),
  };
}

function parseAppxManifest(xml) {
  if (!xml) return null;
  const app = firstTag(xml, 'Application');
  const appId = app ? attr(app, 'Id') : null;
  const exe = app ? attr(app, 'Executable') : null;
  const m = /<Properties>[\s\S]*?<DisplayName>([^<]*)<\/DisplayName>/i.exec(xml);
  return {
    appId,
    executable: exe ? exe.split(/[\\/]/).pop().trim().toLowerCase() : null,
    displayName: m ? decodeXml(m[1]).trim() : null,
  };
}

function usable(name) {
  return typeof name === 'string' && name.trim() && !/^ms-resource:/i.test(name.trim());
}

function prettifyPackageName(name) {
  const last = String(name || '').split('.').pop() || String(name || '');
  return last.replace(/([a-z])([A-Z])/g, '$1 $2').trim() || String(name || '');
}

async function scanXbox(ctx) {
  const list = Array.isArray(ctx.appx) ? ctx.appx : [];
  const games = [];
  const seen = new Set();
  for (const pkg of list) {
    if (!pkg || typeof pkg.family !== 'string' || typeof pkg.location !== 'string') continue;
    if (seen.has(pkg.family)) continue;
    const cfg = parseGameConfig(await readText(path.join(pkg.location, 'MicrosoftGame.config')));
    const manifest = parseAppxManifest(await readText(path.join(pkg.location, 'AppxManifest.xml')));
    const appId = manifest && manifest.appId;
    if (!appId) continue;
    let name = null;
    if (cfg && usable(cfg.displayName)) name = cfg.displayName.trim();
    else if (manifest && usable(manifest.displayName)) name = manifest.displayName;
    else name = prettifyPackageName(pkg.name);
    seen.add(pkg.family);

    const localArt = {};
    if (cfg) {
      const tryFile = async (rel) => {
        if (!rel) return null;
        const p = path.join(pkg.location, rel);
        return (await isFile(p)) ? p : null;
      };
      localArt.hero = await tryFile(cfg.splash);
      localArt.square = (await tryFile(cfg.square480)) || (await tryFile(cfg.square150)) || (await tryFile(cfg.storeLogo));
    }
    // Program names used to recognise the running game (GameLaunchHelper.exe only starts it).
    const exeNames = [...((cfg && cfg.executables) || [])];
    if (manifest.executable && manifest.executable !== 'gamelaunchhelper.exe' && !exeNames.includes(manifest.executable)) exeNames.push(manifest.executable);
    games.push({
      id: `xbox:${pkg.family}`,
      source: 'xbox',
      sourceId: pkg.family,
      name,
      installed: true,
      status: 'installed',
      progress: null,
      installDir: pkg.location,
      sizeBytes: 0,
      playtimeMinutes: 0,
      lastPlayed: 0,
      launch: { type: 'shell', target: `shell:AppsFolder\\${pkg.family}!${appId}` },
      // Microsoft Store "Downloads and updates" page (documented ms-windows-store URI).
      update: { type: 'url', url: 'ms-windows-store://downloadsandupdates' },
      updateIsManual: true,
      client: null,
      tracksOwnPlaytime: false,
      exeNames,
      localArt,
      xboxTitleId: cfg && cfg.titleIdHex ? String(parseInt(cfg.titleIdHex, 16)) : '',
    });
  }
  return { available: list.length > 0, games };
}

module.exports = { scanXbox, parseGameConfig, parseAppxManifest, executableNames };
