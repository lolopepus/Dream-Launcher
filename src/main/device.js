'use strict';
/**
 * Recognises handheld gaming PCs, so the interface can switch to a larger size automatically.
 *
 * Signals, strongest first:
 *  1. Known handheld models (ROG Ally / ROG Xbox Ally, Legion Go, Steam Deck, MSI Claw, AYANEO,
 *     GPD, OneXPlayer, Zotac Zone, ...) from the computer's manufacturer / model / family name.
 *  2. Windows reports the chassis as "Hand Held" (SMBIOS chassis type 11).
 *  3. A battery-powered device whose built-in screen is 9 inches or smaller.
 */

const MODEL_PATTERNS = [
  /\bROG\s*(Xbox\s*)?Ally\b/i,
  /\bRC7[123][A-Z]{1,3}(?![A-Za-z0-9])/i, // ROG Ally (RC71L), Ally X (RC72LA), ROG Xbox Ally / Ally X (RC73YA, RC73XA)
  /\bLegion\s*Go\b/i,
  /\b83(E1|L3|N0|N1|Q2|Q3)\b/i, // Lenovo Legion Go / Go S machine types
  /\bSteam\s*Deck\b/i,
  /\bMSI\s*Claw\b|\bClaw\s*(A1M|7|8|AI)\b/i,
  /\bAYA\s?NEO\b|\bAYANEO\b/i,
  /\bONEXPLAYER\b|\bONEXFLY\b|\bONE-NETBOOK\b/i,
  /\bGPD\s*(WIN|G1)/i,
  /\bZOTAC\s*GAMING\s*ZONE\b/i,
  /\bAOKZOE\b/i,
  /\bAYN\s*Loki\b/i,
];

function diagonalInches(screen) {
  if (!screen || !(screen.w > 0) || !(screen.h > 0)) return 0;
  return Math.sqrt(screen.w * screen.w + screen.h * screen.h) / 2.54; // sizes are in cm
}

/**
 * @param {{manufacturer?:string, model?:string, family?:string, chassis?:number[], screens?:{w:number,h:number}[]}} info
 * @param {{hasBattery?: boolean|null}} extra
 * @returns {{handheld: boolean, reason: string|null, name: string, screenInches: number}}
 */
function classifyDevice(info, { hasBattery = null } = {}) {
  const d = info || {};
  const manufacturer = String(d.manufacturer || '').trim();
  const model = String(d.model || '').trim();
  const family = String(d.family || '').trim();
  const text = `${manufacturer} ${model} ${family}`;
  const valveDeck = /valve/i.test(manufacturer) && /\b(jupiter|galileo)\b/i.test(`${model} ${family}`);
  const name = [manufacturer, family && !model.includes(family) ? family : '', model].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const screens = Array.isArray(d.screens) ? d.screens : [];
  const sizes = screens.map(diagonalInches).filter((x) => x > 0);
  const smallest = sizes.length ? Math.min(...sizes) : 0;
  const round = (x) => Math.round(x * 10) / 10;

  if (valveDeck || MODEL_PATTERNS.some((re) => re.test(text))) {
    return { handheld: true, reason: 'model', name, screenInches: round(smallest) };
  }
  const chassis = Array.isArray(d.chassis) ? d.chassis : [];
  if (chassis.includes(11)) return { handheld: true, reason: 'chassis', name, screenInches: round(smallest) };
  // Only trust the screen size when exactly the built-in screen is known (one screen) and the
  // device runs on battery; a small external monitor on a desktop PC is not a handheld.
  if (hasBattery !== false && screens.length === 1 && smallest > 3 && smallest <= 9.0) {
    return { handheld: true, reason: 'screen', name, screenInches: round(smallest) };
  }
  return { handheld: false, reason: null, name, screenInches: round(smallest) };
}

module.exports = { classifyDevice, diagonalInches };
