// Generates the Hi-Res joystick interface diagnostic firmware (our own code, 16K, installed in place of the
// BASIC ROMs): hires.asm for the Tandy interface and hires-max3.asm for the CoCo Max 3 one. Each measures how
// long its interface takes to fire for a stick position, on both axes, and records the loop counts for the
// comparison with MAME (tools/mame-diff/sam/run-hires.js). See the firmware's own header for the circuits.
//
// One interface per build: only one can be fitted in the port the firmware drives.
//   node tools/mame-diff/sam/gen-hires.js tandy|max3
const path = require('path');
const { writeAtomic } = require('../lib/firmware');

const kind = ['max3', 'rat'].includes(process.argv[2]) ? process.argv[2] : 'tandy';
const outFile = kind === 'max3' ? 'hires-max3.asm' : kind === 'rat' ? 'hires-rat.asm' : 'hires.asm';
const L = [];
const e = (s) => L.push(s);
const hex2 = (v) => '$' + v.toString(16).toUpperCase().padStart(2, '0');

e(`* Hi-Res joystick interface diagnostic (tools/mame-diff, written for CLOADM).
*
* The ${kind === 'max3' ? 'CoCo Max 3' : 'Tandy Hi-Res Joystick'} interface replaces the joystick in a controller port. Instead of
* the DAC comparator it runs a one-shot whose time is proportional to the stick's position, and the machine
* sees its state as JOYIN (PIA0 PA7): low while the one-shot runs, high when it has expired (MAME 0.264
* poll_joystick: high when the timer's remaining time is zero). This firmware measures that time by counting
* a fixed-length loop until JOYIN rises, on both axes, and stores the counts at RES. The comparison runs
* MAME with the same interface selected and the same stick positions and requires the same counts.
*
* This build measures the ${kind === 'max3' ? 'CoCo Max 3' : 'Tandy'} interface: ${kind === 'max3'
  ? 'started by PIA0 PA2 (right port) going low, and it fires after 380 + 2885 x position microseconds'
  : 'started by the DAC (PIA1 PA2-PA7) falling below $20, and it fires after 535 + 5850 x position\n* microseconds'}.
* The axis is PIA0 CA2 (X when low, Y when high) and the port PIA0 CB2 (right when low, left when high:
* MAME's sel2() true selects the second joystick, and its first is the right port's).
*
* A sample stops the one-shot first, waits for it to reset, starts it, and counts until JOYIN rises. The
* stick positions are MAME's joystick input ports, set by the run script; the firmware does not touch them.
PHASE   EQU     $0100
RESPT   EQU     $0102           ; where the next 16-bit sample goes
RES     EQU     $0110           ; ten 16-bit samples
N       EQU     2               ; loop iterations between two JOYIN polls (the same in both emulators)
        ORG     $8000
RESET   ORCC    #$50
        LDS     #$7F00
        CLRA
        TFR     A,DP
        LDX     #$0000
CLR     CLR     ,X+
        CMPX    #$0400
        BNE     CLR
        CLR     $FF01           ; PIA0: DDRs first
        LDA     #$04
        STA     $FF00           ; PA2 only: it drives the CoCo Max 3 one-shot, and PA7 (JOYIN) stays an input
        LDA     #$FF
        STA     $FF02           ; PB: the keyboard columns are inputs
        LDA     #$3C           ; CRA: CA2 output, manual, low
        STA     $FF01
        LDA     #$3C           ; CRB: CB2 output, manual, low
        STA     $FF03
        CLR     $FF21           ; PIA1 CRA: after a reset CR bit 2 selects the DDR...
        LDA     #$FF
        STA     $FF20           ; ...so DDR: the DAC is all output
        LDA     #$34
        STA     $FF21           ; CRA: the data register now (C2 manual, high)
        LDX     #RES
        STX     RESPT`);

// the port and axis: the right port, the X axis, then the Y axis (the stick position is MAME's to set)
e(`        LDA     #$34           ; CB2 low: right port
        STA     $FF03
        LDA     #$34           ; CA2 low: X axis
        STA     $FF01`);
const sample = () => {
  if (kind === 'max3') {
    // PA2 high stops the one-shot and low starts it; the DAC stays at $20 so a Tandy circuit would be idle
    e('        LDA     #$FC');
    e('        STA     $FF00           ; PA2 high: stop the one-shot');
    e('        LBSR    SETTLE');
    e('        LDA     #$F8');
    e('        STA     $FF00           ; PA2 low: start it');
  } else {
    e('        LDA     #$80');
    e('        STA     $FF20           ; DAC $20: the one-shot is stopped (the DAC is PIA1 PA2-PA7)');
    e('        LBSR    SETTLE');
    e('        LDA     #$00');
    e('        STA     $FF20           ; DAC below $20: start it');
  }
  e('        LBSR    MEASURE');
};
if (kind === 'max3') { e('        LDA     #$80'); e('        STA     $FF20           ; DAC $20: a Tandy circuit would be idle'); }
if (kind === 'rat') {
  // "The Rat": a comparator against MAME's joy_rat_table (coco.cpp poll_joystick). The mouse's position is
  // MAME's (set from its Lua), so this sweeps the DAC and records JOYIN at each step: the four table values
  // show up as the DAC values where JOYIN changes. The mouse does not move while the firmware runs.
  e(`        LDA     #$3C           ; CA2 high: the Y axis
        STA     $FF01
        LDA     #$34           ; CB2 low: the right port, where the Rat is fitted
        STA     $FF03`);
  for (let dac = 0; dac <= 63; dac++) {
    e(`        LDA     #$${((dac << 2) & 0xFF).toString(16).toUpperCase().padStart(2, '0')}`);
    e('        STA     $FF20           ; DAC value in PIA1 PA2-PA7');
    e('        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value');
    e('        ANDA    #$80');
    e('        LSRA                    ; bit 7 into bit 0');
    e('        LSRA'); e('        LSRA'); e('        LSRA'); e('        LSRA'); e('        LSRA'); e('        LSRA');
    e('        STA     ,X+             ; one byte per DAC step');
  }
} else {
  for (let i = 0; i < 5; i++) sample();
  e(`        LDA     #$3C           ; CA2 high: Y axis
        STA     $FF01`);
  for (let i = 0; i < 5; i++) sample();
}
e(`        LDA     #$0A
        STA     PHASE           ; phase 10: every sample recorded
        JMP     HALT`);

e(`* Count N-iteration loops until JOYIN rises, in X (16-bit; $FFFF means it never rose). The result goes to
* the pointer in RESPT, which moves on by two, so the caller keeps no state of its own.
MEASURE LDX     #0
M1      LEAX    1,X
        CMPX    #$FFFF
        BEQ     M1DONE          ; counted to the sentinel without seeing JOYIN
        LDY     #N
M2      LEAY    -1,Y
        BNE     M2
        LDA     $FF00
        BPL     M1              ; PA7 low: still running
M1DONE  TFR     X,D             ; the count in D
        LDX     RESPT
        STD     ,X++
        STX     RESPT
        RTS`);
e(`* Let a stopped one-shot reset (its reset time is not part of the measurement)
SETTLE  PSHS    Y
        LDY     #300
S1      LEAY    -1,Y
        BNE     S1
        PULS    Y,PC`);
e(`HALT    BRA     HALT`);
e(`        ORG     $BFF0
        FDB     RESET,RESET,RESET,RESET,RESET,RESET,RESET,RESET
        END     RESET`);

const out = path.join(__dirname, outFile);
writeAtomic(out, L.join('\n') + '\n');
console.log(`wrote ${out} (${L.length} lines, ${kind})`);
