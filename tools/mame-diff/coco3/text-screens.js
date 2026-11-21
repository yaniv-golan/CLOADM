// The CoCo 3 GIME text screens: what the screen-text reader (js/claude/readtools.js screen_text) must return for
// each GIME text mode, and the firmware that puts those screens up. Used by run-text.js (the pixel comparison with
// MAME, `node tools/mame-diff/run.js coco3 --video --text`) and by tests/coco3-screen-text.test.js (the reader on
// the same firmware, in Node).
//
// The expectations are written here by hand from the GIME's documented layout, never by running the reader: each
// screen gives its registers, the bytes the firmware writes (at offsets from the video start, worked out from the
// row pitch: the characters of a row, doubled with attribute bytes, or 256 with $FF9F bit 7) and, separately, the
// literal rows of text a person sees (`lines`) and the attribute runs of some rows. The international characters
// $00-$1F are written as their codes and expected as the letters the GIME draws.
//
// Every screen is in physical RAM at $70000-$77FFF, which the CPU sees at $0000-$7FFF with the MMU off.

// the bytes of a string: one per character, each character's own code ($00-$FF)
const bytes = (s) => Array.from(s, (c) => c.charCodeAt(0));
// characters interleaved with an attribute byte (one attribute, or one per character)
const withAttr = (s, attr) => bytes(s).flatMap((c, i) => [c, Array.isArray(attr) ? attr[i] : attr]);
// a run of attributes, as screen_text reports them
const run = (from, to, attr) => ({ from, to, fg: (attr >> 3) & 7, bg: attr & 7, underline: !!(attr & 0x40), blink: !!(attr & 0x80) });
const blank = (n) => new Array(n).fill('');

// the 128 character codes, $00-$3F and $40-$7F, as they read
const CODES_00_3F = 'ÇüéâäàåçêëèïîßÄÅóæÆôöøûùØÖÜ§£±°ƒ !"#$%&\'()*+,-./0123456789:;<=>?';
const CODES_40_7F = '@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~▒';
const range = (from, n) => Array.from({ length: n }, (_, i) => from + i);
const two = (n) => String(n).padStart(2, '0');

