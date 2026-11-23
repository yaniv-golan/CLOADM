// The Dragon 64 Plus's 80-column screens: what the screen-text reader (js/claude/readtools.js screen_text) must
// return for each HD6845S set-up, and the firmware that puts those screens up (plustext.asm, which this file writes
// when run: `node tools/mame-diff/d64plus/text-screens.js`). Used by spec.js plusText() (the lockstep with MAME,
// `node tools/mame-diff/run.js d64plus --plustext`, and the regression gate), by run-text.js (the pixel comparison,
// `node tools/mame-diff/run.js d64plus --plustext --video`) and by tests/d64plus-screen-text.test.js.
//
// The expectations are written here by hand from the HD6845S's documented addressing, never by running the reader:
// each screen gives its registers (R1 horizontal displayed, R6 vertical displayed, R9 maximum raster address, R12/R13
// the start address), the bytes the firmware writes into the 2K video RAM (at video RAM offsets; the board decodes
// MA's low 11 bits), and, separately, the literal rows a person sees (`lines`, trailing blanks trimmed and trailing
// blank rows left out, as screen_text returns them) and how many rows the screen shows (`rows`).
//
// Every screen clears the whole 2K to spaces first, so what a screen shows depends only on its own writes. Text the
// start address skips is written too (`NOT SHOWN ...`), so a reader that ignored R12/R13 would print it.

// the bytes of a string: one per character, its ASCII code
const bytes = (s) => Array.from(s, (c) => c.charCodeAt(0));
const blank = (n) => new Array(n).fill('');
const sp = (n) => ' '.repeat(n);

// The base set-up is plus.asm's (MAME's plus_screen geometry): R0 113, R2 96, R3 $0F, R4 25, R5 4, R7 24, R8 0,
// R10 $20 (bits 6-5 = 01: no cursor, MC6845 data sheet's cursor control table), R11 11, R14/R15 $3FFF.
// Each screen then sets R1, R6, R9 and R12/R13.
const SCREENS = [
  {
    name: '80 columns from $0000', r1: 80, r6: 22, r9: 11, start: 0x0000,
    writes: [[0, bytes('CLOADM DRAGON 64 PLUS: 80 COLUMNS, HD6845S')], [80 + 10, bytes('lower case abc xyz {|}~')],
      [10 * 80, bytes('0123456789'.repeat(8))], [21 * 80, bytes('LAST ROW')], [21 * 80 + 79, bytes('!')]],
    expect: {
      rows: 22,
      lines: ['CLOADM DRAGON 64 PLUS: 80 COLUMNS, HD6845S', '          lower case abc xyz {|}~', ...blank(8),
        '01234567890123456789012345678901234567890123456789012345678901234567890123456789', ...blank(10),
        'LAST ROW                                                                       !'],
    },
  },
  {
    // R1 = 40: rows are 40 codes apart; the start skips the first 256 bytes
    name: '40 columns from $0100', r1: 40, r6: 22, r9: 11, start: 0x0100,
    writes: [[0, bytes('NOT SHOWN: BEFORE THE START ADDRESS')], [0x100, bytes('FORTY COLUMNS FROM $0100')],
      [0x100 + 5 * 40 + 2, bytes('ROW FIVE')], [0x100 + 21 * 40, bytes('ROW 21')], [0x100 + 21 * 40 + 39, bytes('Z')],
      [0x100 + 22 * 40, bytes('NOT SHOWN: PAST THE LAST ROW')]],
    expect: {
      rows: 22,
      lines: ['FORTY COLUMNS FROM $0100', '', '', '', '', '  ROW FIVE', ...blank(15), 'ROW 21                                 Z'],
    },
  },
  {
    // scrolled: the start moves three rows of 80 down the video RAM
    name: 'scrolled by three rows', r1: 80, r6: 22, r9: 11, start: 240,
    writes: [[0, bytes('NOT SHOWN: SCROLLED OFF THE TOP')], [160, bytes('NOT SHOWN: THE ROW ABOVE')],
      [240, bytes('FIRST ROW AFTER THE SCROLL')], [240 + 80, bytes('SECOND')], [240 + 21 * 80, bytes('BOTTOM ROW')]],
    expect: { rows: 22, lines: ['FIRST ROW AFTER THE SCROLL', 'SECOND', ...blank(19), 'BOTTOM ROW'] },
  },
  {
    // the 2K wraps: row 0 starts at $7C0, so its columns 0-63 are $7C0-$7FF and 64-79 are $000-$00F
    name: 'wrapping at 2K', r1: 80, r6: 22, r9: 11, start: 0x07C0,
    writes: [[0x7C0, bytes('ROW 0 STARTS AT $07C0')], [0x7FB, bytes('WRAP>')], [0x000, bytes('<AROUND')],
      [0x010, bytes('ROW 1 IS AT $0010')], [0x650, bytes('ROW 21 IS AT $0650')]],
    expect: {
      rows: 22,
      lines: ['ROW 0 STARTS AT $07C0                                      WRAP><AROUND', 'ROW 1 IS AT $0010', ...blank(19), 'ROW 21 IS AT $0650'],
    },
  },
  {
    // a 14-bit start address: the video RAM sees MA's low 11 bits, so $2850 shows from $050
    name: 'start $2850 mirrors $0050', r1: 80, r6: 22, r9: 11, start: 0x2850,
    writes: [[0x000, bytes('NOT SHOWN: ROW 0 OF THE 2K')], [0x050, bytes('START $2850 SHOWS $0050')], [0x050 + 21 * 80, bytes('END')]],
    expect: { rows: 22, lines: ['START $2850 SHOWS $0050', ...blank(20), 'END'] },
  },
  {
    // 64 columns, 20 rows of 13 raster lines (R9 = 12): 260 of the picture's 264 lines
    name: '64 columns, 20 rows of 13 lines', r1: 64, r6: 20, r9: 12, start: 0x0000,
    writes: [[0, bytes('SIXTY-FOUR COLUMNS, 13 LINES A ROW')], [19 * 64, bytes('ROW 19 OF 20')], [19 * 64 + 63, bytes('#')],
      [20 * 64, bytes('NOT SHOWN: ROW 20')]],
    expect: { rows: 20, lines: ['SIXTY-FOUR COLUMNS, 13 LINES A ROW', ...blank(18), 'ROW 19 OF 20                                                   #'] },
  },
];
// The last phase puts text on the MC6847 screen ($0400, the standard bank) and leaves the CRTC as the last screen
// set it: the reader on the VDG view reads this, on the 80-column view the last screen.
const VDG_TEXT = 'VDG SCREEN AGAIN';
const VDG_EXPECT = [VDG_TEXT];

