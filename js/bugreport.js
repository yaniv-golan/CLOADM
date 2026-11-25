/*
 * "Copy bug report" (Help, the command box): what someone fixing a problem needs, as text the person sees before it
 * is copied. bugReport(session) gathers it from a Session and bugReportText writes it (tests/bugreport.test.js). It is
 * a module of its own, outside js/session.js, so the side panel's folded view (connector/fold.js), which never makes a
 * report, carries none of it.
 *
 * In it: the version stamp, the machine and its options, the browser, the file loaded last (its name and SHA-256)
 * and, only when the person ticks it, the moment as a share link (Session.snapshotLink: ROM-free, AGENTS rule 1).
 * ROMs appear only as their sockets' CRCs, and a cartridge loaded last only as "a cartridge, CRC32 X" (it is someone's ROM). Never in it: the Claude key, a ROM's bytes or file name, or a WAD (a WAD
 * is the person's own game data: the report says one was loaded, and nothing about it).
 */
import { versionStamp } from './version.js';
import { SessionError } from './errors.js';
import { formats } from './media/formats.js';
import { crc32 } from './util.js';

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

// What the report is made of, from the Session: the machine on screen and its options, its ROMs by CRC only, the
// browser, the file loaded last (name and SHA-256; a WAD is not named; a cartridge by CRC32 only) and, only with
// snapshot, the moment as the Share screen's ROM-free link (Session.snapshotLink). -> { text, parts }
export async function bugReport(session, { base = 'https://cloadm.dev/play/', browser = '', snapshot = false } = {}) {
  const m = session.shownMachine, options = {};
  for (const [k, v] of Object.entries(m.config)) if (m.profile.options[k]) options[k] = v;
  const last = session.lastLoaded;
  // a cartridge (or anything that is a ROM image) is someone's ROM: by its CRC only, never its name or SHA-256
  let kind = null;
  if (last) { try { kind = formats.identify(last.name, last.bytes).kind; } catch (e) { kind = null; } }
  const cart = !!last && !isWad(last.name, last.bytes) && (kind === 'cart' || session.constructor.isRom(last.name, last.bytes));
  const file = !last ? null : isWad(last.name, last.bytes) ? { wad: true } : cart ? { cartridge: crc32(last.bytes) } : { name: last.name, sha256: await sha256Hex(last.bytes) };
  let link = null, snapshotNote = '';
  if (snapshot) {
    try { link = await session.snapshotLink(base); } catch (e) { if (!(e instanceof SessionError)) throw e; snapshotNote = `not included (${e.message})`; }
  }
  const roms = Object.assign({}, m.romCrcs(), cart ? { cartridge: file.cartridge } : {});
  const parts = { machine: { id: m.id, name: m.profile.name }, options, roms, browser, file, snapshot: link, snapshotNote };
  return { text: bugReportText(parts), parts };
}
