// The first look at a file offered as the person's own WAD (js/wyrmfire/wad-check.js), and what each failure says:
// every message comes from SYNTHETIC WAD headers built here, byte by byte (the WAD format: magic, lump count, directory
// offset, 16-byte directory entries). No id Software file is read, fetched or made anywhere in this test.
const { checkWad, convertErrorText, WAD_TEXT, WAD_MAX_MB, WadCheckError } = require('../js/wyrmfire/wad-check.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

// a WAD of empty lumps with these names: header, then the directory right after it
function wad(magic, names) {
  const b = new Uint8Array(12 + names.length * 16), dv = new DataView(b.buffer);
  for (let i = 0; i < 4; i++) b[i] = magic.charCodeAt(i);
  dv.setUint32(4, names.length, true);
  dv.setUint32(8, 12, true);
  names.forEach((n, i) => { const at = 12 + i * 16; dv.setUint32(at, 12, true); dv.setUint32(at + 4, 0, true); for (let k = 0; k < n.length; k++) b[at + 8 + k] = n.charCodeAt(k); });
  return b;
}
const code = (bytes, opts) => { try { checkWad(bytes, opts); return 'ok'; } catch (e) { return e instanceof WadCheckError ? `${e.code}|${e.message}` : `other|${e.message}`; } };

check('an IWAD with E1M1: WYRMFIRE can try it', code(wad('IWAD', ['PLAYPAL', 'E1M1', 'THINGS'])) === 'ok');
check('a lower-case lump name is still E1M1 (the converter reads names upper-cased)', code(wad('IWAD', ['e1m1'])) === 'ok');
check('not a WAD: "That isn\'t a WAD file."', code(new TextEncoder().encode('PK\x03\x04 a zip, not a WAD')) === `not-wad|${WAD_TEXT.notWad}` && WAD_TEXT.notWad === 'That isn\'t a WAD file.');
check('shorter than the header: not a WAD', code(new Uint8Array([0x49, 0x57, 0x41, 0x44])) === `not-wad|${WAD_TEXT.notWad}`);
{
  const b = wad('IWAD', ['E1M1']);
  new DataView(b.buffer).setUint32(4, 1000, true);   // a directory that runs past the end
  check('a directory past the end of the file: not a WAD', code(b) === `not-wad|${WAD_TEXT.notWad}`);
}
check('a PWAD: an add-on, with the words asked for', code(wad('PWAD', ['E1M1'])) === `pwad|${WAD_TEXT.pwad}`
  && WAD_TEXT.pwad === 'That\'s an add-on. WYRMFIRE needs the main game file (DOOM1.WAD or DOOM.WAD).');
check('an IWAD without E1M1 (a Doom II-style MAP01): the words asked for', code(wad('IWAD', ['PLAYPAL', 'MAP01', 'E1M10'])) === `no-e1m1|${WAD_TEXT.noE1M1}`
  && WAD_TEXT.noE1M1 === 'This WAD has no E1M1. WYRMFIRE plays the first level of DOOM\'s episode 1.');
check('too big: "Too big to convert here (over N MB).", before anything is read', code(new Uint8Array(3 * 1024 * 1024 + 1), { maxMb: 3 }) === 'too-big|Too big to convert here (over 3 MB).'
  && WAD_TEXT.tooBig() === `Too big to convert here (over ${WAD_MAX_MB} MB).`);
check('the size limit is checked before the magic (a huge non-WAD says it is too big)', code(new Uint8Array(2 * 1024 * 1024), { maxMb: 1 }).startsWith('too-big|'));
// the converter's own failures, in the page's words
check('the converter\'s LimitError: "E1M1 in this WAD is too much for the Dragon\'s memory. The Freedoom level still works."',
  convertErrorText('LimitError', 'map has 300 regions; HGR2 allows 255') === 'E1M1 in this WAD is too much for the Dragon\'s memory. The Freedoom level still works.');
check('the converter\'s "no map E1M1": the no-E1M1 words', convertErrorText('WadError', 'WAD has no map E1M1') === WAD_TEXT.noE1M1);
check('the converter\'s bad magic: not a WAD', convertErrorText('WadError', 'not a WAD (bad magic)') === WAD_TEXT.notWad);
check('any other failure names itself', convertErrorText('WadError', 'WAD has no PLAYPAL palette') === 'Couldn\'t convert this WAD: WAD has no PLAYPAL palette');
check('the storage message', WAD_TEXT.storage === 'Converted, but this browser can\'t keep it: it will play now and be gone after reload.');
check('a non-Uint8Array is a programming error, not a message', (() => { try { checkWad('IWAD'); return false; } catch (e) { return e instanceof TypeError; } })());

// The converter itself (WYRMFIRE's, vendored: examples/wyrmfire/converter/) on synthetic WADs with real lumps: a map
// 20000 units wide is too much for the Dragon (its LimitError), and a WAD without a palette fails in its own words.
// lumps: [[name, bytes]]
function wadOf(magic, lumps) {
  let size = 12;
  for (const [, d] of lumps) size += d.length;
  const dir = size, b = new Uint8Array(size + lumps.length * 16), dv = new DataView(b.buffer);
  for (let i = 0; i < 4; i++) b[i] = magic.charCodeAt(i);
  dv.setUint32(4, lumps.length, true); dv.setUint32(8, dir, true);
  let at = 12;
  lumps.forEach(([n, d], i) => { b.set(d, at); const e = dir + i * 16; dv.setUint32(e, at, true); dv.setUint32(e + 4, d.length, true); for (let k = 0; k < n.length; k++) b[e + 8 + k] = n.charCodeAt(k); at += d.length; });
  return b;
}
const i16 = (...v) => { const b = new Uint8Array(v.length * 2), dv = new DataView(b.buffer); v.forEach((x, i) => dv.setInt16(i * 2, x, true)); return b; };
// one linedef from (0,0) to (20000,0), the player 1 start at (64,64)
const WIDE = [['PLAYPAL', new Uint8Array(768)], ['E1M1', new Uint8Array(0)], ['THINGS', i16(64, 64, 0, 1, 7)], ['LINEDEFS', i16(0, 1, 1, 0, 0, 0, -1)],
  ['SIDEDEFS', new Uint8Array(30)], ['VERTEXES', i16(0, 0, 20000, 0)], ['SEGS', i16(0, 1, 0, 0, 0, 0)], ['SSECTORS', i16(1, 0)], ['NODES', new Uint8Array(28)], ['SECTORS', new Uint8Array(26)]];

(async () => {
  const conv = await import(require('url').pathToFileURL(require('path').join(__dirname, '..', 'examples/wyrmfire/converter/wyrmfire-convert.js')).href);
  const outcome = async (bytes) => { try { await conv.convertAsync(bytes, { map: 'E1M1' }); return null; } catch (e) { return e; } };
  const wide = wadOf('IWAD', WIDE);
  check('a synthetic WAD with a map 20000 units wide passes the first look', code(wide) === 'ok');
  const limit = await outcome(wide);
  check('... and the converter stops it with a LimitError, which the page words as asked', limit && limit.name === 'LimitError' && convertErrorText(limit.name, limit.message) === WAD_TEXT.limit, limit && `${limit.name}: ${limit.message}`);
  const noPal = await outcome(wadOf('IWAD', WIDE.slice(1)));
  check('a synthetic WAD without a palette: the converter\'s own words', noPal && convertErrorText(noPal.name, noPal.message) === 'Couldn\'t convert this WAD: WAD has no PLAYPAL palette', noPal && noPal.message);
  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log(`FAIL ${e.stack}`); process.exitCode = 1; });
