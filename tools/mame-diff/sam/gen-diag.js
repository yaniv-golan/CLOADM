// Generates diag.asm: a diagnostic firmware (our own code, used in place of the BASIC ROM)
// that exercises the 6809 instruction set and the Dragon 64 hardware so that an
// instruction-by-instruction trace can be compared between two emulators.
const fs = require('fs');
const { writeAtomic } = require('../lib/firmware');
const path = require('path');

// The RAM addresses the firmware uses. The 64K layout is the one every existing comparison runs, so its
// trace hashes must not move: stack at $7F00, scratch at $1C00-$3000, the indirect table at $2080, LDU at
// $6000. A small-RAM machine (4K or 16K) cannot hold that spread, so everything is packed below the top of
// the fitted RAM: a 128-byte stack, 1K of scratch, a 256-byte indirect table and a 256-byte page for the
// map-type routine, with the direct page ($00-$FF) and the on-chip I/O above as on any SAM machine.
function layout(ramK) {
  if (ramK >= 64) return { stack: 0x7F00, clearEnd: 0x7F00, scratch: 0x1C00, scratchEnd: 0x3000, ind: 0x2080, ldu: 0x6000, ty: 0x3000 };
  const top = (ramK * 1024) & ~1;
  const scratch = 0x0200, ind = scratch + 0x0600, ldu = scratch + 0x0800, ty = scratch + 0x0900;
  // the last address each region may use is `top - 1`; the region sizes are fixed and small
  return { stack: top, clearEnd: top, scratch, scratchEnd: scratch + 0x400, ind, ldu, ty };
}
const ramK = +(process.argv.find((a) => /^--ram-k=/.test(a)) || '').split('=')[1] || 64;
const A = layout(ramK);
const hx = (n) => '$' + (n & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
const L = [];
const e = (s) => L.push(s);
let uid = 0;
const lab = (p) => `${p}${++uid}`;

// ---------------- header ----------------
e(`VAL     EQU     $00`);
e(`OPR     EQU     $01`);
e(`TMP     EQU     $02`);
e(`CNT     EQU     $04`);
e(`W16     EQU     $06`);
e(`IRQN    EQU     $08`);
e(`FIRQN   EQU     $09`);
e(`SWIN    EQU     $0A`);
e(`BANKID  EQU     $BF00`);
e(`        ORG     $8000`);
e(`RESET   ORCC    #$50`);
e(`        STA     $FFDD`);   // SAM M1=1: 64K dynamic RAM, as the BASIC ROM sets at boot
e(`        LDS     #${hx(A.stack)}`);
e(`        LDU     #${hx(A.ldu)}`);
e(`        LDX     #$0000`);
e(`        LDY     #$0000`);
e(`        LDD     #$0000`);
e(`        TFR     A,DP`);
// clear direct page
e(`        LDX     #$0000`);
e(`CLRDP   CLR     ,X+`);
e(`        CMPX    #${hx(A.clearEnd)}`);
e(`        BNE     CLRDP`);

// ---------------- phase 1: ALU exerciser ----------------
const BIN = ['SUBA', 'CMPA', 'SBCA', 'ANDA', 'BITA', 'EORA', 'ADCA', 'ORA', 'ADDA'];
const BINB = ['SUBB', 'CMPB', 'SBCB', 'ANDB', 'BITB', 'EORB', 'ADCB', 'ORB', 'ADDB'];
const UNA = ['NEGA', 'COMA', 'LSRA', 'RORA', 'ASRA', 'ASLA', 'ROLA', 'DECA', 'INCA', 'TSTA', 'CLRA'];
const UNB = ['NEGB', 'COMB', 'LSRB', 'RORB', 'ASRB', 'ASLB', 'ROLB', 'DECB', 'INCB', 'TSTB', 'CLRB'];
const RMW = ['NEG', 'COM', 'LSR', 'ROR', 'ASR', 'ASL', 'ROL', 'DEC', 'INC', 'TST', 'CLR'];
const BR = ['BRA', 'BRN', 'BHI', 'BLS', 'BCC', 'BCS', 'BNE', 'BEQ', 'BVC', 'BVS', 'BPL', 'BMI', 'BGE', 'BLT', 'BGT', 'BLE'];

e(`        CLR     <VAL`);
e(`AL1     LDY     #OPS`);
e(`AL2     LDB     ,Y`);
e(`        STB     <OPR`);
e(`        ANDCC   #$D0`);
e(`        JSR     BLOCK`);
e(`        ORCC    #$2F`);
e(`        JSR     BLOCK`);
e(`        LEAY    1,Y`);
e(`        CMPY    #OPSEND`);
e(`        BNE     AL2`);
e(`        LDA     <VAL`);
e(`        ADDA    #17`);
e(`        STA     <VAL`);
e(`        BCC     AL1`);
e(`        JMP     PHASE2`);

e(`OPS     FCB     $00,$01,$0F,$10,$7F,$80,$81,$FF,$55,$AA,$09,$99`);
e(`OPSEND  EQU     *`);

// BLOCK: run every op with the entry CC (saved on the stack)
e(`BLOCK   PSHS    Y`);
e(`        PSHS    CC`);
const restore = () => { e(`        PULS    CC`); e(`        PSHS    CC`); };
for (const op of BIN) { e(`        LDA     <VAL`); e(`        ${op}    <OPR`); restore(); }
for (const op of BINB) { e(`        LDB     <VAL`); e(`        ${op}    #$5A`); restore(); }
for (const op of UNA) { e(`        LDA     <VAL`); e(`        ${op}`); restore(); }
for (const op of UNB) { e(`        LDB     <OPR`); e(`        ${op}`); restore(); }
for (const op of RMW) { e(`        LDA     <VAL`); e(`        STA     <TMP`); restore(); e(`        ${op}     <TMP`); e(`        LDA     <TMP`); restore(); }
// DAA after add with incoming flags
e(`        LDA     <VAL`); e(`        ADDA    <OPR`); e(`        DAA`); restore();
e(`        LDA     <VAL`); e(`        ADCA    <OPR`); e(`        DAA`); restore();
e(`        LDA     <VAL`); e(`        DAA`); restore();
// 16-bit
e(`        LDD     <VAL`); e(`        ADDD    #$7F81`); restore();
e(`        LDD     <VAL`); e(`        SUBD    #$8001`); restore();
e(`        LDD     <VAL`); e(`        CMPD    #$1234`); restore();
e(`        LDX     <VAL`); e(`        CMPX    #$8000`); restore();
e(`        LDY     <VAL`); e(`        CMPY    #$00FF`); restore();
e(`        LDU     <VAL`); e(`        CMPU    #$FFFF`); restore();
e(`        LDA     <VAL`); e(`        LDB     <OPR`); e(`        MUL`); restore();
e(`        LDB     <VAL`); e(`        SEX`); restore();
e(`        LDX     <VAL`); e(`        LDB     <OPR`); e(`        ABX`); restore();
e(`        LDX     <VAL`); e(`        LEAX    -1,X`); restore();
e(`        LDA     <VAL`); e(`        CMPA    <OPR`);
for (const b of BR) { const t = lab('BR'); e(`        ${b}     ${t}`); e(`        NOP`); e(`${t}`); }
for (const b of BR) { const t = lab('LB'); e(`        L${b}    ${t}`); e(`        NOP`); e(`${t}`); }
restore();
e(`        LDU     #${hx(A.ldu)}`);
e(`        LEAS    1,S`);
e(`        PULS    Y,PC`);

// ---------------- phase 2: addressing modes, stack, transfers, SWI ----------------
e(`PHASE2  LDX     #${hx(A.scratch)}`);
e(`        LDD     #$0000`);
e(`FILL    STB     ,X+`);
e(`        INCB`);
e(`        CMPX    #${hx(A.scratchEnd)}`);
e(`        BNE     FILL`);
e(`        LDX     #${hx(A.ind)}`);
e(`        LDY     #${hx(A.ind + 0x100)}`);
const idx = ['0,X', '5,X', '-5,Y', '15,U', '-16,X', '100,Y', '-100,U', '1000,X', '-1000,Y', ',X+', ',X++', ',-X', ',--X',
  'A,X', 'B,Y', 'D,U', '[,X]', '[2,Y]', '[,X++]', '[,--Y]', '[$' + (A.ind - 0x70).toString(16).toUpperCase() + ']', 'TAB,PCR', '[TABP,PCR]', '-2,S'];
e(`        LDU     #${hx(A.ind + 0x200)}`);
e(`        LDA     #$03`);
e(`        LDB     #$FD`);
for (const m of idx) {
  e(`        LDA     #$03`);
  e(`        LDB     #$FD`);
  e(`        LDA     ${m}`);
  e(`        LEAX    ${m.includes('[') || m.includes('PCR') || m.includes('S') ? '1,X' : m}`);
  e(`        CMPX    #${hx(A.ind + 0x280)}`);
  e(`        BLO     ${'K' + (uid + 1)}`);
  e(`        LDX     #${hx(A.ind)}`);
  e(`${lab('K')}`);
  e(`        STB     ${m.includes('PCR') ? hx(A.ind - 0x30) : m}`);
}
e(`        LDX     #$2080`);
e(`        LDD     #$1234`);
e(`        LDX     #$5678`);
e(`        LDY     #$9ABC`);
e(`        LDU     #$DEF0`);
for (const r of ['A,B', 'A,X', 'B,Y', 'X,Y', 'D,U', 'CC,A', 'DP,B', 'A,DP', 'X,D', 'U,X', 'S,Y', 'PC,X', 'A,CC', 'B,D', 'X,A']) {
  e(`        TFR     ${r}`);
  e(`        ORCC    #$50`);
  e(`        CLRA`);
  e(`        TFR     A,DP`);
  e(`        LDD     #$1234`);
  e(`        LDX     #$5678`);
  e(`        EXG     ${r.replace('PC,X', 'Y,X').replace('S,Y', 'U,Y')}`);
  e(`        ORCC    #$50`);
  e(`        CLRA`);
  e(`        TFR     A,DP`);
  e(`        LDD     #$1234`);
}
e(`        LDU     #${hx(A.ldu)}`);
e(`        PSHS    A,B,X,Y,U,DP,CC`);
e(`        PULS    A,B,X,Y,U,DP,CC`);
e(`        PSHU    A,B,X,Y,S,DP,CC`);
e(`        PULU    A,B,X,Y,S,DP,CC`);
e(`        PSHS    D,X`);
e(`        LEAU    ,S`);
e(`        PULU    D,X`);
e(`        PULS    D,X`);
e(`        LDU     #${hx(A.ldu)}`);
e(`        SWI`);
e(`        SWI2`);
e(`        SWI3`);
e(`        BSR     SUB1`);
e(`        LBSR    SUB1`);
e(`        JSR     SUB1`);
e(`        JSR     [SUBV]`);
e(`        LDX     #SUB1`);
e(`        JSR     ,X`);
e(`        JMP     PHASE3`);
e(`SUB1    INC     <CNT`);
e(`        RTS`);
e(`SUBV    FDB     SUB1`);
e(`TAB     FCB     $11,$22,$33,$44`);
e(`TABP    FDB     TAB`);

// ---------------- phase 3: PIA registers, interrupts and timing ----------------
e(`PHASE3  CLR     $FF01`);
e(`        CLR     $FF00`);
e(`        LDA     #$FF`);
e(`        CLR     $FF03`);
e(`        STA     $FF02`);
e(`        LDA     #$34`);
e(`        STA     $FF01`);
e(`        STA     $FF03`);
e(`        CLR     $FF21`);
e(`        LDA     #$FE`);
e(`        STA     $FF20`);
e(`        LDA     #$34`);
e(`        STA     $FF21`);
e(`        CLR     $FF23`);
e(`        LDA     #$FC`);
e(`        STA     $FF22`);
e(`        LDA     #$34`);
e(`        STA     $FF23`);
e(`        LDA     $FF01`);
e(`        LDA     $FF03`);
e(`        LDA     $FF21`);
e(`        LDA     $FF23`);
e(`        LDA     #$04`);
e(`        STA     $FF22`);
// count HS edges per field by polling flags (falling-edge HS, falling-edge FS)
e(`        LDA     $FF00`);
e(`        LDA     $FF02`);
e(`WFS1    LDA     $FF03`);
e(`        BPL     WFS1`);
e(`        LDA     $FF02`);
e(`        LDA     $FF00`);
e(`        LDX     #0`);
e(`HSL     LDA     $FF01`);
e(`        BPL     HSL0`);
e(`        LDA     $FF00`);
e(`        LEAX    1,X`);
e(`HSL0    LDA     $FF03`);
e(`        BPL     HSL`);
e(`        STX     <W16`);
// FS rising edge
e(`        LDA     #$36`);
e(`        STA     $FF03`);
e(`        LDA     $FF02`);
e(`WFS2    LDA     $FF03`);
e(`        BPL     WFS2`);
e(`        LDA     $FF02`);
// IRQ from FS: count interrupts while busy looping
e(`        LDA     #$35`);
e(`        STA     $FF03`);
e(`        LDA     $FF02`);
e(`        ANDCC   #$EF`);
e(`        LDX     #0`);
e(`BUSY    LEAX    1,X`);
e(`        LDA     <IRQN`);
e(`        CMPA    #4`);
e(`        BNE     BUSY`);
e(`        ORCC    #$50`);
// CWAI and SYNC
e(`        CWAI    #$EF`);
e(`        ORCC    #$50`);
e(`        LDA     $FF02`);
e(`        SYNC`);
e(`        LDA     $FF02`);
e(`        LDA     #$34`);
e(`        STA     $FF03`);

// ---------------- phase 4: SAM, VDG modes, ROM banks, map type ----------------
e(`        LDX     #$FFC0`);
e(`        LDA     #0`);
e(`SAMV    STA     A,X`);
e(`        INCA`);
e(`        CMPA    #$14`);
e(`        BNE     SAMV`);
e(`        STA     $FFC0`);
e(`        STA     $FFC2`);
e(`        STA     $FFC4`);
e(`        STA     $FFC9`);
e(`        STA     $FFCA`);
e(`        STA     $FFCC`);
e(`        STA     $FFCE`);
e(`        STA     $FFD0`);
e(`        STA     $FFD2`);
e(`        LDA     BANKID`);
e(`        CLR     $FF23`);
e(`        LDA     #$FE`);
e(`        STA     $FF22`);
e(`        LDA     #$34`);
e(`        STA     $FF23`);
e(`        LDA     #$00`);
e(`        STA     $FF22`);
e(`        LDA     BANKID`);
e(`        LDA     #$04`);
e(`        STA     $FF22`);
e(`        LDA     BANKID`);
// page bit P1 (64K mode, map type 0): $0000-$7FFF is RAM $8000-$FFFF while it is set (absent on a 32K machine:
// reads 0, writes lost); with M1 clear P1 does nothing, and TY without M1 leaves the ROM in. The stack is in the
// low half, so interrupts are masked and nothing is pushed while P1 is set.
// (only bytes written here are read: RAM above $8000 has not been set, and MAME's power-on RAM differs from ours)
e(`        TFR     CC,B`);
e(`        ORCC    #$50`);
e(`        LDA     #$5A`);
e(`        STA     $1000`);        // RAM $1000
e(`        STA     $FFD5`);        // P1=1 (M1 is set)
e(`        LDA     #$C3`);
e(`        STA     $1001`);        // to RAM $9001
e(`        LDA     #$96`);
e(`        STA     $7FFF`);        // to RAM $FFFF
e(`        LDA     $1001`);        // RAM $9001
e(`        LDA     $7FFF`);        // RAM $FFFF
e(`        LDA     $9001`);        // still ROM
e(`        STA     $FFDC`);        // M1=0: P1 has no effect
e(`        LDA     $1000`);        // RAM $1000 ($5A)
e(`        LDA     $1001`);        // RAM $1001 (cleared at reset)
e(`        STA     $FFDF`);        // TY=1 without M1: still ROM at $8000-$FEFF
e(`        LDA     $9001`);
e(`        STA     $9001`);        // (lost)
e(`        STA     $FFDE`);
e(`        STA     $FFDD`);        // M1=1 again, P1 still set
e(`        LDA     $1001`);        // RAM $9001: $C3 on 64K, the TY write did not land
e(`        STA     $FFD4`);        // P1=0
e(`        LDA     $1001`);
e(`        TFR     B,CC`);
// map type 1 test runs from RAM because the ROM disappears when TY=1
e(`        LDX     #TYCODE`);
e(`        LDY     #${hx(A.ty)}`);
e(`TYCP    LDA     ,X+`);
e(`        STA     ,Y+`);
e(`        CMPX    #TYEND`);
e(`        BNE     TYCP`);
e(`        JSR     ${hx(A.ty)}`);
e(`        LDA     $FFFE`);
e(`        LDA     $FFFF`);

// ---------------- phase 5: keyboard rows and joystick comparator ----------------
e(`        LDB     #$FE`);
e(`KB      STB     $FF02`);
e(`        LDA     $FF00`);
e(`        ANDA    #$7F`);
e(`        ORCC    #$01`);
e(`        ROLB`);
e(`        BCS     KB`);
e(`        LDA     #$FF`);
e(`        STA     $FF02`);
e(`        LDA     $FF00`);
e(`        LDA     $FF02`);
e(`DONE    LDA     #$01`);
e(`        STA     <TMP`);
e(`HALT    BRA     HALT`);

// ---------------- RAM-resident map type routine ----------------
e(`TYCODE  STA     $FFDF`);        // map type 1: all RAM
e(`        LDA     #$3C`);
e(`        STA     $9000`);
e(`        STA     $FFDE`);        // map type 0: ROM visible
e(`        LDA     #$A5`);
e(`        STA     $9000`);        // write to ROM area (should be lost)
e(`        LDA     $9000`);        // reads ROM
e(`        STA     $FFDF`);
e(`        LDA     $9000`);        // RAM still holds $3C?
e(`        STA     $FFD5`);        // P1 under map type 1: no effect
e(`        LDA     $1000`);        // RAM $1000
e(`        LDA     $9001`);        // RAM $9001 (set through P1)
e(`        STA     $FFD4`);
e(`        STA     $FFDE`);
e(`        RTS`);
e(`TYEND   EQU     *`);

// ---------------- handlers ----------------
e(`IRQH    INC     <IRQN`);
e(`        LDA     $FF00`);
e(`        LDA     $FF02`);
e(`        RTI`);
e(`FIRQH   INC     <FIRQN`);
e(`        LDA     $FF20`);
e(`        LDA     $FF22`);
e(`        RTI`);
e(`SWIH    INC     <SWIN`);
e(`        RTI`);
e(`NMIH    RTI`);
e(`        ORG     $BF00`);
e(`        FCB     $11`);
e(`        ORG     $BFF2`);
e(`        FDB     SWIH,SWIH,FIRQH,IRQH,SWIH,NMIH,RESET`);

const out = path.join(__dirname, ramK === 64 ? 'diag.asm' : `diag-${ramK}k.asm`);
writeAtomic(out, L.join('\n') + '\n        END     RESET\n');
console.log(`wrote ${out} (${L.length} lines)`);
