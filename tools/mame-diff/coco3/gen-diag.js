// Generates diag.asm: CoCo 3 diagnostic firmware (our own code, 32K, used in place of coco3.rom).
// It exercises the GIME (MMU with both tasks, ROM modes, constant page, TY, palette, timer,
// VBORD/HBORD interrupts, CPU speed) and the PIAs, so that instruction traces with cycle counts
// can be compared between this emulator and MAME (node tools/mame-diff/run.js coco3).
//
// Memory use: direct page variables at $0000 (slot 0), stack at $1F00, RAM routines at $1000.
// Slots 0, 1 ($0000-$3FFF) and 4-7 (ROM) keep the same mapping in both MMU tasks; slots 2 and 3
// ($4000-$7FFF) are used as windows onto other physical blocks. $7000 (block $3B, offset $1000)
// holds the phase number for the harness.
const fs = require('fs');
const { writeAtomic } = require('../lib/firmware');
const path = require('path');

const L = [];
const e = (s) => L.push(s);
let uid = 0;
const lab = (p) => `${p}${++uid}`;
const phase = (n) => { e(`        LDA     #${n}`); e(`        STA     PHASE`); };

e(`CNT     EQU     $00`);   // interrupt counters
e(`IRQN    EQU     $01`);
e(`FIRQN   EQU     $02`);
e(`LASTI   EQU     $03`);   // last $FF92 value read in the IRQ handler
e(`LASTF   EQU     $04`);
e(`SUM     EQU     $05`);   // 2 bytes
e(`TMP     EQU     $07`);
e(`PHASE   EQU     $7000`);
e(`RAMR    EQU     $1000`);
e(`        ORG     $8000`);
e(`RESET   ORCC    #$50`);
e(`        LDS     #$1F00`);
e(`        CLRA`);
e(`        TFR     A,DP`);
e(`        LDX     #$0000`);
e(`CLR1    CLR     ,X+`);
e(`        CMPX    #$0100`);
e(`        BNE     CLR1`);
e(`        CLR     PHASE`);
// ---------- phase 1: power-on state, floating bus, unmapped I/O ----------
phase(1);
e(`        LDA     $FF90`);     // write-only register: floating bus ($FFFF)
e(`        LDA     $FF98`);
e(`        LDA     $FFA0`);     // MMU register, upper bits floating
e(`        LDA     $FFA7`);
e(`        LDA     $FFB0`);     // palette
e(`        LDX     #$FFA3`);
e(`        LDA     ,X`);        // no-offset indexed: floating bits from the next opcode
e(`        LDA     0,X`);
e(`        LDA     $FF92`);
e(`        LDA     $FF93`);
e(`        LDA     $FF60`);
e(`        LDA     $FF80`);
e(`        LDA     $FFC0`);
e(`        LDA     $FFD5`);
e(`        LDA     $8000`);
e(`        LDA     $BFFF`);
e(`        LDA     $FFFE`);
e(`        LDA     $FFF0`);
// ---------- phase 2: ROM modes (runs from RAM) ----------
phase(2);
const copy = (from, to, dst) => {
  const l = lab('CP');
  e(`        LDX     #${from}`);
  e(`        LDY     #${dst}`);
  e(`${l}    LDA     ,X+`);
  e(`        STA     ,Y+`);
  e(`        CMPX    #${to}`);
  e(`        BNE     ${l}`);
};
copy('ROMT', 'ROMTE', 'RAMR');
e(`        JSR     RAMR`);
// ---------- phase 3: MMU ----------
phase(3);
// identity mapping in both tasks, then enable the MMU (ROM mode 2: 32K internal, MC3 off)
e(`        LDX     #$FFA0`);
e(`        LDA     #$38`);
const mmuId = lab('MI');
e(`${mmuId}    STA     ,X`);
e(`        STA     8,X`);
e(`        LEAX    1,X`);
e(`        INCA`);
e(`        CMPA    #$40`);
e(`        BNE     ${mmuId}`);
e(`        LDA     #$42`);
e(`        STA     $FF90`);
e(`        LDA     $8000`);
e(`        LDA     $C000`);
e(`        LDA     $E000`);
e(`        LDA     $FE00`);
// write a signature into every block (except ROM blocks $3C-$3F and the ones we run in) via slot 2
e(`        CLRB`);
const wsig = lab('WS');
e(`${wsig}  STB     $FFA2`);
e(`        STB     $4000`);
e(`        COMB`);
e(`        STB     $5FFF`);
e(`        COMB`);
e(`        INCB`);
e(`        CMPB    #$38`);
e(`        BNE     ${wsig}`);
// read them back via slot 3, summing
e(`        CLRB`);
e(`        LDX     #0`);
e(`        STX     <SUM`);
const rsig = lab('RS');
e(`${rsig}  STB     $FFA3`);
e(`        LDA     $6000`);
e(`        ADDA    $7FFF`);
e(`        ADDA    <SUM+1`);
e(`        STA     <SUM+1`);
e(`        LDA     $FFA3`);
e(`        INCB`);
e(`        CMPB    #$38`);   // blocks $38-$3F were not written (RAM power-on contents are undefined)
e(`        BNE     ${rsig}`);
for (const b of ['$3C', '$3D', '$3E', '$3F']) { e(`        LDA     #${b}`); e(`        STA     $FFA3`); e(`        LDA     $6000`); e(`        LDA     $7FF0`); }
e(`        LDD     <SUM`);
// blocks above $3F wrap (512K: only 6 bits); high MMU bits are kept but read back masked
e(`        LDA     #$C5`);
e(`        STA     $FFA3`);
e(`        LDA     $6000`);
e(`        LDA     $FFA3`);
// ROM blocks mapped into low slots: the ROM page follows the CPU slot
e(`        LDA     #$3C`);
e(`        STA     $FFA2`);
e(`        LDA     $4000`);
e(`        LDA     #$3F`);
e(`        STA     $FFA3`);
e(`        LDA     $6000`);
e(`        LDA     #$3E`);
e(`        STA     $FFA3`);
e(`        LDA     $7FFF`);
e(`        LDA     #$3A`);
e(`        STA     $FFA2`);
e(`        LDA     #$3B`);
e(`        STA     $FFA3`);
e(`        LDA     #$11`);
e(`        STA     $4001`);     // known value in block $3A
// task 1: slots 2 and 3 point at blocks 5 and 6
e(`        LDA     #$05`);
e(`        STA     $FFAA`);
e(`        LDA     #$06`);
e(`        STA     $FFAB`);
e(`        LDA     #$01`);
e(`        STA     $FF91`);
e(`        LDA     $4000`);
e(`        LDA     $7FFF`);
e(`        LDA     #$77`);
e(`        STA     $4001`);
e(`        CLR     $FF91`);
e(`        LDA     $4001`);
e(`        LDA     #$05`);
e(`        STA     $FFA2`);
e(`        LDA     $4001`);
e(`        LDA     #$3A`);
e(`        STA     $FFA2`);
// constant page: with MC3 off $FExx follows slot 7; with it on it is block $3F
e(`        LDA     #$30`);
e(`        STA     $FFA2`);
e(`        LDA     #$21`);
e(`        STA     $5E10`);     // known value in block $30 at $1E10
e(`        LDA     #$3A`);
e(`        STA     $FFA2`);
e(`        LDA     #$30`);
e(`        STA     $FFA7`);
// MAME only remaps $FE00-$FEFF on a full memory update (not on a $FFA7/$FFAF write), which looks
// like an emulation artefact; force one by toggling a ROM-mode bit before reading the page
e(`        LDA     #$40`);
e(`        STA     $FF90`);
e(`        LDA     #$42`);
e(`        STA     $FF90`);
e(`        LDA     $FE10`);
e(`        LDA     #$4A`);
e(`        STA     $FF90`);
e(`        LDA     #$5A`);
e(`        STA     $FE10`);
e(`        LDA     $FE10`);
e(`        LDA     #$3F`);
e(`        STA     $FFA7`);
e(`        LDA     $FE10`);
e(`        LDA     $FFFF`);
e(`        LDA     #$42`);
e(`        STA     $FF90`);
e(`        LDA     $FE10`);
// all-RAM (SAM TY) with the MMU on, from RAM
copy('TYT', 'TYTE', 'RAMR');
e(`        JSR     RAMR`);
// MMU register readback
e(`        LDX     #$FFA0`);
const mrd = lab('MR');
e(`${mrd}    LDA     ,X+`);
e(`        CMPX    #$FFB0`);
e(`        BNE     ${mrd}`);
// ---------- phase 4: palette ----------
phase(4);
e(`        LDX     #$FFB0`);
e(`        LDA     #$15`);
const pw = lab('PW');
e(`${pw}    STA     ,X+`);
e(`        ADDA    #$1D`);
e(`        CMPX    #$FFC0`);
e(`        BNE     ${pw}`);
e(`        LDX     #$FFB0`);
const pr = lab('PR');
e(`${pr}    LDA     ,X+`);
e(`        LDB     -1,X`);
e(`        CMPX    #$FFC0`);
e(`        BNE     ${pr}`);
// ---------- phase 5: GIME timer ----------
phase(5);
// polled, 63.5us clock: enable TMR in $FF92 with the GIME IRQ output off
e(`        LDA     #$20`);
e(`        STA     $FF92`);
e(`        CLR     $FF95`);
e(`        LDA     #$05`);
e(`        STA     $FF95`);
e(`        CLR     $FF94`);       // start: 5+2 lines
e(`        LDA     $FF92`);
const tp1 = lab('TP');
e(`${tp1}    LDA     $FF92`);
e(`        BEQ     ${tp1}`);
const tp2 = lab('TP');
e(`${tp2}    LDA     $FF92`);
e(`        BEQ     ${tp2}`);
// 279ns clock
e(`        LDA     #$20`);
e(`        STA     $FF91`);
e(`        LDA     #$01`);
e(`        STA     $FF94`);       // $105 + 2 clocks
const tp3 = lab('TP');
e(`${tp3}    LDA     $FF92`);
e(`        BEQ     ${tp3}`);
e(`        LDA     #$40`);
e(`        STA     $FF95`);       // only latched at the next reload
const tp4 = lab('TP');
e(`${tp4}    LDA     $FF92`);
e(`        BEQ     ${tp4}`);
const tp5 = lab('TP');
e(`${tp5}    LDA     $FF92`);
e(`        BEQ     ${tp5}`);
// IRQ from the timer: count 6 interrupts in a busy loop
e(`        CLR     <IRQN`);
e(`        LDA     #$62`);
e(`        STA     $FF90`);       // MMU, IEN
e(`        ANDCC   #$EF`);
e(`        LDX     #0`);
const tb = lab('TB');
e(`${tb}    LEAX    1,X`);
e(`        LDA     <IRQN`);
e(`        CMPA    #6`);
e(`        BNE     ${tb}`);
e(`        ORCC    #$50`);
// FIRQ from the timer, 63.5us clock
e(`        CLR     $FF92`);
e(`        LDA     #$20`);
e(`        STA     $FF93`);
e(`        CLR     $FF91`);
e(`        LDA     #$52`);
e(`        STA     $FF90`);       // MMU, FEN
e(`        CLR     <FIRQN`);
e(`        LDA     #$02`);
e(`        STA     $FF94`);
e(`        LDA     #$03`);
e(`        STA     $FF95`);
e(`        ANDCC   #$BF`);
const tf = lab('TF');
e(`${tf}    LDA     <FIRQN`);
e(`        CMPA    #3`);
e(`        BNE     ${tf}`);
e(`        ORCC    #$50`);
// timer value 0: toggling the TMR enable pulses the interrupt
e(`        CLR     $FF94`);
e(`        CLR     $FF95`);
e(`        CLR     $FF94`);
e(`        LDA     $FF93`);
e(`        CLR     $FF93`);
e(`        LDA     #$20`);
e(`        STA     $FF93`);
e(`        LDA     $FF93`);
e(`        STA     $FF92`);
e(`        LDA     $FF92`);
e(`        CLR     $FF92`);
e(`        CLR     $FF93`);
// ---------- phase 6: VBORD and HBORD ----------
phase(6);
e(`        LDA     #$08`);
e(`        STA     $FF92`);       // VBORD, polled
e(`        LDA     $FF92`);
const vp1 = lab('VP');
e(`${vp1}    LDA     $FF92`);
e(`        BEQ     ${vp1}`);
const vp2 = lab('VP');
e(`${vp2}    LDA     $FF92`);
e(`        BEQ     ${vp2}`);
e(`        LDA     #$10`);
e(`        STA     $FF92`);       // HBORD, polled
e(`        LDB     #20`);
const hp = lab('HP');
e(`${hp}    LDA     $FF92`);
e(`        BEQ     ${hp}`);
e(`        DECB`);
e(`        BNE     ${hp}`);
// VBORD IRQ x3, HBORD FIRQ x40 at the same time
e(`        CLR     <IRQN`);
e(`        CLR     <FIRQN`);
e(`        LDA     #$08`);
e(`        STA     $FF92`);
e(`        LDA     #$10`);
e(`        STA     $FF93`);
e(`        LDA     #$72`);
e(`        STA     $FF90`);       // MMU, IEN, FEN
e(`        ANDCC   #$AF`);
const vb = lab('VB');
e(`${vb}    LDA     <IRQN`);
e(`        CMPA    #3`);
e(`        BNE     ${vb}`);
e(`        ORCC    #$50`);
e(`        LDA     <FIRQN`);
e(`        CLR     $FF93`);
// 200 and 225 line geometries move VBORD
for (const lpf of ['$20', '$60']) {
  e(`        LDA     #${lpf}`);
  e(`        STA     $FF99`);
  e(`        LDA     #$08`);
  e(`        STA     $FF92`);
  const a = lab('VG'), b = lab('VG');
  e(`${a}    LDA     $FF92`);
  e(`        BEQ     ${a}`);
  e(`${b}    LDA     $FF92`);
  e(`        BEQ     ${b}`);
}
e(`        CLR     $FF99`);
e(`        CLR     $FF92`);
// CWAI on a GIME interrupt
e(`        LDA     #$08`);
e(`        STA     $FF92`);
e(`        CWAI    #$EF`);
e(`        ORCC    #$50`);
e(`        CLR     $FF92`);
e(`        LDA     #$42`);
e(`        STA     $FF90`);
// ---------- phase 7: CPU speed ----------
phase(7);
const speedTest = (addr) => {
  e(`        STA     ${addr}`);
  e(`        LDA     #$10`);
  e(`        STA     $FF92`);
  e(`        LDA     $FF92`);
  const a = lab('SP');
  e(`        LDB     #8`);
  e(`${a}    LDA     $FF92`);
  e(`        BEQ     ${a}`);
  e(`        DECB`);
  e(`        BNE     ${a}`);
  e(`        LDX     #0`);
  const b = lab('SP');
  e(`        LDA     $FF92`);
  e(`${b}    LEAX    1,X`);
  e(`        LDA     $FF92`);
  e(`        BEQ     ${b}`);
  e(`        CLR     $FF92`);
};
speedTest('$FFD9');   // R1: fast
speedTest('$FFD8');   // slow
speedTest('$FFD7');   // R0: fast
speedTest('$FFD9');   // both
speedTest('$FFD6');   // R1 only
speedTest('$FFD8');   // slow
// timer in fast mode, FIRQ
e(`        STA     $FFD9`);
e(`        CLR     <FIRQN`);
e(`        LDA     #$20`);
e(`        STA     $FF91`);
e(`        STA     $FF93`);
e(`        LDA     #$52`);
e(`        STA     $FF90`);
e(`        CLR     $FF94`);
e(`        LDA     #$90`);
e(`        STA     $FF95`);
e(`        CLR     $FF94`);
e(`        ANDCC   #$BF`);
const tff = lab('TF');
e(`${tff}    LDA     <FIRQN`);
e(`        CMPA    #5`);
e(`        BNE     ${tff}`);
e(`        ORCC    #$50`);
e(`        CLR     $FF93`);
e(`        CLR     $FF94`);
e(`        CLR     $FF95`);
e(`        CLR     $FF94`);
e(`        CLR     $FF91`);
e(`        STA     $FFD8`);
e(`        LDA     #$42`);
e(`        STA     $FF90`);
// ---------- phase 8: PIAs, HS/FS, PIA interrupts through the GIME machine ----------
phase(8);
e(`        CLR     $FF01`);
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
e(`        LDA     $FF22`);         // port B inputs: RAM size sense, serial in
e(`        LDA     #$FC`);
e(`        STA     $FF22`);
e(`        LDA     #$34`);
e(`        STA     $FF23`);
e(`        LDA     $FF01`);
e(`        LDA     $FF03`);
e(`        LDA     $FF21`);
e(`        LDA     $FF23`);
e(`        LDA     $FF20`);
e(`        LDA     $FF22`);
e(`        LDA     $FF00`);
e(`        LDA     $FF02`);
// count HS per field by polling
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
// FS rising edge
e(`        LDA     #$36`);
e(`        STA     $FF03`);
e(`        LDA     $FF02`);
e(`WFS2    LDA     $FF03`);
e(`        BPL     WFS2`);
e(`        LDA     $FF02`);
// FS IRQ from the PIA while the GIME also raises VBORD IRQs
e(`        LDA     #$35`);
e(`        STA     $FF03`);
e(`        LDA     $FF02`);
e(`        LDA     #$08`);
e(`        STA     $FF92`);
e(`        LDA     #$62`);
e(`        STA     $FF90`);
e(`        CLR     <IRQN`);
e(`        ANDCC   #$EF`);
e(`        LDX     #0`);
const pb = lab('PB');
e(`${pb}    LEAX    1,X`);
e(`        LDA     <IRQN`);
e(`        CMPA    #6`);
e(`        BNE     ${pb}`);
e(`        ORCC    #$50`);
e(`        CLR     $FF92`);
e(`        LDA     #$42`);
e(`        STA     $FF90`);
// SYNC on the PIA
e(`        LDA     $FF02`);
e(`        SYNC`);
e(`        LDA     $FF02`);
e(`        LDA     #$34`);
e(`        STA     $FF03`);
// HS FIRQ through PIA1? (CA1 of PIA1 is carrier detect) - PIA0 HS IRQ instead, fast mode
e(`        STA     $FFD9`);
e(`        LDA     #$35`);
e(`        STA     $FF01`);
e(`        LDA     $FF00`);
e(`        CLR     <IRQN`);
e(`        ANDCC   #$EF`);
const hsq = lab('HQ');
e(`${hsq}    LDA     <IRQN`);
e(`        CMPA    #10`);
e(`        BNE     ${hsq}`);
e(`        ORCC    #$50`);
e(`        LDA     #$34`);
e(`        STA     $FF01`);
e(`        STA     $FFD8`);
// ---------- phase 9: SAM V/F registers, keyboard scan ----------
phase(9);
e(`        LDX     #$FFC0`);
e(`        LDA     #0`);
e(`SAMV    STA     A,X`);
e(`        INCA`);
e(`        CMPA    #$14`);
e(`        BNE     SAMV`);
e(`        LDB     #$FE`);
e(`KB      STB     $FF02`);
e(`        LDA     $FF00`);
e(`        ORCC    #$01`);
e(`        ROLB`);
e(`        BCS     KB`);
e(`        LDA     #$FF`);
e(`        STA     $FF02`);
e(`        LDA     $FF00`);
phase(10);
e(`HALT    BRA     HALT`);

