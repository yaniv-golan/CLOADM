#!/usr/bin/env node
// Generates raster.asm: mid-line video changes swept across every beam position.
//
// Our own firmware, installed in place of the BASIC ROM on the SAM machines (Dragon, CoCo 1/2/2B).
// For each case it shows a few fields in which one register is written part-way along many
// scanlines, one CPU cycle (four VDG clocks, one byte position) later on each successive line,
// so a single field holds a split at every position from before the visible area to past its end.
// The comparison (run.js --raster, lib/raster.js) captures one such field from MAME and from us and requires every
// pixel to be the same; the firmware is also run in lockstep against MAME first, so the write
// cycles are known to be identical in both emulators.
//
// Timing is anchored on the hardware, not on a cycle count from reset: PIA0 CA1 is HS, with its
// interrupt enabled and the CPU's IRQ masked, so SYNC resumes at a fixed point after each HS fall
// (the first instruction after it starts 1 cycle after the fall, measured, and identical in MAME
// because the lockstep comparison covers it). From there every instruction's cycle count is fixed,
// so a write's cycle within the line is chosen exactly by the delay before it.
//
// Two patterns per case:
//   SWEEP  every line starts in state A (restored just after the line starts, before the visible
//          area) and switches to B at cycle c, with c = 6..52 on successive lines;
//   ALT    lines alternate: one line switches A -> B at cycle c, the next B -> A at cycle c+1,
//          so lines also start in either state and SAM writes persist for a whole line.
//
// A cycle c of the line is VDG clock 4c; MAME's byte position is (4c - 25) / 4, so c = 6 is just
// before the visible area, c = 7..38 are the 32 visible positions, and c = 39..48 the positions
// 32..41 the VDG still reads on a line that had a change (mc6847.cpp caps a partial line at 42).
const fs = require('fs'), path = require('path');
const { writeAtomic } = require('../lib/firmware');

const HS_SKIP = 88;        // HS edges after FS falls before the first swept line (about active row 18)
const GAP = 6;             // HS edges between the two patterns
const FIELDS = 9;          // fields per case: STATIC plain fields, then the swept ones
const STATIC = 3;          // fields shown in the starting state before the sweep, so every pixel holds a
                           // known picture: a swept line may draw fewer than 256 pixels, and MAME's bitmap
                           // keeps there what an earlier frame drew (see MC6847.endLine)

