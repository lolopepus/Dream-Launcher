'use strict';
/**
 * Small helpers to run Windows PowerShell scripts and read JSON back.
 * Scripts are passed with -EncodedCommand (UTF-16LE base64), so no quoting issues.
 * Output is forced to UTF-8 so game names with accents (e.g. "Pokémon") survive.
 */
const { spawn } = require('child_process');

const MARK_START = '<<<DLJSON';
const MARK_END = 'DLJSON>>>';

const PRELUDE = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$ProgressPreference = 'SilentlyContinue'",
  "$WarningPreference = 'SilentlyContinue'",
  "$InformationPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
].join('\n');

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function extractJson(out) {
  if (typeof out !== 'string') return null;
  const a = out.indexOf(MARK_START);
  const b = out.lastIndexOf(MARK_END);
  if (a === -1 || b === -1 || b < a) return null;
  const json = out.slice(a + MARK_START.length, b).trim();
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

function runPowerShell(script, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('PowerShell is only available on Windows'));
      return;
    }
    let settled = false;
    const finish = (fn, val) => { if (!settled) { settled = true; fn(val); } };
    let child;
    try {
      child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', encodeCommand(PRELUDE + '\n' + script),
      ], { windowsHide: true });
    } catch (err) {
      finish(reject, err);
      return;
    }
    let out = '';
    let errOut = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errOut += d; });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(reject, new Error('PowerShell timed out'));
    }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); finish(reject, err); });
    child.on('close', (code) => { clearTimeout(timer); finish(resolve, { code, out, err: errOut }); });
  });
}

function writeJsonLine(expr) {
  return `[Console]::Out.Write('${MARK_START}' + (${expr}) + '${MARK_END}')`;
}

/**
 * Builds the "system probe" script: dumps the given registry keys (with optional depth),
 * lists installed Microsoft Store / Xbox games (packages that contain MicrosoftGame.config)
 * and counts batteries.
 * @param {{registry: Array<[string, number]>, appx: boolean, battery: boolean}} opts
 */
function buildProbeScript({ registry = [], appx = false, battery = false }) {
  // One Add() call per key: avoids PowerShell flattening a single nested array.
  // Entry: [path, depth] or [path, depth, subkeyNamePrefix]
  const pathList = registry
    .map(([p, d, prefix]) => `[void]$dlPaths.Add(@(${psQuote(p)}, ${Number(d) | 0}, ${psQuote(prefix || '')}))`)
    .join('\n');
  return `
function Read-DLKey([string]$path, [int]$depth, [string]$prefix = '') {
  $key = Get-Item -LiteralPath ('Registry::' + $path)
  if ($null -eq $key) { return $null }
  $o = [ordered]@{}
  foreach ($name in $key.GetValueNames()) {
    $v = $key.GetValue($name)
    $n = $name
    if ([string]::IsNullOrEmpty($n)) { $n = '(default)' }
    if ($v -is [string] -or $v -is [int] -or $v -is [long] -or $v -is [uint32] -or $v -is [uint64]) { $o[$n] = $v }
    elseif ($v -is [string[]]) { $o[$n] = ($v -join "\`n") }
  }
  if ($depth -gt 0) {
    $subs = [ordered]@{}
    foreach ($s in $key.GetSubKeyNames()) {
      if ($prefix -ne '' -and -not $s.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
      $child = Read-DLKey ($path + '\\' + $s) ($depth - 1) ''
      if ($null -ne $child) { $subs[$s] = $child }
    }
    $o['__subkeys'] = $subs
  }
  return $o
}
$result = [ordered]@{ registry = [ordered]@{}; appx = @(); battery = $null }
$dlPaths = New-Object System.Collections.ArrayList
${pathList}
foreach ($p in $dlPaths) {
  if ($p -is [array] -and $p.Count -eq 3) { $result.registry[$p[0]] = Read-DLKey $p[0] $p[1] $p[2] }
}
${appx ? `
$list = New-Object System.Collections.ArrayList
foreach ($pkg in (Get-AppxPackage)) {
  if ($pkg.IsFramework -or $pkg.IsResourcePackage) { continue }
  $loc = $pkg.InstallLocation
  if ([string]::IsNullOrEmpty($loc)) { continue }
  $cfg = Join-Path $loc 'MicrosoftGame.config'
  if (Test-Path -LiteralPath $cfg) {
    [void]$list.Add([ordered]@{ name = $pkg.Name; family = $pkg.PackageFamilyName; location = $loc })
  }
}
$result.appx = $list
` : ''}
${battery ? '$result.battery = @(Get-CimInstance -ClassName Win32_Battery).Count' : ''}
$json = $result | ConvertTo-Json -Depth 10 -Compress
${writeJsonLine('$json')}
`;
}

// One line per process: "<name>.exe|<full path or empty>". The path is empty for processes the
// current user may not inspect (e.g. games running as administrator); the name is always known.
const PROCESS_SCRIPT = `
$out = New-Object System.Collections.ArrayList
foreach ($p in (Get-Process)) {
  $x = ''
  try { $x = $p.Path } catch {}
  if ($null -eq $x) { $x = '' }
  [void]$out.Add(($p.ProcessName + '.exe|' + $x))
}
$json = ConvertTo-Json -InputObject @($out | Sort-Object -Unique) -Compress
${writeJsonLine('$json')}
`;