// ---------- RAM routines ----------
// ROM modes with the MMU off: read the four ROM-area pages in each mode
e(`ROMT    EQU     *`);
for (const mode of [0, 1, 2, 3, 0]) {
  e(`        LDA     #${mode}`);
  e(`        STA     $FF90`);
  // $FDFF only in mode 2 (32K internal): in the other modes it is in the cartridge's half or quarter, and with no
  // cartridge that read is whatever the bus held (MAME's open bus), which changes from run to run
  for (const a of ['$8000', '$A000', '$C000', '$E000', ...(mode === 2 ? ['$FDFF'] : [])]) e(`        LDA     ${a}`);
}
e(`        RTS`);
e(`ROMTE   EQU     *`);
e(`TYT     EQU     *`);
e(`        STA     $FFDF`);
e(`        LDA     $8000`);
e(`        LDA     #$66`);
e(`        STA     $8000`);
e(`        LDA     $8000`);
e(`        STA     $FFDE`);
e(`        LDA     $8000`);
e(`        STA     $FFDF`);
e(`        LDA     $8000`);
e(`        STA     $FFDE`);
e(`        RTS`);
e(`TYTE    EQU     *`);

// ---------- handlers ----------
e(`IRQH    INC     <IRQN`);
e(`        LDA     $FF92`);
e(`        STA     <LASTI`);
e(`        LDA     $FF00`);
e(`        LDA     $FF02`);
e(`        RTI`);
e(`FIRQH   INC     <FIRQN`);
e(`        PSHS    A`);
e(`        LDA     $FF93`);
e(`        STA     <LASTF`);
e(`        LDA     $FF20`);
e(`        LDA     $FF22`);
e(`        PULS    A`);
e(`        RTI`);
e(`SWIH    RTI`);
e(`NMIH    RTI`);
e(`        ORG     $FFF2`);
e(`        FDB     SWIH,SWIH,FIRQH,IRQH,SWIH,NMIH,RESET`);

const out = path.join(__dirname, 'diag.asm');
writeAtomic(out, '; CoCo 3 diagnostic firmware, generated by gen-diag.js - do not edit\n' + L.join('\n') + '\n        END     RESET\n');
console.log(`wrote ${out} (${L.length} lines)`);
