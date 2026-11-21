#!/usr/bin/env node
// Generates vsc.asm for the CoCo 3: the GIME's vertical fine scroll register $FF9C (VSC, bits 0-3) in the GIME
// (native) modes. Our own firmware, installed in place of coco3.rom; run.js coco3 --vsc runs it in lockstep with
// MAME 0.264 to HALT and compares a field of every case pixel by pixel (lib/raster.js), then checks our hardware
// model of the scroll against MAME's own pictures (spec.js vsc).
//
// Each case puts up one GIME mode - text with attributes at 8, 9, 10 and 11 lines a row, 320x192x16 graphics at 1,
// 2, 8, 11 and "endless" lines a row, the 200- and 225-line resolutions - shows STATIC lead-in fields with VSC 0, then
// fields with VSC set to the case's value, written in the bottom border just after field sync falls (so the field
// that follows starts with it). Two cases write VSC part-way through each field instead and clear it again in the
// bottom border: in the top border, before the body starts, and in the middle of the body. The screen holds only
// blank characters ($20) with a different attribute byte in each cell, so in text the fonts never show (ours is
// our own design) and every pixel is compared exactly; in graphics the same bytes make a pattern in which every row
// differs.
//
// Sources for the scroll (cited in js/chips/gime.js vscLine and docs/verification.md): Sock Master's GIME reference,
// "FF9C Vertical scroll register - VSC"; the CoCo 3 Service Manual, section 1.5; Super Extended BASIC Unravelled II,
// ch. 5; Tepolt, Assembly Language Programming for the CoCo3 (1987), pp25, 29-30.
const path = require('path');
const { writeAtomic } = require('../lib/firmware');

// Fields per case: STATIC lead-in fields with VSC 0, then the case's fields. The field counter counts down from
// FIELDS; a register written in the bottom border shows in the picture two counts later (it is latched at the next
// field's start, and that field is the one finished two counts on), so the lead-in field compared (PLAIN, the last)
// no longer shows the previous case's scroll, and the case's field compared (lib/raster.js CAPTURE, count 3) shows
// the value written at count 5.
const FIELDS = 9;
const STATIC = 4;
const PLAIN = FIELDS - STATIC + 1;
const TOP_SKIP = 26;       // HS edges after FS falls: line 7 of the next field's top border (newFrame at FS + 18)
const MID_SKIP = 120;      // ... line 101, the middle of the body

// modes: [name, $FF98, $FF99]. Attribute text has 2 bytes a cell; 320x192x16 has 160 bytes a row.
const T40_8 = ['text 40 attr, 8 lines', 0x03, 0x05];
const MODES = {
  T40_8, T80_9: ['text 80 attr, 9 lines', 0x04, 0x15], T64_10: ['text 64 attr, 10 lines', 0x05, 0x11],
  T32_11: ['text 32 attr, 11 lines', 0x06, 0x01],
  T40_8_200: ['text 40 attr, 8 lines, 200 lines', 0x03, 0x25], T40_8_225: ['text 40 attr, 8 lines, 225 lines', 0x03, 0x65],
  G1: ['320x192x16, 1 line (LPR 0)', 0x80, 0x1E], G1B: ['320x192x16, 1 line (LPR 1)', 0x81, 0x1E],
  G2: ['320x192x16, 2 lines', 0x82, 0x1E], G8: ['320x192x16, 8 lines', 0x83, 0x1E], G11: ['320x192x16, 11 lines', 0x86, 0x1E],
  G7: ['320x192x16, LPR 7 (endless row)', 0x87, 0x1E],
};
// cases: [mode, VSC, when] - when: 'border' (the usual: set in the bottom border, held), 'top' or 'mid' (set part-way
// through every field, cleared in the bottom border)
const cases = [];
for (let v = 0; v < 16; v++) cases.push([MODES.T40_8, v, 'border']);
for (const v of [1, 4, 8, 9, 15]) cases.push([MODES.T80_9, v, 'border']);
for (const v of [1, 9, 10]) cases.push([MODES.T64_10, v, 'border']);
for (const v of [1, 10, 11]) cases.push([MODES.T32_11, v, 'border']);
cases.push([MODES.T40_8_200, 3, 'border'], [MODES.T40_8_225, 5, 'border']);
for (const v of [1, 15]) cases.push([MODES.G1, v, 'border']);
cases.push([MODES.G1B, 1, 'border']);
for (let v = 0; v < 16; v++) cases.push([MODES.G2, v, 'border']);
for (const v of [1, 3, 7, 8, 15]) cases.push([MODES.G8, v, 'border']);
for (const v of [10, 11]) cases.push([MODES.G11, v, 'border']);
for (const v of [1, 15]) cases.push([MODES.G7, v, 'border']);
cases.push([MODES.T40_8, 5, 'top'], [MODES.T40_8, 5, 'mid'], [MODES.G8, 5, 'top']);

