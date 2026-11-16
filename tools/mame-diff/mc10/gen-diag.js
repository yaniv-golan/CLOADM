// Generates diag.asm: a 6803 diagnostic firmware (our own code, installed in place of the MC-10 ROM)
// that exercises the instruction set and the MC-10 hardware so that instruction traces can be
// compared between this emulator and MAME's mc10 driver (node tools/mame-diff/run.js mc10).
const fs = require('fs');
const { writeAtomic } = require('../lib/firmware');
const path = require('path');

const L = [];
const e = (s) => L.push('        ' + s);
const lbl = (s) => L.push(s);
let uid = 0;
const lab = (p) => `${p}${++uid}`;

lbl(`VAL     EQU     $80`);
lbl(`OPR     EQU     $81`);
lbl(`CCV     EQU     $82`);
lbl(`PTR     EQU     $84`);
lbl(`W16     EQU     $86`);
lbl(`OCN     EQU     $88`);
lbl(`TON     EQU     $89`);
lbl(`SWN     EQU     $8A`);
lbl(`CNT     EQU     $8B`);
lbl(`DSUB    EQU     $F0`);       // a subroutine copied into on-chip RAM (for JSR direct)
lbl(`MEM     EQU     $4100`);
lbl(`TCSR    EQU     $08`);
lbl(`CTR     EQU     $09`);
lbl(`OCR     EQU     $0B`);
lbl(`KBD     EQU     $BFFF`);
lbl(`        ORG     $E000`);
lbl(`RESET   SEI`);
e(`LDS     #$8FF0`);
e(`LDX     #$0080`);
lbl(`CLI1    CLR     0,X`);
e(`INX`);
e(`CPX     #$0100`);
e(`BNE     CLI1`);
e(`LDX     #$4000`);
lbl(`CLX1    CLR     0,X`);
e(`INX`);
e(`CPX     #$4800`);
e(`BNE     CLX1`);
e(`LDAA    #$39`);            // RTS at DSUB
e(`STAA    DSUB`);

// ---------------- phase 1: ALU over an operand grid, with two incoming CC values ----------------
const BINA = ['SUBA', 'CMPA', 'SBCA', 'ANDA', 'BITA', 'EORA', 'ADCA', 'ORAA', 'ADDA'];
const BINB = ['SUBB', 'CMPB', 'SBCB', 'ANDB', 'BITB', 'EORB', 'ADCB', 'ORAB', 'ADDB'];
const UN = ['NEG', 'COM', 'LSR', 'ROR', 'ASR', 'ASL', 'ROL', 'DEC', 'INC', 'TST', 'CLR'];
const BR = ['BRA', 'BRN', 'BHI', 'BLS', 'BCC', 'BCS', 'BNE', 'BEQ', 'BVC', 'BVS', 'BPL', 'BMI', 'BGE', 'BLT', 'BGT', 'BLE'];
e(`CLR     VAL`);
lbl(`AL1     LDX     #OPS`);
lbl(`AL2     LDAB    0,X`);
e(`STAB    OPR`);
e(`STX     PTR`);
e(`LDAA    #$C0`);
e(`STAA    CCV`);
e(`JSR     BLOCK`);
e(`LDAA    #$EF`);              // H N Z V C set (I clear: no interrupt source is enabled)
e(`STAA    CCV`);
e(`JSR     BLOCK`);
e(`LDX     PTR`);
e(`INX`);
e(`CPX     #OPSEND`);
e(`BNE     AL2`);
e(`LDAA    VAL`);
e(`ADDA    #17`);
e(`STAA    VAL`);
e(`BCC     AL1`);
e(`JMP     PHASE2`);
lbl(`OPS     FCB     $00,$01,$0F,$10,$7F,$80,$81,$FF,$55,$AA,$09,$99`);
lbl(`OPSEND  EQU     *`);