// Cases: name, PIA1 PB at the start of the field (state A), SAM V at the start, SAM F at the
// start, and the two writes: [address, value] restoring A and [address, value] setting B; 'no effect'
// marks a case whose writes must not change the picture at all (the harness checks both ways).
const PB = 0xFF22;
const baseCases = [
  ['text -> CG1 (SAM V 0)', 0x00, 0, 2, [PB, 0x00], [PB, 0x80]],
  ['text -> CG1 (SAM V 1)', 0x00, 1, 2, [PB, 0x00], [PB, 0x80]],
  ['CG1 -> text (SAM V 1)', 0x80, 1, 2, [PB, 0x80], [PB, 0x00]],
  ['text CSS0 -> CSS1', 0x00, 0, 2, [PB, 0x00], [PB, 0x08]],
  ['text -> semigraphics 6 / T1 lowercase (INT/EXT)', 0x00, 0, 2, [PB, 0x00], [PB, 0x10]],
  ['text -> RG1 (SAM V 0)', 0x00, 0, 2, [PB, 0x00], [PB, 0x90]],
  ['RG3 -> CG6 (SAM V 5)', 0xD0, 5, 2, [PB, 0xD0], [PB, 0xE0]],
  ['CG6 -> RG3 (SAM V 6)', 0xE0, 6, 2, [PB, 0xE0], [PB, 0xD0]],
  ['CG2 CSS0 -> CSS1 (SAM V 2)', 0xA0, 2, 2, [PB, 0xA0], [PB, 0xA8]],
  ['CG3 -> RG2 (SAM V 4)', 0xC0, 4, 2, [PB, 0xC0], [PB, 0xB0]],
  ['PIA1 PB non-video bit only (text, SAM V 1)', 0x00, 1, 2, [PB, 0x00], [PB, 0x02], 'no effect'],
  ['SAM V1 set mid-line (CG1, V 1 -> 3)', 0x80, 1, 2, [0xFFC2, 0], [0xFFC3, 0]],
  ['SAM V0 set mid-line (text, V 0 -> 1)', 0x00, 0, 2, [0xFFC0, 0], [0xFFC1, 0]],
  ['SAM V2 set mid-line (RG3, V 5 -> 1)', 0xD0, 5, 2, [0xFFC5, 0], [0xFFC4, 0]],
  ['SAM F0 set mid-field (text, $0400 -> $0600)', 0x00, 0, 2, [0xFFC6, 0], [0xFFC7, 0], 'no effect'],
  // composite colour follows the mode a line begins with (MAME: m_mode[0]): NTSC artifact colours over the
  // whole of a line that begins in 256x192 and none on one that begins in four colours; PAL blending the
  // other way round
  ['RG6 CSS1 -> CG6 CSS1 (SAM V 6)', 0xF8, 6, 2, [PB, 0xF8], [PB, 0xE8]],
  ['CG6 CSS1 -> RG6 CSS1 (SAM V 6)', 0xE8, 6, 2, [PB, 0xE8], [PB, 0xF8]],
];
// A machine with a character generator wired as the Dragon 200-E's (`--chargen`, raster-chargen.asm): PB4 is not
// INT/EXT there but the generator's bank (dragon.cpp dragon200e_state::char_rom_r()), and the VDG's AS/INTEXT
// come from each byte's bit 7 (sam_read()). Two cases change:
//   5   at SAM V 0 a PB4 sweep shows nothing in MAME (it draws the bank once per field, from PB4 at the end of
//       the field, which the sweep leaves at bank 0, and a split line fetches the same bytes at V 0), so the
//       sweep runs at V 1, where each split's reads past the visible area move the SAM's counter;
//   11  MAME's driver also drives INTEXT from PB4 on every port B write (coco12_state::pia1_pb_changed()),
//       against the INTEXT its sam_read() took from the last byte fetched, so a PB1 write splits the line
//       in MAME and, at V 1, changes the picture (js/machines/sam.js: mameIntextTrack). Under mameCompat it
//       must show; on the hardware it has no effect (tests/models.test.js checks that half).
function casesFor(chargen) {
  if (!chargen) return baseCases;
  const c = baseCases.slice();
  c[4] = ['text bank 0 -> 1 (PB4 = generator bank, SAM V 1)', 0x00, 1, 2, [PB, 0x00], [PB, 0x10]];
  c[10] = ['PIA1 PB1 only (text, SAM V 1): splits in MAME via INTEXT', 0x00, 1, 2, [PB, 0x00], [PB, 0x02]];
  return c;
}
const chargen = process.argv.includes('--chargen');
const cases = casesFor(chargen);

const L = [];
const emit = (s) => L.push(s);
// a delay of exactly n cycles (n = 0 or n >= 2): NOP is 2 cycles, BRN 3
function delay(n) {
  if (n === 1 || n < 0) throw new Error(`cannot delay ${n} cycles`);
  if (n % 2) { emit('        BRN     *'); n -= 3; }
  for (; n > 0; n -= 2) emit('        NOP');
}

// The RAM addresses the firmware uses. raster.asm needs 8K of display data ($0000-$1FFF), so it can only
// run on a machine with at least 8K: below 32K the phase and field counters and the stack are lowered into
// the fitted RAM (`ramK` from `--ram-k=N`). The default, 64, is the layout every existing comparison uses.
const ramK = +(process.argv.find((a) => /^--ram-k=/.test(a)) || '').split('=')[1] || 64;
const TOP = ramK >= 32 ? 0x7F00 : (ramK * 1024) & ~1;
const PH = ramK >= 32 ? 0x7000 : 0x0800;
const DISP_END = Math.min(0x2000, ramK >= 8 ? ramK * 1024 : 0x2000);
const H = (n) => '$' + n.toString(16).toUpperCase().padStart(4, '0');