// Hardware facts used to recognise handheld gaming PCs (ROG Ally, Legion Go, Steam Deck, ...).
const DEVICE_SCRIPT = `
$d = [ordered]@{ manufacturer = ''; model = ''; family = ''; chassis = @(); screens = @() }
try { $cs = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop; $d.manufacturer = [string]$cs.Manufacturer; $d.model = [string]$cs.Model; $d.family = [string]$cs.SystemFamily } catch {}
try { $en = Get-CimInstance -ClassName Win32_SystemEnclosure -ErrorAction Stop | Select-Object -First 1; $d.chassis = @($en.ChassisTypes | ForEach-Object { [int]$_ }) } catch {}
try {
  $list = New-Object System.Collections.ArrayList
  foreach ($m in (Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorBasicDisplayParams -ErrorAction Stop)) {
    if ($m.Active) { [void]$list.Add([ordered]@{ w = [int]$m.MaxHorizontalImageSize; h = [int]$m.MaxVerticalImageSize }) }
  }
  $d.screens = $list
} catch {}
$json = $d | ConvertTo-Json -Depth 5 -Compress
${writeJsonLine('$json')}
`;

/** Runs the probe. On non-Windows systems returns empty data (useful for development). */
async function runProbe(opts) {
  const empty = { registry: {}, appx: [], battery: null };
  if (process.platform !== 'win32') return empty;
  try {
    const { out } = await runPowerShell(buildProbeScript(opts), { timeoutMs: 45000 });
    const data = extractJson(out);
    if (!data || typeof data !== 'object') return empty;
    let appxList = data.appx;
    if (appxList && !Array.isArray(appxList)) appxList = [appxList];
    return {
      registry: data.registry && typeof data.registry === 'object' ? data.registry : {},
      appx: Array.isArray(appxList) ? appxList.filter(Boolean) : [],
      battery: typeof data.battery === 'number' ? data.battery : null,
    };
  } catch {
    return empty;
  }
}

/** Parses the process list script output into [{ name, path }] (lower-case name, path as given). */
function parseProcessList(data) {
  const list = Array.isArray(data) ? data : (typeof data === 'string' ? [data] : []);
  const out = [];
  for (const line of list) {
    if (typeof line !== 'string') continue;
    const i = line.indexOf('|');
    if (i <= 0) continue;
    out.push({ name: line.slice(0, i).trim().toLowerCase(), path: line.slice(i + 1).trim() });
  }
  return out;
}

/** Returns all running processes as [{ name, path }]. Empty array on failure or non-Windows. */
async function listProcesses() {
  if (process.platform !== 'win32') return [];
  try {
    const { out } = await runPowerShell(PROCESS_SCRIPT, { timeoutMs: 20000 });
    return parseProcessList(extractJson(out));
  } catch {
    return [];
  }
}

/** Parses `tasklist /fo csv /nh` output into a set of lower-case image names. */
function parseTasklist(text) {
  const names = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line.trim());
    if (m) names.add(m[1].trim().toLowerCase());
  }
  return names;
}

/**
 * Fast list of running process names via tasklist.exe (about 20x lighter than PowerShell).
 * Resolves with a Set of lower-case image names, or null if it failed.
 */
function listProcessNames({ timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve(null); return; }
    const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    let child;
    try {
      child = spawn(`${root}\\System32\\tasklist.exe`, ['/fo', 'csv', '/nh'], { windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(null); }, timeoutMs);
    child.stdout.setEncoding('latin1');
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      const names = parseTasklist(out);
      finish(code === 0 && names.size > 0 ? names : null);
    });
  });
}

/** Reads hardware facts (model, chassis, physical screen sizes). Never throws. */
async function detectDevice() {
  const empty = { manufacturer: '', model: '', family: '', chassis: [], screens: [] };
  if (process.platform !== 'win32') return empty;
  try {
    const { out } = await runPowerShell(DEVICE_SCRIPT, { timeoutMs: 20000 });
    const d = extractJson(out);
    if (!d || typeof d !== 'object') return empty;
    const arr = (v) => (Array.isArray(v) ? v : (v === null || v === undefined ? [] : [v]));
    return {
      manufacturer: typeof d.manufacturer === 'string' ? d.manufacturer.trim() : '',
      model: typeof d.model === 'string' ? d.model.trim() : '',
      family: typeof d.family === 'string' ? d.family.trim() : '',
      chassis: arr(d.chassis).map(Number).filter(Number.isFinite),
      screens: arr(d.screens).filter((x) => x && Number(x.w) > 0 && Number(x.h) > 0).map((x) => ({ w: Number(x.w), h: Number(x.h) })),
    };
  } catch {
    return empty;
  }
}

module.exports = {
  runPowerShell, runProbe, listProcesses, listProcessNames, detectDevice, buildProbeScript, extractJson,
  parseProcessList, parseTasklist, psQuote, encodeCommand, PROCESS_SCRIPT, DEVICE_SCRIPT,
};
