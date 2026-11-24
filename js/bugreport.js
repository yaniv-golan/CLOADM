/*
 * "Copy bug report" (Help, the command box): what someone fixing a problem needs, as text the person sees before it
 * is copied. Session.bugReport gathers it; this module only writes it (tests/bugreport.test.js).
 *
 * In it: the version stamp, the machine and its options, the browser, the file loaded last (its name and SHA-256)
 * and, only when the person ticks it, the moment as a share link (Session.snapshotLink: ROM-free, AGENTS rule 1).
 * ROMs appear only as their sockets' CRCs, and a cartridge loaded last only as "a cartridge, CRC32 X" (it is someone's ROM). Never in it: the Claude key, a ROM's bytes or file name, or a WAD (a WAD
 * is the person's own game data: the report says one was loaded, and nothing about it).
 */
import { versionStamp } from './version.js';

export async function sha256Hex(bytes) {
  const d = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// a Doom-format WAD, by its name or its magic ("IWAD" or "PWAD" first)
export const isWad = (name, bytes) => /\.wad$/i.test(name || '')
  || (!!bytes && bytes.length >= 4 && /^[IP]WAD$/.test(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])));

// { stamp, machine: { id, name }, options: { key: value }, roms: { socket: crc (hex, as Machine.romCrcs gives it) }, browser, file: { name, sha256 } |
//   { wad: true } | { cartridge: crc } | null, snapshot: link | null, snapshotNote } -> the report's text
export function bugReportText(r) {
  const opts = Object.entries(r.options || {}).map(([k, v]) => `${k}=${v}`).join(', ');
  const roms = Object.entries(r.roms || {}).map(([s, crc]) => `${s} ${crc}`).join(', ');
  const lines = [
    'CLOADM bug report',
    `Version: ${r.stamp || versionStamp()}`,
    `Machine: ${r.machine.name} (${r.machine.id})${opts ? `; ${opts}` : ''}`,
    `ROMs (CRC32): ${roms || 'none (runs without ROMs)'}`,
    `Browser: ${r.browser || 'unknown'}`,
    `File: ${!r.file ? 'none loaded' : r.file.wad ? 'a WAD (not included)' : r.file.cartridge ? `a cartridge, CRC32 ${r.file.cartridge}` : `${r.file.name}, SHA-256 ${r.file.sha256}`}`,
  ];
  if (r.snapshot) lines.push(`Snapshot (holds no ROM): ${r.snapshot}`);
  else if (r.snapshotNote) lines.push(`Snapshot: ${r.snapshotNote}`);
  lines.push('', 'What happened, and what you expected:', '');
  return lines.join('\n');
}