const setcc = () => { e(`LDAA    CCV`); e(`TAP`); };
lbl(`BLOCK   EQU     *`);
for (const op of BINA) { setcc(); e(`LDAA    VAL`); e(`${op}    OPR`); }
for (const op of BINB) { setcc(); e(`LDAB    VAL`); e(`${op}    #$5A`); }
for (const op of UN) { setcc(); e(`LDAA    VAL`); e(`${op}A`); }
for (const op of UN) { e(`LDAB    OPR`); setcc(); e(`${op}B`); }
for (const op of UN) { e(`LDAA    VAL`); e(`STAA    MEM`); setcc(); e(`${op}     MEM`); e(`LDAA    MEM`); }
for (const op of UN) { e(`LDAA    OPR`); e(`LDX     #MEM-3`); e(`STAA    3,X`); setcc(); e(`${op}     3,X`); e(`LDAB    3,X`); }
// DAA after additions with incoming H and C
setcc(); e(`LDAA    VAL`); e(`ADDA    OPR`); e(`DAA`);
setcc(); e(`LDAA    VAL`); e(`ADCA    OPR`); e(`DAA`);
setcc(); e(`LDAA    VAL`); e(`DAA`);
// accumulator-to-accumulator
for (const op of ['ABA', 'SBA', 'CBA', 'TAB', 'TBA']) { e(`LDAB    OPR`); setcc(); e(`LDAA    VAL`); e(op); }
// 16-bit
for (const [ld, op] of [['LDD', 'ADDD    #$7F81'], ['LDD', 'SUBD    #$8001'], ['LDD', 'ADDD    VAL'], ['LDD', 'SUBD    VAL'],
  ['LDX', 'CPX     #$8000'], ['LDX', 'CPX     VAL'], ['LDD', 'LSRD'], ['LDD', 'ASLD']]) { setcc(); e(`${ld}     VAL`); e(op); }
setcc(); e(`LDAA    VAL`); e(`LDAB    OPR`); e(`MUL`);
setcc(); e(`LDX     VAL`); e(`LDAB    OPR`); e(`ABX`); e(`INX`); e(`DEX`); e(`DEX`);
setcc(); e(`TPA`);
for (const f of ['CLC', 'SEC', 'CLV', 'SEV']) { setcc(); e(f); e(`TPA`); }
// every branch condition after a compare
setcc(); e(`LDAA    VAL`); e(`CMPA    OPR`);
for (const b of BR) { const t = lab('BR'); e(`${b}     ${t}`); e(`NOP`); lbl(t); }
setcc();
for (const b of BR) { const t = lab('BS'); e(`${b}     ${t}`); e(`NOP`); lbl(t); }
e(`RTS`);

// ---------------- phase 2: addressing modes, stack, subroutines, SWI ----------------
lbl(`PHASE2  LDX     #$4200`);
e(`CLRB`);
lbl(`FILL    STAB    0,X`);
e(`INX`);
e(`INCB`);
e(`CPX     #$4400`);
e(`BNE     FILL`);
e(`LDX     #$4280`);
for (const m of ['#$5A', 'VAL', '$90', '$4280', '>$0081', '0,X', '1,X', '127,X', '255,X']) {
  e(`LDAA    ${m}`); e(`LDAB    ${m}`); e(`ADDA    ${m}`); e(`CMPB    ${m}`);
}
for (const m of ['$90', '$4300', '0,X', '200,X']) {
  e(`LDD     ${m}`); e(`ADDD    ${m}`); e(`SUBD    ${m}`); e(`CPX     ${m}`); e(`LDX     ${m}`); e(`LDX     #$4280`);
  e(`STAA    ${m}`); e(`STAB    ${m}`); e(`STD     ${m}`); e(`STX     ${m}`); e(`STS     ${m}`); e(`LDS     ${m}`); e(`LDS     #$8FF0`);
}
e(`LDD     #$1234`);
e(`LDX     #$5678`);
e(`PSHA`); e(`PSHB`); e(`PSHX`); e(`TSX`); e(`LDAA    0,X`); e(`PULX`); e(`PULA`); e(`PULB`);
e(`DES`); e(`DES`); e(`INS`); e(`TSX`); e(`TXS`); e(`INS`);
e(`LDS     #$00FE`);                      // stack in on-chip RAM
e(`PSHX`); e(`PSHA`); e(`PULB`); e(`PULX`);
e(`LDS     #$8FF0`);
e(`BSR     SUB1`);
e(`JSR     SUB1`);
e(`JSR     DSUB`);
e(`LDX     #SUB1`);
e(`JSR     0,X`);
e(`LDX     #SUB1-4`);
e(`JSR     4,X`);
e(`LDX     #J1`);
e(`JMP     0,X`);
lbl(`J1      JMP     J2`);
lbl(`J2      SWI`);
e(`SWI`);
e(`FCB     $02,$41,$5E`);              // undefined opcodes: no-ops on the 6803
e(`JMP     PHASE3`);
lbl(`SUB1    INC     CNT`);
e(`RTS`);