const PHASE = 0x3F00;          // standard RAM, outside the video RAM window: the screen number shown (1..N, N+1 VDG)
const FIELDS = 10;             // field syncs each screen is held for
// CRTC R0-R15 before the first screen: plus.asm's geometry with the cursor off (R10 = $20: blink mode 01, no cursor)
const BASE_REGS = [0x71, 0x50, 0x60, 0x0F, 0x19, 0x04, 0x16, 0x18, 0x00, 0x0B, 0x20, 0x0B, 0x00, 0x00, 0x3F, 0xFF];

const hx = (v, n = 2) => '$' + v.toString(16).toUpperCase().padStart(n, '0');
function firmware() {
  const L = [];
  const e = (s) => L.push(s);
  const reg = (r, v) => { e(`        LDA     #${r}`); e('        STA     $FFE0'); e(`        LDA     #${hx(v)}`); e('        STA     $FFE1'); };
  e(`PHASE   EQU     ${hx(PHASE, 4)}`);
  e('        ORG     $8000');
  e('RESET   ORCC    #$50');
  e('        LDS     #$7F00');
  e('        CLRA');
  e('        TFR     A,DP');
  e('        STA     $FFDD           ; SAM M1=1: 64K dynamic RAM');
  e('        STA     $FFE2           ; the standard bank');
  // PIA0 port B as outputs, CB1 (field sync) on the rising edge, as plus.asm: the flag is $FF03 bit 7
  for (const s of ['CLR     $FF03', 'LDA     #$FF', 'STA     $FF02', 'LDA     #$36', 'STA     $FF03', 'LDA     $FF02',
    // PIA1 port B outputs and 0: the VDG in its text mode
    'CLR     $FF23', 'LDA     #$F8', 'STA     $FF22', 'LDA     #$34', 'STA     $FF23', 'CLR     $FF22']) e(`        ${s}`);
  e('        CLR     PHASE');
  BASE_REGS.forEach((v, r) => reg(r, v));
  SCREENS.forEach((s, n) => {
    e(`* ${s.name}`);
    e('        LDA     #$01');
    e('        STA     $FFE2           ; the video RAM over $0000-$07FF');
    e('        LDX     #$0000');
    e('        LDA     #$20');
    e(`C${n}      STA     ,X+`);
    e('        CMPX    #$0800');
    e(`        BNE     C${n}`);
    s.writes.forEach(([off, data], k) => {
      if (off + data.length > 0x800) throw new Error(`${s.name}: a write may not cross the end of the 2K`);
      e(`        LDX     #${hx(off, 4)}`);
      e(`        LDU     #D${n}_${k}`);
      e(`        LDB     #${data.length}`);
      e(`W${n}_${k}    LDA     ,U+`);
      e('        STA     ,X+');
      e('        DECB');
      e(`        BNE     W${n}_${k}`);
    });
    e('        CLR     $FFE2           ; the standard bank again');
    reg(1, s.r1); reg(6, s.r6); reg(9, s.r9); reg(12, s.start >> 8); reg(13, s.start & 0xFF);
    e('        INC     PHASE');
    e('        LBSR    HOLD');
  });
  e('* the MC6847 screen: text at $0400, the SAM showing it (F1: $0400)');
  e('        STA     $FFC9');
  e('        LDX     #$0400');
  e('        LDA     #$20');
  e('CV      STA     ,X+');
  e('        CMPX    #$0600');
  e('        BNE     CV');
  e('        LDX     #$0400');
  e('        LDU     #DVDG');
  e(`        LDB     #${VDG_TEXT.length}`);
  e('WV      LDA     ,U+');
  e('        STA     ,X+');
  e('        DECB');
  e('        BNE     WV');
  e('        INC     PHASE');
  e('        LBSR    HOLD');
  e('HALT    BRA     HALT');
  e(`HOLD    LDB     #${FIELDS}`);
  e('HW      LDA     $FF02           ; clear the field-sync flag');
  e('HW1     LDA     $FF03');
  e('        BPL     HW1');
  e('        DECB');
  e('        BNE     HW');
  e('        RTS');
  const data = (label, d) => { for (let i = 0; i < d.length; i += 16) e(`${i ? '       ' : label.padEnd(7)} FCB     ${d.slice(i, i + 16).map((v) => hx(v)).join(',')}`); };
  SCREENS.forEach((s, n) => s.writes.forEach(([, d], k) => data(`D${n}_${k}`, d)));
  data('DVDG', bytes(VDG_TEXT));
  e('        ORG     $BFF2');
  e('        FDB     HALT,HALT,HALT,HALT,HALT,HALT,RESET');
  return '; The Dragon 64 Plus 80-column text screens for the screen-text reader.\n'
    + '; Generated by tools/mame-diff/d64plus/text-screens.js - do not edit.\n' + L.join('\n') + '\n        END     RESET\n';
}