// The cases are split into PARTS firmware files (vsc-1.asm ...), each run from reset on its own: MAME 0.264's 6809
// runs on a whole-Hz clock (894886 Hz, XTAL / 32 rounded down), 0.38 ppm slower than its GIME's video timing, so an
// HS edge reaches its CPU one cycle earlier every 2.6 million cycles, which our mameCompat CoCo 3 does not model. A
// part ends well within the first 2.6 million cycles after reset, where the two agree to the cycle.
const PER_PART = 13;
const PARTS = Math.ceil(cases.length / PER_PART);

const PALETTE = [3, 8, 13, 18, 23, 28, 33, 38, 43, 48, 53, 58, 63, 4, 9, 14];
const hx = (v) => '$' + v.toString(16).toUpperCase();

// the firmware of one part (1..PARTS): cases (part - 1) x PER_PART on, as phases 1 on
function source(part) {
  const L = [];
  const emit = (s) => L.push(s);
  const first = (part - 1) * PER_PART, mine = cases.slice(first, first + PER_PART);
  emit(`; GENERATED by gen-vsc.js - do not edit. The GIME's vertical fine scroll ($FF9C) in the native modes (CoCo 3),
; part ${part} of ${PARTS}: cases ${first + 1}-${first + mine.length}.
PHASE   EQU     $7F00
FIELDN  EQU     $7F01
SKIPN   EQU     $7F02
        ORG     $8000
RESET   ORCC    #$50            ; IRQ and FIRQ masked: SYNC resumes without taking the interrupt
        LDS     #$7FF0
        ; the screen over $0000-$7EFF (physical $70000): even bytes $20 (a blank character), odd bytes an
        ; attribute with blink clear, 37 x (the cell number) & $7F, so every cell differs from its neighbours and
        ; every row (40, 64 or 80 cells; 160 bytes of graphics) from the rows next to it
        LDX     #$0000
        LDD     #$2000
GX      STD     ,X++
        ADDB    #37
        ANDB    #$7F
        CMPX    #$7F00
        BLO     GX
        LDA     #$FF
        TFR     A,DP
        SETDP   $FF
        ; PIA0: CA1 = HS with its flag (falling edge), CB1 = FS flag only; port B outputs, all high
        CLR     <$01
        CLR     <$03
        CLR     <$00
        LDA     #$FF
        STA     <$02
        LDA     #$34
        STA     <$03
        LDA     #$FF
        STA     <$02
        LDA     #$35
        STA     <$01
        LDA     #$34
        STA     <$03
        ; GIME mode, MMU off; the display starts at physical $70000 (CPU $0000); border; the palette
        CLR     <$90
        LDA     #$E0
        STA     <$9D
        CLR     <$9E
        CLR     <$9F
        LDA     #$2A
        STA     <$9A
        LDX     #PAL
        LDU     #$FFB0
PL      LDA     ,X+
        STA     ,U+
        CMPU    #$FFC0
        BNE     PL
`);

  mine.forEach(([[, f98, f99], vsc, when], i) => {
    const ph = i + 1;
    emit(`; ---- phase ${ph}, case ${first + ph}: ${caseName(first + i)}`);
    emit(`        LDA     #${ph}`);
    emit('        STA     PHASE');
    emit(`        LDA     #${FIELDS}`);
    emit('        STA     FIELDN');
    // wait for FS to fall (the end of the active area), testing its flag once a line, just after HS: the test never
    // lands on the cycle the flag is set (a free-running poll drifts across the line from field to field)
    emit(`C${ph}F    TST     <$00            ; clear an HS flag left from before`);
    emit(`C${ph}S    SYNC`);
    emit('        TST     <$00');
    emit('        LDA     <$03');
    emit(`        BPL     C${ph}S`);
    emit('        LDA     <$02');
    emit(`        LDA     #${hx(f98)}`);
    emit('        STA     <$98');
    emit(`        LDA     #${hx(f99)}`);
    emit('        STA     <$99');
    emit('        CLR     <$9C            ; VSC 0 in the bottom border');
    emit('        LDA     FIELDN');
    emit(`        CMPA    #${FIELDS - STATIC}`);
    emit(`        BLS     C${ph}W`);
    // a lead-in field: the first cell's attribute alternates (its background), so every lead-in field is a changed
    // picture and MAME redraws (and so fills) both of its screen bitmaps
    emit('        ANDA    #1');
    emit('        STA     $0001');
    emit(`        BRA     C${ph}D`);
    emit(`C${ph}W    LDA     #${vsc}`);
    if (when === 'border') emit('        STA     <$9C            ; held: the next field starts with it');
    else {
      emit(`        LDX     #${when === 'top' ? TOP_SKIP : MID_SKIP}`);
      emit(`        JSR     LATE            ; written at ${when === 'top' ? 'line 7, in the top border' : 'line 101, in the body'}`);
    }
    emit(`C${ph}D    DEC     FIELDN`);
    emit(`        BNE     C${ph}F`);
  });
  emit(`        LDA     #$FF
        STA     PHASE
HALT    BRA     HALT

; LATE: wait X HS edges, then write A to $FF9C
LATE    TST     <$00            ; clear an HS flag left from before
LW      SYNC
        TST     <$00
        LEAX    -1,X
        BNE     LW
        STA     <$9C
        RTS

PAL     FCB     ${PALETTE.join(',')}
; interrupt vectors: never taken (IRQ and FIRQ stay masked), but defined
SWIH    RTI
        ORG     $FFF2
        FDB     SWIH,SWIH,SWIH,SWIH,SWIH,SWIH
        ORG     $FFFE
        FDB     RESET
        END     RESET`);
  return L.join('\n') + '\n';
}

function caseName(i) {
  const [[name], vsc, when] = cases[i];
  return `${name}, VSC ${vsc}${when === 'border' ? '' : when === 'top' ? ', written in the top border' : ', written mid-body'}`;
}
const file = (part) => `vsc-${part}.asm`;
// write vsc-1.asm ... (run as a script, or from spec.vsc before a MAME comparison)
function write() { for (let p = 1; p <= PARTS; p++) writeAtomic(path.join(__dirname, file(p)), source(p)); }
if (require.main === module) write();
// the cases of one part, by phase. Every case: MAME 0.264 never scrolls (gime.cpp record_border_scanline), so
// under mameCompat no case may change the picture; f98/f99/vsc/when let spec.js work out what our hardware model
// shows.
const partCases = (part) => cases.slice((part - 1) * PER_PART, part * PER_PART)
  .map(([[, f98, f99], vsc, when], i) => ({ name: caseName((part - 1) * PER_PART + i), phase: i + 1, noEffect: true, f98, f99, vsc, when }));
module.exports = { PARTS, file, partCases, FIELDS, STATIC, PLAIN, write };