// ---------------- phase 3: free-running counter, output compare, overflow, interrupts ----------------
lbl(`PHASE3  LDAA    TCSR`);
e(`LDD     CTR`);
e(`LDAA    CTR`);
e(`LDAB    CTR+1`);
e(`LDD     CTR`);
e(`ADDD    #100`);
e(`STD     OCR`);
lbl(`WOC     LDAA    TCSR`);              // poll OCF
e(`BITA    #$40`);
e(`BEQ     WOC`);
e(`LDD     CTR`);
e(`LDAA    TCSR`);                         // TCSR read then OCR write clears OCF
e(`LDD     OCR`);
e(`ADDD    #50`);
e(`STD     OCR`);
e(`LDAA    TCSR`);
e(`LDD     OCR`);
e(`STD     OCR`);                          // same value
e(`LDAA    TCSR`);
// output compare interrupts while busy looping
e(`LDAA    #$08`);
e(`STAA    TCSR`);                         // EOCI
e(`LDD     CTR`);
e(`ADDD    #300`);
e(`STD     OCR`);
e(`CLI`);
lbl(`BUSY    INC     CNT`);
e(`LDAA    OCN`);
e(`CMPA    #4`);
e(`BNE     BUSY`);
e(`SEI`);
// WAI woken by output compare
e(`LDD     CTR`);
e(`ADDD    #400`);
e(`STD     OCR`);
e(`CLI`);
e(`NOP`);
e(`WAI`);
e(`LDD     CTR`);
e(`WAI`);
e(`SEI`);
e(`LDD     CTR`);
// output level on P21
e(`LDAA    #$09`);                         // EOCI + OLVL
e(`STAA    TCSR`);
e(`LDAA    #$03`);
e(`STAA    $01`);                          // DDR2: P20, P21 outputs
e(`LDAA    #$13`);
e(`ANDA    $03`);
e(`CLI`);
e(`WAI`);
e(`SEI`);
e(`LDAA    #$13`);
e(`ANDA    $03`);
e(`LDAA    #$08`);
e(`STAA    TCSR`);
// counter write and overflow
lbl(`TOV     LDAA    TCSR`);
e(`STAA    CTR`);                          // preset to $FFF8
e(`LDD     CTR`);
e(`NOP`);
e(`LDAA    TCSR`);
e(`LDAA    TCSR`);
e(`LDAA    CTR`);                          // clears TOF
e(`LDAA    TCSR`);
e(`LDD     #$FF80`);
e(`STD     CTR`);                          // $09 then $0A: loads $FF80 (6301-style double-byte write)
lbl(`WTOF    LDAA    TCSR`);
e(`BITA    #$20`);
e(`BEQ     WTOF`);
e(`LDAA    CTR`);
e(`LDAA    TCSR`);
// overflow interrupt from WAI
e(`LDAA    #$04`);
e(`STAA    TCSR`);                         // ETOI only
e(`LDD     #$FE00`);
e(`STD     CTR`);
e(`CLI`);
e(`WAI`);
e(`SEI`);
e(`CLR     TCSR`);
// interrupt shadow: TAP clearing I with OCF pending, CLI with I set
e(`LDD     CTR`);
e(`ADDD    #40`);
e(`STD     OCR`);
lbl(`WOC2    LDAA    TCSR`);
e(`BITA    #$40`);
e(`BEQ     WOC2`);
e(`LDAA    #$08`);
e(`STAA    TCSR`);                         // EOCI with OCF already set: I masks it
e(`LDAA    #$C0`);
e(`TAP`);                                  // I cleared here; taken after the next instruction
e(`NOP`);
e(`NOP`);
e(`SEI`);
e(`CLR     TCSR`);