// [name, $FF98, $FF99, $FF9C, $FF9F, video start (physical), clear: { bytes, fill: [char] | [char, attr] },
//  writes: [[offset, bytes]], expect: { rows, lines, attributes: { row: runs } }]
const SCREENS = [
  {
    name: 'text 32', f98: 0x03, f99: 0x00, base: 0x70000, clear: { bytes: 32 * 24, fill: [0x20] },
    writes: [[0, bytes('CLOADM GIME TEXT, 32 COLUMNS')], [5 * 32 + 3, bytes('lower case: abc xyz {|}~')],
      [23 * 32, bytes('LAST ROW')], [23 * 32 + 20, bytes('END AT COL31')]],
    expect: { lines: ['CLOADM GIME TEXT, 32 COLUMNS', '', '', '', '', '   lower case: abc xyz {|}~', ...blank(17), 'LAST ROW            END AT COL31'] },
  },
  {
    name: 'text 32 attr', f98: 0x03, f99: 0x01, base: 0x70000, clear: { bytes: 64 * 24, fill: [0x20, 0x08] },
    writes: [[0, withAttr('ATTRIBUTES, 32 COLUMNS', 0x08)], [64 + 2 * 2, withAttr('UNDERLINED', 0x48)],
      [2 * 64, withAttr('BLINK BIT', 0x88)], [3 * 64, withAttr('COLOURS', [0x07, 0x0E, 0x15, 0x1C, 0x23, 0x2A, 0x31])],
      [4 * 64, withAttr('\xC8\xE9', 0x08)], [15 * 64 + 24 * 2, withAttr('ROW 15', 0x08)]],
    expect: {
      lines: ['ATTRIBUTES, 32 COLUMNS', '  UNDERLINED', 'BLINK BIT', 'COLOURS', 'Hi', ...blank(10), '                        ROW 15'],
      attributes: {
        0: [run(0, 31, 0x08)],
        1: [run(0, 1, 0x08), run(2, 11, 0x48), run(12, 31, 0x08)],
        2: [run(0, 8, 0x88), run(9, 31, 0x08)],
        3: [run(0, 0, 0x07), run(1, 1, 0x0E), run(2, 2, 0x15), run(3, 3, 0x1C), run(4, 4, 0x23), run(5, 5, 0x2A), run(6, 6, 0x31), run(7, 31, 0x08)],
      },
    },
  },
  {
    name: 'text 40', f98: 0x03, f99: 0x04, base: 0x70000, clear: { bytes: 40 * 24, fill: [0x20] },
    writes: [[0, bytes('40 COLUMNS: THE QUICK BROWN FOX JUMPS')], [12 * 40, bytes('0123456789012345678901234567890123456789')],
      [23 * 40 + 39, bytes('!')]],
    expect: { lines: ['40 COLUMNS: THE QUICK BROWN FOX JUMPS', ...blank(11), '0123456789012345678901234567890123456789', ...blank(10), ' '.repeat(39) + '!'] },
  },
  {
    // 9 lines per row: 192 / 9 = 21 whole rows and a 22nd of 3 lines
    name: 'text 40 attr 9 lines', f98: 0x04, f99: 0x05, base: 0x70000, clear: { bytes: 80 * 22, fill: [0x20, 0x38] },
    writes: [[0, withAttr('NINE LINES PER ROW, 22 ROWS', 0x38)], [21 * 80, withAttr('ROW 21 IS CUT SHORT', 0x38)]],
    expect: { lines: ['NINE LINES PER ROW, 22 ROWS', ...blank(20), 'ROW 21 IS CUT SHORT'], attributes: { 21: [run(0, 39, 0x38)] } },
  },
  {
    // every character code: $00-$7F on rows 0 and 1, and again with bit 7 set on rows 2 and 3 (the GIME ignores it)
    name: 'text 64 charset', f98: 0x03, f99: 0x10, base: 0x70000, clear: { bytes: 64 * 24, fill: [0x20] },
    writes: [[0, range(0x00, 64)], [64, range(0x40, 64)], [128, range(0x80, 64)], [192, range(0xC0, 64)]],
    expect: { lines: [CODES_00_3F, CODES_40_7F, CODES_00_3F, CODES_40_7F] },
  },
  {
    name: 'text 64 attr', f98: 0x03, f99: 0x11, base: 0x70000, clear: { bytes: 128 * 24, fill: [0x20, 0x10] },
    writes: [[0, withAttr('SIXTY-FOUR COLUMNS WITH ATTRIBUTES', 0x10)], [10 * 128 + 30 * 2, withAttr('MIDDLE', 0x50)],
      [23 * 128 + 58 * 2, withAttr('CORNER', 0x10)]],
    expect: {
      lines: ['SIXTY-FOUR COLUMNS WITH ATTRIBUTES', ...blank(9), ' '.repeat(30) + 'MIDDLE', ...blank(12), ' '.repeat(58) + 'CORNER'],
      attributes: { 10: [run(0, 29, 0x10), run(30, 35, 0x50), run(36, 63, 0x10)] },
    },
  },
  {
    name: 'text 80', f98: 0x03, f99: 0x14, base: 0x70000, clear: { bytes: 80 * 24, fill: [0x20] },
    writes: range(0, 24).flatMap((r) => [[r * 80, bytes(`ROW ${two(r)} - eighty columns, no attribute bytes`)], [r * 80 + 79, bytes('#')]]),
    expect: { lines: range(0, 24).map((r) => `ROW ${two(r)} - eighty columns, no attribute bytes`.padEnd(79) + '#') },
  },
  {
    // the layout NitrOS-9 uses at 80 columns
    name: 'text 80 attr', f98: 0x03, f99: 0x15, base: 0x70000, clear: { bytes: 160 * 24, fill: [0x20, 0x08] },
    writes: [[0, withAttr('NitrOS-9 style: 80 x 24, attributes on', 0x08)], [160, withAttr('OS9: dir', 0x08)],
      [2 * 160, withAttr('Directory of .  2026/11/18 12:00', 0x08)], [23 * 160 + 74 * 2, withAttr('END.79', 0x48)]],
    expect: {
      lines: ['NitrOS-9 style: 80 x 24, attributes on', 'OS9: dir', 'Directory of .  2026/11/18 12:00', ...blank(20), ' '.repeat(74) + 'END.79'],
      attributes: { 23: [run(0, 73, 0x08), run(74, 79, 0x48)] },
    },
  },
  {
    // a video start that is not the page's: $72348 ($FF9D $E4, $FF9E $69), the CPU's $2348; the row before it is
    // filled with a decoy that must not be read
    name: 'text 80 attr start $72348', f98: 0x03, f99: 0x15, base: 0x72348, clear: { from: -160, bytes: 160 * 25, fill: [0x20, 0x08] },
    writes: [[-160, withAttr('DECOY: THE ROW BEFORE THE VIDEO START', 0x08)], [0, withAttr('START OFFSET $72348 (CPU $2348)', 0x08)],
      [23 * 160, withAttr('LAST ROW OF THE MOVED SCREEN', 0x08)]],
    expect: { lines: ['START OFFSET $72348 (CPU $2348)', ...blank(22), 'LAST ROW OF THE MOVED SCREEN'], base: 0x2348 },
  },
  {
    // scrolled by moving the video start 6 rows into 30 rows of text, with $FF9C (vertical scroll) at 5: MAME 0.264's
    // top border resets the GIME's row-line counter, so there (and here under mameCompat, which runOurs uses) it does
    // not move the rows; the machine as shipped scrolls them (tests/gime-vsc.test.js, tools/mame-diff/coco3/gen-vsc.js)
    name: 'text 80 attr scrolled', f98: 0x03, f99: 0x15, f9c: 0x05, base: 0x733C0, clear: { from: -6 * 160, bytes: 160 * 30, fill: [0x20, 0x08] },
    writes: range(0, 30).map((r) => [(r - 6) * 160, withAttr(`LINE ${two(r)} OF THE SCROLLBACK`, 0x08)]),
    expect: { lines: range(6, 24).map((r) => `LINE ${two(r)} OF THE SCROLLBACK`), base: 0x33C0 },
  },
  {
    // 200 scanlines ($FF99 bits 5-6 = 1): 25 rows of 8 lines
    name: 'text 40 attr 200 lines', f98: 0x03, f99: 0x25, base: 0x70000, clear: { bytes: 80 * 25, fill: [0x20, 0x08] },
    writes: [[0, withAttr('200 SCANLINES: 25 ROWS OF 40', 0x08)], [24 * 80, withAttr('ROW 24, THE 25TH', 0x08)]],
    expect: { lines: ['200 SCANLINES: 25 ROWS OF 40', ...blank(23), 'ROW 24, THE 25TH'] },
  },
  {
    // 225 scanlines ($FF99 bits 5-6 = 3) at 11 lines per row: 20 whole rows and a 21st of 5 lines
    name: 'text 80 attr 225 lines 11 per row', f98: 0x06, f99: 0x75, base: 0x70000, clear: { bytes: 160 * 21, fill: [0x20, 0x08] },
    writes: [[0, withAttr('225 SCANLINES, 11 PER ROW: 21 ROWS', 0x08)], [20 * 160, withAttr('ROW 20 SHOWS 5 OF ITS 11 LINES', 0x08)]],
    expect: { lines: ['225 SCANLINES, 11 PER ROW: 21 ROWS', ...blank(19), 'ROW 20 SHOWS 5 OF ITS 11 LINES'] },
  },
  {
    // $FF9F = $84: 256-byte virtual rows (HVEN), shown from byte 8 (offset 4 x 2); bytes 0-7 and 88 on are off screen.
    // The screen is a window on a wider page, so the reader gives no CPU address for it (base null)
    name: 'text 80 virtual rows offset 8', f98: 0x03, f99: 0x14, f9f: 0x84, base: 0x70000, clear: { bytes: 256 * 24, fill: [0x20] },
    writes: [0, 1, 2, 23].flatMap((r) => [[r * 256, bytes('HIDDEN!!')], [r * 256 + 8, bytes(`VIRTUAL 256-BYTE ROWS, FROM BYTE 8: ROW ${two(r)}`)],
      [r * 256 + 88, bytes('OFFRIGHT')]]),
    expect: { lines: ['VIRTUAL 256-BYTE ROWS, FROM BYTE 8: ROW 00', 'VIRTUAL 256-BYTE ROWS, FROM BYTE 8: ROW 01',
      'VIRTUAL 256-BYTE ROWS, FROM BYTE 8: ROW 02', ...blank(20), 'VIRTUAL 256-BYTE ROWS, FROM BYTE 8: ROW 23'], base: null },
  },
  {
    // $FF9F = $7C: each row's cells start 248 bytes in and wrap within its 256 bytes, so row 0 shows bytes 248-255
    // then 0-31; row 6 (240 bytes on) shows bytes 248-255 again, as its cells 16-23
    name: 'text 40 offset wraps', f98: 0x03, f99: 0x04, f9f: 0x7C, base: 0x70000, clear: { bytes: 40 * 24 + 256, fill: [0x20] },
    writes: [[248, bytes('WRAPPED:')], [0, bytes('TEXT AT THE ROW START')]],
    expect: { lines: ['WRAPPED:TEXT AT THE ROW START', '', '', '', '', '', ' '.repeat(16) + 'WRAPPED:'] },
  },
];
// the rows each screen shows (the GIME's lines per row and lines per field), stated per screen from the GIME's
// documented values, for the reader's `mode` and the pixel checks: 192 / 8 = 24 unless noted above
const ROWS = { 'text 40 attr 9 lines': 22, 'text 40 attr 200 lines': 25, 'text 80 attr 225 lines 11 per row': 21 };
for (const s of SCREENS) {
  s.f9c = s.f9c || 0; s.f9f = s.f9f || 0;
  s.expect.rows = ROWS[s.name] || 24;
  s.cols = (s.f99 & 0x10) ? ((s.f99 & 0x04) ? 80 : 64) : ((s.f99 & 0x04) ? 40 : 32);
  s.attr = !!(s.f99 & 1);
}