emit(`; GENERATED by gen-raster.js - do not edit. Mid-line video changes swept across the beam.
PHASE   EQU     ${H(PH)}
FIELDN  EQU     ${H(PH + 1)}
        ORG     $8000
RESET   ORCC    #$50            ; IRQ and FIRQ masked: SYNC resumes without taking the interrupt
        LDS     #${H(TOP)}
        STA     $FFDD           ; SAM M1=1: 64K RAM, as the BASIC ROMs set it
        ; display data over $0000-$1FFF: (low * 7) xor (high * 37), so every row, column and
        ; page differs and every character, semigraphics block and pixel pattern occurs
        LDX     #$0000
GX      TFR     X,D
        PSHS    A
        LDA     #7
        MUL
        PSHS    B
        LDA     1,S
        LDB     #37
        MUL
        EORB    ,S+
        LEAS    1,S
        STB     ,X+
        CMPX    #${H(DISP_END)}
        BLO     GX
        LDA     #$FF
        TFR     A,DP
        SETDP   $FF
        ; PIA0: CA1 = HS with its interrupt enabled (falling edge), CB1 = FS flag only. Port B
        ; (the keyboard column strobes) is set to outputs, all high, as the BASIC ROMs do, so
        ; reading it to clear the FS flag returns the output latch in both emulators; port A
        ; stays inputs with no column strobed
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
        ; PIA1 PB: outputs (the VDG mode bits)
        CLR     <$23
        LDA     #$FF
        STA     <$22
        LDA     #$34
        STA     <$23
`);

// SAM register writes for a 3-bit V or 7-bit F value (even address clears, odd sets)
const samBits = (base, bits, value) => {
  for (let i = 0; i < bits; i++) emit(`        STA     <$${(base + i * 2 + ((value >> i) & 1)).toString(16).toUpperCase()}`);
};

cases.forEach(([name, pb, v, f, [ra, rv], [sa, sv]], i) => {
  const ph = i + 1;
  emit(`; ---- case ${ph}: ${name}`);
  emit(`        LDA     #${ph}`);
  emit('        STA     PHASE');
  emit(`        LDA     #${FIELDS}`);
  emit('        STA     FIELDN');
  emit(`C${ph}F    LDA     <$03            ; wait for FS to fall (end of the active area)`);
  emit(`        BPL     C${ph}F`);
  emit('        LDA     <$02');
  // the field's starting state, set in the bottom border (before FS rises and reloads the counter)
  emit(`        LDA     #$${pb.toString(16).toUpperCase()}`);
  emit('        STA     <$22');
  samBits(0xC0, 3, v);
  samBits(0xC6, 7, f);
  emit('        LDA     FIELDN');
  emit(`        CMPA    #${FIELDS - STATIC}`);
  emit(`        BLS     C${ph}W`);
  // a lead-in field: the first display byte alternates, so every lead-in field is a changed picture
  // and MAME redraws (and so fills) both of its screen bitmaps
  emit('        ANDA    #1');
  emit('        STA     $0400');
  emit(`        BRA     C${ph}D`);
  emit(`C${ph}W    LDX     #$${ra.toString(16).toUpperCase()}`);
  emit(`        LDA     #$${rv.toString(16).toUpperCase()}`);
  emit(`        LDY     #$${sa.toString(16).toUpperCase()}`);
  emit(`        LDB     #$${sv.toString(16).toUpperCase()}`);
  emit(`        JSR     FIELD`);
  emit(`C${ph}D    DEC     FIELDN`);
  emit(`        BNE     C${ph}F`);
});
emit(`        LDA     #$FF
        STA     PHASE
HALT    BRA     HALT
`);

