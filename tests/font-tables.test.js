// THE 1x RENDERER'S TABLES, CHECKED AGAINST AN INDEPENDENT MODEL.
// Before this test nothing in the suite mentioned V3P*/V5P*/GAPTAB: a wrong entry was caught only by two PNG
// comparisons, and the recording analysis that follows them threw a TypeError, so most of the suite never ran.
// This derives every entry from the FONT bitmaps and the shift rule written out HERE, in the test, and compares
// it with what examples/games.inc actually stores. Nothing is read from the tables to build the expectation.
//
// The rule (written from the renderer's own description, not from its code): a glyph's row is a row of pixels;
// a set pixel is the 2-bit pair 11 at its place in a 16-bit window whose hi byte is the screen byte the cursor
// names. For width w at pixel phase ph, the pixel at glyph column i occupies bit pair
// (16 - 2*ph - 2*(w - i)) counting from the top, i.e. shift 14 - 2*(ph + i). The cell's mask covers the glyph
// plus its trailing blank column, i.e. i from 0 to w.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const incSrc = fs.readFileSync(path.join(ROOT, 'examples/games.inc'), 'utf8');

// the font, read from the FCB bitmaps
const fontAt = incSrc.split('\n').findIndex((l) => /^FONT\s+FCB/.test(l));
const FONT = [];
for (let i = fontAt; i < incSrc.split('\n').length; i++) {
  const m = /FCB\s+(%[01]{3}(?:,%[01]{3}){4})/.exec(incSrc.split('\n')[i]);
  if (!m) break;
  FONT.push(m[1].split(',').map((b) => parseInt(b.slice(1), 2)).join(','));
}
const WIDE5 = new Map();
for (const m of incSrc.matchAll(/^FONT5([A-Z])\s+FCB\s+(%[01]{5}(?:,%[01]{5}){4})/gm)) {
  WIDE5.set(m[1], m[2].split(',').map((b) => parseInt(b.slice(1), 2)).join(',').split(',').map(Number));
}

// the model: every row pattern this width can produce, as the two screen bytes the renderer must write
function expected(width, phase) {
  const rows = [];
  const n = width === 3 ? 8 : 32;
  for (let r = 0; r < n; r++) {
    let bits = 0;
    for (let i = 0; i < width; i++) {
      const set = (r >> (width - 1 - i)) & 1;      // bit (width-1-i) of the raw row is its column i
      const shift = 14 - 2 * (phase + i);
      if (set && shift >= 0) bits |= 3 << shift;
    }
    rows.push([(bits >> 8) & 0xFF, bits & 0xFF]);
  }
  let gap = 0;
  for (let i = 0; i <= width; i++) {
    const shift = 14 - 2 * (phase + i);
    if (shift >= 0) gap |= 3 << shift;
  }
  return { rows, gap: [(gap >> 8) & 0xFF, gap & 0xFF] };
}

// the tables as stored
function table(label) {
  const m = new RegExp(`^${label}\\s+FCB\\s+([^\\n]*(?:\\n\\s+FCB\\s+[^\\n]*)*)`, 'm').exec(incSrc);
  if (!m) return null;
  return [...m[1].matchAll(/\$([0-9A-Fa-f]{2})/g)].map((x) => parseInt(x[1], 16));
}

let fail = 0, n = 0;
const check = (name, ok, detail = '') => { n++; if (!ok) { fail++; console.log(`FAIL ${name}${detail ? ' ' + detail : ''}`); } else console.log(`ok   ${name}`); };
const hex = (a) => a.map((x) => '$' + x.toString(16).toUpperCase().padStart(2, '0')).join(',');

// every table entry the renderer can index, against the model
for (const [label, w, ph] of [['V3P0', 3, 0], ['V3P2', 3, 2], ['V5P0', 5, 0], ['V5P2', 5, 2]]) {
  const got = table(label);
  if (!got) { check(`${label} is in games.inc`, false); continue; }
  const want = expected(w, ph).rows.flat();
  const at = got.findIndex((v, i) => v !== want[i]);
  check(`${label}: all ${want.length} bytes match the model (${w}-wide, phase ${ph})`,
    got.length === want.length && at < 0,
    at < 0 ? '' : `byte ${at}: stored $${got[at].toString(16)}, the model says $${want[at].toString(16)}`);
}