// The 2K video RAM a screen leaves: all spaces, then its writes. For the MAME video comparison, where 0.264 never
// lets the CPU write the video RAM (docs/verification.md, "Deviations from MAME"), so it is put there directly.
function videoRam(s) {
  const v = new Uint8Array(0x800).fill(0x20);
  for (const [off, d] of s.writes) v.set(d, off);
  return v;
}

// Run the firmware on one of our machines, calling onScreen(index, machine) once screen `index` has been up `settle`
// fields (index SCREENS.length is the VDG phase). Returning true stops there. Returns the number of phases seen.
function runOurs(m, { settle = 4, onScreen }) {
  let last = -1, wait = -1, seen = 0;
  for (let f = 0; f < 60 * 20 && seen <= SCREENS.length; f++) {
    m.runFrame();
    const ph = m.ram[PHASE];
    if (ph !== last) { last = ph; wait = settle; }
    if (wait > 0) wait--;
    else if (wait === 0) { wait = -1; if (ph >= 1 && ph <= SCREENS.length + 1) { seen++; if (onScreen(ph - 1, m) === true) break; } }
  }
  return seen;
}

module.exports = { SCREENS, VDG_TEXT, VDG_EXPECT, PHASE, FIELDS, BASE_REGS, firmware, videoRam, runOurs };
if (require.main === module) require('fs').writeFileSync(require('path').join(__dirname, 'plustext.asm'), firmware());