// FIELD: one field of both patterns. X/A restore state A, Y/B set state B.
emit(`; ---- FIELD: skip to the first swept line, then SWEEP and ALT
FIELD   TST     <$00            ; clear an HS flag left from before
        PSHS    X
        LDX     #${HS_SKIP}
SKIP    SYNC
        TST     <$00
        LEAX    -1,X
        BNE     SKIP
        PULS    X`);
// SWEEP: line k restores A, then sets B at cycle c (the first instruction after SYNC starts at
// cycle 54 of the previous line, i.e. 3 cycles before this line; a store's write is its last cycle).
//   early form  SYNC; D(p); STA ,X; D(e); STB ,Y; TST   -> restore at cycle p, set at 4+p+e
//   late form   SYNC; D(p); STA ,X; TST; D(e); STB ,Y   -> set at 10+p+e (TST before the late set,
//               so it never clears the flag of this line's own HS fall at cycle 53)
emit('; SWEEP: every line starts in A and switches to B one cycle later than the line before');
for (let c = 6; c <= 52; c++) {
  emit(`        SYNC                    ; set at cycle ${c}`);
  if (c <= 45) {
    const p = (c % 2) ? 3 : 2, e = c - 4 - p;   // e is even and >= 0
    delay(p); emit('        STA     ,X'); delay(e); emit('        STB     ,Y'); emit('        TST     <$00');
  } else {
    const p = (c % 2) ? 3 : 2, e = c - 10 - p;
    delay(p); emit('        STA     ,X'); emit('        TST     <$00'); delay(e); emit('        STB     ,Y');
  }
}
// restore A before the gap so ALT starts from it
emit('        SYNC');
emit('        NOP');
emit('        STA     ,X');
emit('        TST     <$00');
emit(`        PSHS    X
        LDX     #${GAP}
GAPL    SYNC
        TST     <$00
        LEAX    -1,X
        BNE     GAPL
        PULS    X`);
// ALT: line pairs; the first line of a pair sets B at cycle c, the second restores A at cycle c+1.
//   early form  SYNC; D(q); STx; TST   -> write at cycle q (q >= 2)
//   late form   SYNC; TST; D(q); STx   -> write at cycle 6+q
emit('; ALT: lines alternate between switching to B and back to A, one cycle later each line');
for (let c = 2, k = 0; c <= 52; c++, k++) {
  const st = (k % 2) ? '        STA     ,X' : '        STB     ,Y';
  emit(`        SYNC                    ; ${k % 2 ? 'restore' : 'set'} at cycle ${c}`);
  if (c <= 45) { delay(c); emit(st); emit('        TST     <$00'); }
  else { emit('        TST     <$00'); delay(c - 6); emit(st); }
}
emit(`        SYNC
        NOP
        STA     ,X              ; leave the field in state A
        TST     <$00
        RTS

; interrupt vectors: never taken (IRQ and FIRQ stay masked), but defined
SWIH    RTI
        ORG     $BFF2
        FDB     SWIH,SWIH,SWIH,SWIH,SWIH,SWIH
        ORG     $BFFE
        FDB     RESET
        END     RESET`);

// write raster.asm (run as a script, or from spec.raster before a MAME comparison)
function write() {
  const file = chargen ? (ramK === 64 ? 'raster-chargen.asm' : null) : ramK === 64 ? 'raster.asm' : `raster-${ramK}k.asm`;
  if (!file) throw new Error('--chargen is laid out for 64K only');
  writeAtomic(path.join(__dirname, file), L.join('\n') + '\n');
}
if (require.main === module) write();
const caseList = (list) => list.map(([name, , , , , , effect], i) => ({ name, phase: i + 1, noEffect: effect === 'no effect' }));
module.exports = { cases: caseList(cases), chargenCases: caseList(casesFor(true)), FIELDS, LEAD_IN: STATIC, write, PHASE: PH, FIELD: PH + 1 };