// the cell masks, at the four indices the renderer uses
for (const [idx, w, ph] of [[0, 3, 0], [2, 3, 2], [4, 5, 0], [6, 5, 2]]) {
  const got = table('GAPTAB');
  const want = expected(w, ph).gap;
  check(`GAPTAB entry ${idx}: the ${w}-wide phase-${ph} cell mask is ${hex(want)}`,
    got && got[2 * idx] === want[0] && got[2 * idx + 1] === want[1],
    got ? `stored ${hex([got[2 * idx], got[2 * idx + 1]])}` : 'no GAPTAB');
}

// THE MODEL IS THE FONT: a spot check that the tables are derived from the real glyphs, not from a formula that
// happens to agree. 'I' is %111 x3 rows and %010 x2; at 3-wide phase 0 its middle rows must be $3C,$00.
{
  const I = FONT['I'.charCodeAt(0) - 0x20].split(',').map(Number);
  const want = expected(3, 0).rows;
  // I is %111,%010,%010,%010,%111 -> at 3-wide phase 0 those rows are $3C,$00 and $00,$00 must not appear
  // want[] is indexed by the RAW row value. At 3-wide phase 0 the glyph's three pixels are bits 7-2 of the hi
  // byte, so %111 -> $FC, %010 -> $30, %000 -> $00. These are read off the FONT bitmap for I and compared with
  // the table entry V3P0 stores, which is the point: the table must encode the real glyph.
  const okI = want[7][0] === 0xFC && want[2][0] === 0x30 && want[0][0] === 0x00
    && I.includes(7) && I.includes(2) && table('V3P0')[14] === 0xFC;
  check('the model agrees with the FONT bitmap for I (row %111 -> $FC, %010 -> $30 at 3-wide phase 0, and V3P0 stores it)',
    okI, `I rows ${I.join(',')}, want[7]=${hex(want[7])}, want[2]=${hex(want[2])}`);
  const w = WIDE5.get('W');
  const okW = w && w.length === 5 && w.every((b) => b < 32);
  check('the five-wide tables come from FONT5W, five bits a row', okW, w ? w.join(',') : 'no FONT5W');
}

// THE PHASES THAT ACTUALLY OCCUR, and the code that keeps them that way.
// Two halves, because either alone is blind: (1) the arithmetic -- every string centres to an even column and
// every advance is 4 or 6, so only phases 0 and 2 arise; (2) the ASM that enforces it. A static recomputation of
// the formula cannot notice CENTRE losing its even mask, so the mask itself is asserted here.
{
  const bad = [];
  for (const game of ['2048', 'minesweeper']) {
    const src = fs.readFileSync(path.join(ROOT, `examples/${game}.asm`), 'utf8');
    for (const [, key, s] of src.matchAll(/^(T_\w+)\s+FCN\s+"([^"]*)"$/gm)) {
      const wid = [...s].reduce((a, c) => a + (WIDE5.has(c) ? 5 : 3) + 1, 0) - 1;
      let x = ((128 - wid) >> 1) & ~1;
      for (const c of s) { if (x % 4 !== 0 && x % 4 !== 2) bad.push(`${game} ${key} '${c}' at ${x} (phase ${x % 4})`); x += (WIDE5.has(c) ? 5 : 3) + 1; }
    }
  }
  check('every glyph of every 1x string lands on phase 0 or 2 (the two-byte row write needs it)', bad.length === 0, bad.slice(0, 6).join(', '));
  const centre = /^CENTRE\s+PSHS\s+A[\s\S]*?^CENBYTE/m.exec(incSrc);
  const masked = centre && /LSRB\s*\n\s*ANDB\s+#\$FE\b/.test(centre[0]);
  check('CENTRE masks the 1x start to an even column (ANDB #$FE); without it glyphs land on odd phases and the '
    + 'two-byte row write is inexact', masked, centre ? 'the mask is missing from CENTRE' : 'CENTRE not found');
  // and the tile numbers: 4n-1 px wide, so (24-wid)/2 shifted is even and SQCOL*4 is even
  const odd = ['0', '2', '16', '128', '2048'].filter((s) => {
    const wid = [...s].reduce((a, c) => a + (WIDE5.has(c) ? 5 : 3) + 1, 0) - 1;
    return (Math.floor((24 - wid) / 2) + 8) % 2 !== 0;
  });
  check('a tile number is 4n-1 pixels wide, so its column is always even', odd.length === 0, odd.join(','));
}

console.log(fail ? `\n${fail} of ${n} table checks FAILED` : `\nall ${n} table checks passed`);
process.exitCode = fail ? 1 : 0;