// ---------------- phase 4: ports, keyboard, VDG latch, sound ----------------
e(`LDAA    #$FF`);
e(`STAA    $00`);                          // DDR1 all outputs
e(`LDX     #STRB`);
lbl(`KB      LDAA    0,X`);
e(`STAA    $02`);
e(`LDAB    KBD`);
e(`LDAA    #$13`);
e(`ANDA    $03`);                          // port 2 pins (bits 2, 3 and 5-7 masked: see spec.js)
e(`LDAA    $02`);
e(`INX`);
e(`CPX     #STRBE`);
e(`BNE     KB`);
e(`LDAA    #$0F`);
e(`STAA    $00`);                          // DDR1 half inputs: reads back the strobe lines
e(`LDAA    $02`);
e(`LDAA    #$F0`);
e(`STAA    $02`);
e(`LDAA    $02`);
e(`LDAB    KBD`);
e(`LDAA    #$FF`);
e(`STAA    $00`);
e(`LDAA    #$01`);
e(`STAA    $01`);                          // DDR2: P20 output
e(`LDAA    #$01`);
e(`STAA    $03`);
e(`CLR     $03`);
e(`LDAA    #$13`);
e(`ANDA    $03`);
e(`CLRA`);
lbl(`VL      STAA    KBD`);                // every latch value: VDG modes, CSS, sound
e(`ADDA    #3`);
e(`BCC     VL`);
e(`CLR     KBD`);
e(`LDAA    $4000`);
e(`LDAA    $3000`);                        // unmapped
e(`LDAA    $C000`);                        // unmapped
e(`LDAA    $0020`);                        // unmapped
e(`LDAA    $14`);                          // RAM control
e(`LDAA    $11`);                          // SCI status
lbl(`DONE    LDAA    #$01`);
e(`STAA    CNT`);
lbl(`HALT    BRA     HALT`);
lbl(`STRB    FCB     $FE,$FD,$FB,$F7,$EF,$DF,$BF,$7F,$00,$FF,$7E,$5A`);
lbl(`STRBE   EQU     *`);

// ---------------- handlers ----------------
lbl(`OCIH    INC     OCN`);
e(`LDAA    TCSR`);
e(`LDD     OCR`);
e(`ADDD    #300`);
e(`STD     OCR`);
e(`RTI`);
lbl(`TOIH    INC     TON`);
e(`LDAA    TCSR`);
e(`LDAA    CTR`);
e(`RTI`);
lbl(`SWIH    INC     SWN`);
e(`TSX`);
e(`LDAA    0,X`);
e(`RTI`);
lbl(`OTHER   RTI`);
lbl(`        ORG     $FFF0`);
e(`FDB     OTHER,TOIH,OCIH,OTHER,OTHER,SWIH,OTHER,RESET`);

const out = path.join(__dirname, 'diag.asm');
writeAtomic(out, L.join('\n') + '\n        END     RESET\n');
console.log(`wrote ${out} (${L.length} lines)`);