// ---- firmware ----
// For each screen: clear its memory, write its bytes, set its registers, then hold it for 30 fields with PHASE
// ($7F00) counting the screens, as run-vdg.js does; then the HALT loop. Palette: background 0, white text.
const PHASE = 0x7F00;
const PAL = [0, 63, 18, 36, 9, 54, 27, 45, 63, 63, 38, 52, 25, 11, 56, 7];
const hx = (v, n = 2) => '$' + v.toString(16).toUpperCase().padStart(n, '0');
function firmware() {
  const L = [];
  const e = (s) => L.push(s);
  e(`PHASE   EQU     ${hx(PHASE, 4)}`);
  e(`        ORG     $8000`);
  e(`RESET   ORCC    #$50`);
  e(`        LDS     #$7FF0`);
  e(`        CLRA`);
  e(`        TFR     A,DP`);
  // PIA1: $FF02/$FF03 as run-vdg.js sets them, so the field sync flag ($FF03 bit 7) can be waited on
  for (const s of ['CLR     $FF03', 'LDA     #$FF', 'STA     $FF02', 'LDA     #$34', 'STA     $FF03', 'CLR     $FF23',
    'LDA     #$F8', 'STA     $FF22', 'LDA     #$34', 'STA     $FF23']) e(`        ${s}`);
  e(`        CLR     $FF90`);          // GIME mode, MMU off: CPU $0000-$7FFF is physical $70000-$77FFF
  e(`        CLR     $FF9B`);
  PAL.forEach((c, i) => { e(`        LDA     #${c}`); e(`        STA     ${hx(0xFFB0 + i, 4)}`); });
  e(`        CLR     PHASE`);
  SCREENS.forEach((s, n) => {
    const cpu = (off) => (s.base - 0x70000 + off) & 0xFFFF;
    e(`* ${s.name}`);
    const from = cpu(s.clear.from || 0), to = (from + s.clear.bytes) & 0xFFFF;
    e(`        LDX     #${hx(from, 4)}`);
    if (s.clear.fill.length === 2) e(`        LDD     #${hx((s.clear.fill[0] << 8) | s.clear.fill[1], 4)}`);
    else e(`        LDA     #${hx(s.clear.fill[0])}`);
    e(`C${n}      ${s.clear.fill.length === 2 ? 'STD     ,X++' : 'STA     ,X+'}`);
    e(`        CMPX    #${hx(to, 4)}`);
    e(`        BLO     C${n}`);
    s.writes.forEach(([off, data], k) => {
      e(`        LDX     #${hx(cpu(off), 4)}`);
      e(`        LDU     #D${n}_${k}`);
      e(`        LDB     #${data.length}`);
      e(`W${n}_${k}    LDA     ,U+`);
      e(`        STA     ,X+`);
      e(`        DECB`);
      e(`        BNE     W${n}_${k}`);
    });
    const regs = [[0xFF98, s.f98], [0xFF99, s.f99], [0xFF9C, s.f9c], [0xFF9D, (s.base >> 11) & 0xFF], [0xFF9E, (s.base >> 3) & 0xFF], [0xFF9F, s.f9f]];
    for (const [a, v] of regs) { e(`        LDA     #${hx(v)}`); e(`        STA     ${hx(a, 4)}`); }
    e(`        INC     PHASE`);
    e(`        LBSR    HOLD`);
  });
  e(`        INC     PHASE`);              // one more phase, so the last screen is captured
  e(`        LBSR    HOLD`);
  e(`DONE    BRA     DONE`);
  // 30 field syncs; just after each (in the border) palette 0 is changed and put back, as run-vdg.js does, so
  // MAME redraws the whole picture rather than keeping parts of the previous screen
  e(`HOLD    LDB     #30`);
  e(`HW      LDA     $FF02`);
  e(`HW1     LDA     $FF03`);
  e(`        BPL     HW1`);
  e(`        LDA     #${PAL[0] ^ 1}`);
  e(`        STA     $FFB0`);
  e(`        LDA     #${PAL[0]}`);
  e(`        STA     $FFB0`);
  e(`        DECB`);
  e(`        BNE     HW`);
  e(`        RTS`);
  SCREENS.forEach((s, n) => s.writes.forEach(([, data], k) => {
    for (let i = 0; i < data.length; i += 16) e(`${i ? '       ' : `D${n}_${k}`.padEnd(7)} FCB     ${data.slice(i, i + 16).map((v) => hx(v)).join(',')}`);
  }));
  e(`        ORG     $FFFE`);
  e(`        FDB     RESET`);
  return '; CoCo 3 GIME text screens for the screen-text reader, generated by text-screens.js - do not edit\n' + L.join('\n') + '\n        END     RESET\n';
}

// Run the firmware on one of our machines; call back at each screen once it has been up `settle` fields (15, as
// run-vdg.js captures). onScreen(index, machine) for screens 0..N-1; returning true stops there, leaving the
// machine on that screen. Returns the number of screens seen.
function runOurs(Emu, rom, { cpu = '6809', settle = 15, onScreen }) {
  const m = Emu.createMachine('coco3', { mameCompat: true, cpu });
  m.setRoms({ basic: rom }); m.reset(true);
  let last = -1, wait = -1, seen = 0;
  for (let f = 0; f < 60 * 30 && seen < SCREENS.length; f++) {
    m.runFrame();
    const ph = m.gime.ram[(0x70000 + PHASE) & m.gime.ramMask];
    if (ph !== last) { last = ph; wait = settle; }
    if (wait > 0) wait--;
    else if (wait === 0) { wait = -1; if (ph >= 1 && ph <= SCREENS.length) { seen++; if (onScreen(ph - 1, m) === true) break; } }
  }
  return seen;
}

module.exports = { SCREENS, PHASE, firmware, runOurs, CODES_00_3F, CODES_40_7F };
