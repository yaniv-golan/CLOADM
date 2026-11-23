/*
 * The first look at a file the person offers as their own WAD for WYRMFIRE, before anything is converted: is it a
 * WAD, the main game file (an IWAD, not an add-on PWAD), small enough to convert in the browser, and does it hold map
 * E1M1 (the level WYRMFIRE plays)? Only the 12-byte header and the lump directory are read. CLOADM's own code (the
 * converter that follows is WYRMFIRE's, GPL: examples/wyrmfire/converter/), browser-free, tested on synthetic
 * headers only (tests/wyrmfire-wad.test.js): no id Software file is used anywhere in CLOADM.
 *
 * The WAD format (the Doom wiki's "WAD" page; WYRMFIRE's converter, class Wad, reads the same): "IWAD" or "PWAD", a
 * 32-bit little-endian lump count, a 32-bit offset of the directory, and 16 bytes per lump: offset, size, an 8-byte
 * name padded with NULs.
 *
 * Every message is what the page shows (the strip and a toast), word for word.
 */
// the largest file converted here: the registered DOOM.WAD is about 12 MB, Freedoom's 29 MB
export const WAD_MAX_MB = 40;
export const WAD_TEXT = Object.freeze({
  notWad: 'That isn\'t a WAD file.',
  pwad: 'That\'s an add-on. WYRMFIRE needs the main game file (DOOM1.WAD or DOOM.WAD).',
  noE1M1: 'This WAD has no E1M1. WYRMFIRE plays the first level of DOOM\'s episode 1.',
  tooBig: (mb = WAD_MAX_MB) => `Too big to convert here (over ${mb} MB).`,
  limit: 'E1M1 in this WAD is too much for the Dragon\'s memory. The Freedoom level still works.',
  storage: 'Converted, but this browser can\'t keep it: it will play now and be gone after reload.',
  // any other failure of the converter, with its own words
  failed: (why) => `Couldn't convert this WAD: ${why}`,
});

export class WadCheckError extends Error {
  constructor(code, message) { super(message); this.name = 'WadCheckError'; this.code = code; }
}

// bytes (a Uint8Array) -> { lumps } when WYRMFIRE can try it; throws a WadCheckError (code: 'too-big', 'not-wad',
// 'pwad', 'no-e1m1') with the page's message otherwise
export function checkWad(bytes, { maxMb = WAD_MAX_MB } = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('checkWad: bytes is a Uint8Array');
  if (bytes.length > maxMb * 1024 * 1024) throw new WadCheckError('too-big', WAD_TEXT.tooBig(maxMb));
  if (bytes.length < 12) throw new WadCheckError('not-wad', WAD_TEXT.notWad);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== 'IWAD' && magic !== 'PWAD') throw new WadCheckError('not-wad', WAD_TEXT.notWad);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lumps = dv.getUint32(4, true), dir = dv.getUint32(8, true);
  if (dir + lumps * 16 > bytes.length) throw new WadCheckError('not-wad', WAD_TEXT.notWad);
  if (magic === 'PWAD') throw new WadCheckError('pwad', WAD_TEXT.pwad);
  for (let i = 0; i < lumps; i++) {
    const at = dir + i * 16 + 8;
    let name = '';
    for (let k = 0; k < 8 && bytes[at + k]; k++) name += String.fromCharCode(bytes[at + k]);
    if (name.toUpperCase() === 'E1M1') return { lumps };
  }
  throw new WadCheckError('no-e1m1', WAD_TEXT.noE1M1);
}

// What the converter's failure says to the person: its error's name (the worker's `kind`) and message -> the page's words
export function convertErrorText(kind, message) {
  if (kind === 'LimitError') return WAD_TEXT.limit;
  if (/has no map E1M1\b/.test(message || '')) return WAD_TEXT.noE1M1;
  if (/not a WAD|bad magic|shorter than its 12-byte header|directory runs past/.test(message || '')) return WAD_TEXT.notWad;
  return WAD_TEXT.failed(message || 'unknown error');
}
