'use strict';
/**
 * Presets for common emulators. Arguments use {rom} for the game file path.
 * Only arguments documented by the emulators themselves are used; everything stays editable.
 */
const PRESETS = [
  {
    id: 'retroarch', name: 'RetroArch', platform: 'RetroArch',
    // -L picks the core. Replace the core file name with the one you use.
    args: '-f -L "cores\\snes9x_libretro.dll" "{rom}"',
    extensions: ['zip', 'sfc', 'smc', 'nes', 'gba', 'gb', 'gbc', 'md', 'smd', 'gen', 'n64', 'z64', 'v64', 'pce', 'cue', 'chd'],
  },
  {
    id: 'dolphin', name: 'Dolphin', platform: 'GameCube / Wii',
    args: '-b -e "{rom}"',
    extensions: ['iso', 'gcm', 'rvz', 'wbfs', 'ciso', 'gcz', 'wia', 'wad', 'dol', 'elf'],
  },
  {
    id: 'pcsx2', name: 'PCSX2', platform: 'PlayStation 2',
    args: '-fullscreen -batch -- "{rom}"',
    extensions: ['iso', 'chd', 'cso', 'zso', 'gz', 'bin', 'img', 'mdf', 'nrg', 'elf'],
  },
  {
    id: 'duckstation', name: 'DuckStation', platform: 'PlayStation',
    args: '-batch -fullscreen "{rom}"',
    extensions: ['cue', 'chd', 'pbp', 'iso', 'img', 'ecm', 'mds', 'm3u', 'exe', 'psexe'],
  },
  {
    id: 'ppsspp', name: 'PPSSPP', platform: 'PSP',
    args: '--fullscreen "{rom}"',
    extensions: ['iso', 'cso', 'chd', 'pbp', 'elf', 'prx'],
  },
  {
    id: 'cemu', name: 'Cemu', platform: 'Wii U',
    args: '-f -g "{rom}"',
    extensions: ['wua', 'wud', 'wux', 'rpx'],
  },
  {
    id: 'mgba', name: 'mGBA', platform: 'Game Boy Advance',
    args: '-f "{rom}"',
    extensions: ['gba', 'gb', 'gbc', 'sgb'],
  },
  {
    id: 'ryujinx', name: 'Ryujinx / Ryubing', platform: 'Nintendo Switch',
    args: '"{rom}"',
    extensions: ['nsp', 'xci', 'nca', 'nro', 'nso'],
  },
  {
    id: 'melonds', name: 'melonDS', platform: 'Nintendo DS',
    args: '"{rom}"',
    extensions: ['nds', 'dsi', 'srl'],
  },
  {
    id: 'azahar', name: 'Azahar', platform: 'Nintendo 3DS',
    args: '"{rom}"',
    extensions: ['3ds', 'cci', 'cxi', '3dsx', 'app', 'elf', 'axf'],
  },
  {
    id: 'custom', name: 'Custom', platform: '',
    args: '"{rom}"',
    extensions: [],
  },
];

function getPreset(id) {
  return PRESETS.find((p) => p.id === id) || PRESETS[PRESETS.length - 1];
}

module.exports = { PRESETS, getPreset };
