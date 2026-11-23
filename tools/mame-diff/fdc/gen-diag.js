// Generates the floppy controller diagnostics (our own firmware):
//   boot.asm    16K in place of the BASIC ROM: masks interrupts, sets the stack (arming NMI) and jumps into
//               the cartridge; its vectors point at the cartridge's entry table
//   boot3.asm   the same in the CoCo 3's 32K internal ROM; it first sets the GIME's INIT0 to $04 (SCS: without
//               it $FF40-$FF5F don't reach the cartridge, as MAME's coco3 shows; CoCo 3 BASIC sets it), which
//               keeps the power-on mapping (16K internal ROM at $8000, the cartridge at $C000)
//   dragon.asm  8K in place of the DragonDOS ROM (MAME dragon_fdc: WD2797, registers $FF40, latch $FF48)
//   coco.asm    8K in place of the Disk BASIC ROM (MAME coco_fdc: WD1773, DSKREG $FF40, registers $FF48)
//   alpha.asm   8K in place of the Dragon Alpha's boot ROM (MAME dgnalpha: the built-in WD2797, registers reversed
//               at $FF2C, the latch through the AY-3-8912's port A, NMI gated by PIA2 CA2, DRQ on PIA2 CB1)
//   premier.asm 8K in place of the Delta DOS ROM (MAME premier_fdc: WD2791 with its inverted bus, latch $FF44,
//               no NMI: the force interrupt and seek tests poll the status instead)
//   <board>-write.asm  8K, a short firmware for the same boards that writes one sector on drives 0 and 1 and
//               reads it back (the disk mounting tests: tests/disks.test.js, tools/browser-check.js)
//   <board>-multi.asm  (dragon, premier, coco) the diagnostic for the controller in a Multi-Pak's slot 4 (MAME
//               -ext multi): the whole diagnostic, then the Multi-Pak's part: $FF7F read back, the controller's
//               registers out of reach while SCS selects another slot, NMI (and the CoCo's HALT) passing through
//               while it does, and the Dragon's CART (DRQ) reaching the CPU only while CTS selects slot 4 (that
//               part runs from RAM, as the ROM it runs from is switched out)
//   <board>-format-<T>x<H>.asm  (dragon, premier, coco) formats a blank disk of T tracks and H sides in drive 0
//               (the blank disks of DiskDrives.newDisk, js/media/disk.js blankDisk): reads sector 1 of track 0 and
//               sector 18 of the last track and side first (what the blank holds), then a write track on every
//               track and side, 18 sectors of 256 bytes numbered 1-18 with the track and side in their IDs and
//               data that names the track and side (FILLS), logging each status; reads both back at the end
// All run the same sequence of tests against the disks tools/mame-diff/fdc/images.js builds (drive 0 a
// double-sided disk, drive 1 write-protected, drive 2 a drive without a disk, drive 3 a DMK disk) and end
// in the HALT loop. Every status, register and loop count passes through the CPU registers, so the lockstep
// trace compares them; they are also logged from $6000 (U) for the Node tests. Tests: register commit
// delays, index pulse timing, restore/seek/step (every rate, update, verify, step-out below track 0), verify
// failure (RNF after five revolutions), read address, read sector (E delay, multi-sector, b flag, side 1),
// lost data, write sector and deleted data mark, read track, write track (MFM and FM), FM read, write
// protect, the drive without a disk, force interrupt (immediate, index, during a command), NMI on INTRQ, the
// Dragon's CART (DRQ) FIRQ transfer and the CoCo's HALT transfer, and multi-sector write.
const path = require('path');
const { writeAtomic } = require('../lib/firmware');

const BOARDS = {
  dragon: { fdc: 0x40, dsk: 0x48, rd: 0x88, wr: 0xa8, side: 0x02, inv: 0x00, nmi: true },
  coco: { fdc: 0x48, dsk: 0x40, rd: 0x80, wr: 0xa0, side: 0, inv: 0x00, nmi: true },
  // WD2791: inverted data bus (every register value is complemented), no NMI, side from the latch
  premier: { fdc: 0x40, dsk: 0x44, rd: 0x80, wr: 0xa0, side: 0, inv: 0xff, nmi: false },
  // the Dragon Alpha's built-in WD2797: registers reversed at $FF2C-$FF2F, the latch is the AY-3-8912's port A
  // (through PIA2), NMI gated by PIA2 CA2, DRQ on PIA2 CB1; the firmware is the 8K boot ROM at $A000; drives 0
  // and 1 are fitted (selecting 2 selects no drive), so the DMK drive is left out
  alpha: { regs: [0x2f, 0x2e, 0x2d, 0x2c], rd: 0x88, wr: 0xa8, side: 0x02, inv: 0x00, nmi: true, org: 0xa000, drives: 2 },
};
// control latch values
function dsk(board, drive, { motor = true, fm = false, nmi = true, halt = false, side = 0 } = {}) {
  if (board === 'dragon') return drive | (motor ? 0x04 : 0) | (fm ? 0x08 : 0) | (nmi ? 0x20 : 0);
  if (board === 'premier') return drive | (side ? 0x04 : 0) | (fm ? 0 : 0x10);     // the selected drive's motor runs
  if (board === 'alpha') return (1 << drive) | (fm ? 0x20 : 0);                     // every write runs all the motors
  // CoCo: double density and NMI enable share bit 5
  const sel = [0x01, 0x02, 0x04, 0x40][drive];
  return sel | (side && drive !== 3 ? 0x40 : 0) | (motor ? 0x08 : 0) | (fm ? 0 : 0x20) | (halt ? 0x80 : 0);
}

function boot() {
  return `* boot.asm: generated by tools/mame-diff/fdc/gen-diag.js (our own code, in place of the BASIC ROM)
        ORG     $8000
RESET   ORCC    #$50
        LDS     #$7F00
        JMP     $C000
        ORG     $BFF2
        FDB     $C009,$C009,$C006,$C009,$C009,$C003,RESET
`;
}

function boot3() {
  return `* boot3.asm: generated by tools/mame-diff/fdc/gen-diag.js (our own code, in place of the CoCo 3 BASIC ROM)
        ORG     $8000
RESET   ORCC    #$50
        LDS     #$7F00
        LDA     #$04
        STA     $FF90
        JMP     $C000
        ORG     $FFF2
        FDB     $C009,$C009,$C006,$C009,$C009,$C003,RESET
`;
}

// the data byte the format firmware writes on track t, side h: differs per track and side, never a write track
// control byte (F5-F7)
const formatFill = (t, h) => { const v = (t * 5 + h * 0x55 + 0x11) & 0xff; return v >= 0xf5 && v <= 0xf7 ? v - 8 : v; };
// the presets the format firmware is generated for (the blank disks compared with MAME: tools/mame-diff/fdc/spec.js)
const FORMATS = { dragon: [[40, 1], [40, 2], [80, 2]], premier: [[40, 1]], coco: [[35, 1], [40, 2]] };

function diag(board, kind = 'diag', { tracks = 40, heads = 1 } = {}) {
  const B = BOARDS[board];
  const L = [];
  const e = (s) => L.push(s);
  let uid = 0;
  const lab = (p) => `${p}${++uid}`;
  const hx = (v) => `$${v.toString(16).toUpperCase().padStart(2, '0')}`;
  // the WD2791's inverted bus: values written to and status bits read from the chip are complemented
  const I = B.inv, ifSet = I ? 'BEQ' : 'BNE', ifClr = I ? 'BNE' : 'BEQ';
  const R = B.regs || [B.fdc, B.fdc + 1, B.fdc + 2, B.fdc + 3];
  const STAT = `<${hx(R[0])}`, TRK = `<${hx(R[1])}`, SEC = `<${hx(R[2])}`, DAT = `<${hx(R[3])}`, DSK = B.dsk ? `<${hx(B.dsk)}` : null;
  // Alpha: the latch goes out through the AY (AYLAT), and the NMI gate is PIA2 CA2 (AYLATN opens it)
  const latch = (drive, o = {}) => {
    e(`        LDA     #${hx(dsk(board, drive, o))}`);
    if (board === 'alpha') e(`        JSR     ${o.nmi === false ? 'AYLAT' : 'AYLATN'}`); else e(`        STA     ${DSK}`);
  };
  const cmd = (c) => { e(`        LDB     #${hx(c ^ I)}`); e(`        STB     ${STAT}`); };
  const regw = (reg, v) => { e(`        LDA     #${hx(v ^ I)}`); e(`        STA     ${reg}`); };
  const log = (r) => e(`        ST${r}     ,U+`);
  const delay = (n) => { const l = lab('DL'); e(`        LDB     #${n}`); e(`${l}    DECB`); e(`        BNE     ${l}`); };
  const call = (r) => e(`        JSR     ${r}`);
  const rd = (sector, { cmdv = B.rd, dest = 0x1000 } = {}) => {
    regw(SEC, sector); delay(8);
    e(`        LDX     #$${dest.toString(16)}`); cmd(cmdv); call('READBUF');
  };
  const seek = (track, rate = 0, verify = false) => {
    regw(DAT, track); cmd(0x10 | rate | (verify ? 0x04 : 0)); call('WAITNB'); e(`        LDA     ${TRK}`); log('A');
  };
  const sum = () => { e(`        LDX     #$1000`); e(`        LDY     #256`); call('CSUM'); };

  e(`* ${board}${kind === 'diag' ? '' : kind === 'format' ? `-format-${tracks}x${heads}` : `-${kind}`}.asm: generated by tools/mame-diff/fdc/gen-diag.js (our own code, in place of the DOS ROM)`);
  e(`NMICNT  EQU     $0F00`);
  e(`NMIX    EQU     $0F01`);
  e(`NMIRET  EQU     $0F02`);
  e(`NMIREF  EQU     $0F04`);
  e(`BVAL    EQU     $0F05`);
  e(`        ORG     $${(B.org || 0xc000).toString(16).toUpperCase()}`);
  e(`        JMP     START`);
  e(`        JMP     NMIH`);
  e(`        JMP     FIRQH`);
  e(`        JMP     IRQH`);
  // ---- handlers
  e(`NMIH    INC     NMICNT`);
  e(`        TST     NMIX`);
  e(`        BNE     NMIOUT`);
  e(`        RTI`);
  e(`NMIOUT  CLR     NMIX`);
  e(`        LEAS    12,S`);
  e(`        JMP     [NMIRET]`);
  // Dragon CART (DRQ) on PIA1 CB1: one byte per FIRQ, B and X belong to the handler during the transfer
  e(`FIRQH   LDB     ${DAT}`);
  e(`        STB     ,X+`);
  e(`        LDB     ${board === 'alpha' ? '$FF26' : '$FF22'}`);
  e(`        RTI`);
  e(`IRQH    RTI`);
  if (board === 'alpha') {
    // AY-3-8912 register write through PIA2 (port B the AY's bus; port A: $07 latch address, $05 write data, $04
    // idle, PA2 kept high so the boot ROM stays in): B = register, A = value
    e(`AYW     STB     $FF26`); e(`        LDB     #$07`); e(`        STB     $FF24`); e(`        LDB     #$04`); e(`        STB     $FF24`);
    e(`        STA     $FF26`); e(`        LDB     #$05`); e(`        STB     $FF24`); e(`        LDB     #$04`); e(`        STB     $FF24`); e(`        RTS`);
    // the disk latch (AY port A = A), with the NMI gate shut (AYLAT: CA2 low) or open (AYLATN: CA2 high); B kept
    e(`AYLAT   PSHS    B`); e(`        LDB     #$34`); e(`        STB     $FF25`); e(`        BRA     AYL1`);
    e(`AYLATN  PSHS    B`); e(`        LDB     #$3C`); e(`        STB     $FF25`);
    e(`AYL1    LDB     #14`); e(`        BSR     AYW`); e(`        PULS    B,PC`);
  }
  // ---- subroutines
  // wait until not busy; log the status (a read clears INTRQ)
  e(`WAITNB  LDA     ${STAT}`);
  e(`        BITA    #1`);
  e(`        ${ifSet}     WAITNB`);
  e(`        STA     ,U+`);
  e(`        RTS`);
  // read bytes on DRQ to X until not busy; log status and the count
  e(`READBUF PSHS    X`);
  e(`RB1     LDA     ${STAT}`);
  e(`        BITA    #2`);
  e(`        ${ifSet}     RB2`);
  e(`        BITA    #1`);
  e(`        ${ifSet}     RB1`);
  e(`        BRA     RB3`);
  e(`RB2     LDB     ${DAT}`);
  e(`        STB     ,X+`);
  e(`        BRA     RB1`);
  e(`RB3     STA     ,U+`);
  e(`        TFR     X,D`);
  e(`        SUBD    ,S++`);
  e(`        STD     ,U++`);
  e(`        RTS`);
  // write bytes from X on DRQ until not busy; log status and the count
  e(`WRITBUF PSHS    X`);
  e(`WB1     LDA     ${STAT}`);
  e(`        BITA    #2`);
  e(`        ${ifSet}     WB2`);
  e(`        BITA    #1`);
  e(`        ${ifSet}     WB1`);
  e(`        BRA     RB3`);
  e(`WB2     LDB     ,X+`);
  e(`        STB     ${DAT}`);
  e(`        BRA     WB1`);
  // read Y bytes on DRQ to X, then force interrupt; log the status
  e(`READN   LDA     ${STAT}`);
  e(`        BITA    #2`);
  e(`        ${ifSet}     RN2`);
  e(`        BITA    #1`);
  e(`        ${ifSet}     READN`);
  e(`        BRA     RN3`);
  e(`RN2     EQU     *`);
  e(`        LDB     ${DAT}`);
  e(`        STB     ,X+`);
  e(`        LEAY    -1,Y`);
  e(`        BNE     READN`);
  e(`RN3     LDB     #${hx(0xd0 ^ I)}`);
  e(`        STB     ${STAT}`);
  e(`RN0     LDB     #8`);
  e(`RN1     DECB`);
  e(`        BNE     RN1`);
  e(`        LDA     ${STAT}`);
  e(`        STA     ,U+`);
  e(`        RTS`);
  // write Y bytes from X on DRQ (fast loop), wait for the next DRQ (the following sector has started), then
  // force interrupt; log the status
  e(`WRITEN  LDB     ,X+`);
  e(`WN1     LDA     ${STAT}`);
  e(`        BITA    #2`);
  e(`        ${ifClr}     WN1`);
  e(`        STB     ${DAT}`);
  e(`        LEAY    -1,Y`);
  e(`        BNE     WRITEN`);
  e(`WN2     LDA     ${STAT}`);
  e(`        BITA    #2`);
  e(`        ${ifSet}     RN3`);
  e(`        BITA    #1`);
  e(`        ${ifSet}     WN2`);
  e(`        BRA     RN3`);
  // checksum of Y bytes at X into D (logged)
  e(`CSUM    LDD     #0`);
  e(`CS1     ADDB    ,X+`);
  e(`        ADCA    #0`);
  e(`        LEAY    -1,Y`);
  e(`        BNE     CS1`);
  e(`        STD     ,U++`);
  e(`        RTS`);
  // fill: Y bytes of the pattern A + 3i at X
  e(`FILL    STA     ,X+`);
  e(`        ADDA    #3`);
  e(`        LEAY    -1,Y`);
  e(`        BNE     FILL`);
  e(`        RTS`);
  // build a track image at $4000 from the run table at Y (count word, byte; count 0 ends); X = end
  e(`BUILD   LDX     #$4000`);
  e(`BU1     LDD     ,Y++`);
  e(`        BEQ     BU3`);
  e(`        PSHS    D`);
  e(`        LDB     ,Y+`);
  e(`        STB     BVAL`);
  e(`BU2     LDB     BVAL`);
  e(`        STB     ,X+`);
  e(`        LDD     ,S`);
  e(`        SUBD    #1`);
  e(`        STD     ,S`);
  e(`        BNE     BU2`);
  e(`        LEAS    2,S`);
  e(`        BRA     BU1`);
  e(`BU3     RTS`);
  // write bytes from X on DRQ until not busy, fast enough for MFM: DRQ is sampled at most 14 cycles apart and
  // written at most 23 cycles after it rises (a byte lasts 28); log status and count
  e(`WRFAST  PSHS    X`);
  e(`WF0     LDB     ,X+`);
  e(`WF1     LDA     ${STAT}`);
  e(`        BITA    #2`);
  e(`        ${ifSet}     WF2`);
  e(`        LDA     ${STAT}`);
  e(`        BITA    #2`);
  e(`        ${ifSet}     WF2`);
  e(`        BITA    #1`);
  e(`        ${ifSet}     WF1`);
  e(`        LEAX    -1,X`);
  e(`        BRA     WFEND`);
  e(`WF2     STB     ${DAT}`);
  e(`        BRA     WF0`);
  e(`WFEND   LDA     ${STAT}`);
  e(`        STA     ,U+`);
  e(`        TFR     X,D`);
  e(`        SUBD    ,S++`);
  e(`        STD     ,U++`);
  e(`        RTS`);
  // count loop passes (Y) until the status's bit A changes from the level in B; log Y
  e(`WAITIP  LDY     #0`);
  e(`WI1     LEAY    1,Y`);
  e(`        BEQ     WI2`);
  e(`        LDA     ${STAT}`);
  e(`        ANDA    #2`);
  e(`        PSHS    A`);
  e(`        CMPB    ,S+`);
  e(`        BEQ     WI1`);
  e(`WI2     STY     ,U++`);
  e(`        RTS`);

  // ---------------- the Multi-Pak's part (kind 'multi'): the controller in slot 4, slots 1-3 empty
  const MP = (v) => { e(`        LDA     #${hx(v)}`); e(`        STA     $FF7F`); };
  function multi() {
    latch(0, {});
    cmd(0xd0); delay(20);
    // $FF7F reads back the selection OR $CC (the front-panel switch at slot 4 selected $FF at reset)
    e(`        LDA     $FF7F`); log('A');
    MP(0x32); e(`        LDA     $FF7F`); log('A');
    // SCS on slot 1 (empty): the controller's registers read 00 and take no writes
    MP(0x33); regw(TRK, 0x21); delay(4); e(`        LDA     ${TRK}`); log('A');
    MP(0x30); e(`        LDA     $FF7F`); log('A');
    e(`        LDA     ${STAT}`); log('A'); e(`        LDA     ${TRK}`); log('A');
    regw(TRK, 0x5a); cmd(0x00); delay(20);
    MP(0x33); e(`        LDA     ${TRK}`); log('A'); e(`        LDA     ${STAT}`); log('A');
    // a seek started on slot 4 ends while SCS is on slot 1: NMI still reaches the CPU (the Premier has none: wait,
    // then read the status back on slot 4)
    // (the head is on track 7, where the last test left it; the track register says so again by now)
    regw(TRK, 7); regw(DAT, 3); delay(4);
    e(`        LDY     #0`);
    if (B.nmi) {
      e(`        LDA     NMICNT`); e(`        STA     NMIREF`);
      cmd(0x10); MP(0x30);
      { const l = lab('MN'); e(`${l}    LEAY    1,Y`); e(`        LDA     NMICNT`); e(`        CMPA    NMIREF`); e(`        BEQ     ${l}`); }
    } else {
      cmd(0x10); MP(0x30);
      { const l = lab('MW'); e(`${l}    LEAY    1,Y`); e(`        CMPY    #6000`); e(`        BNE     ${l}`); }
    }
    e(`        STY     ,U++`);
    MP(0x33); e(`        LDA     ${STAT}`); log('A'); e(`        LDA     ${TRK}`); log('A');
    if (board === 'coco') {
      // HALT passes through too: a read with HALT enabled while SCS is on slot 1, so the loop reads 00 from the
      // empty slot, stopping until each DRQ (the bytes are lost); NMI at INTRQ ends it
      regw(SEC, 2); delay(8);
      e(`        LDD     #MPHEND`); e(`        STD     NMIRET`); e(`        LDA     #1`); e(`        STA     NMIX`);
      e(`        LDX     #0`); cmd(0x80);
      latch(0, { halt: true });
      MP(0x30);
      e(`MPHLP   LEAX    1,X`); e(`        LDA     ${DAT}`); e(`        BRA     MPHLP`);
      e(`MPHEND  STX     ,U++`);
      MP(0x33); e(`        LDA     ${STAT}`); log('A');
      latch(0, {});
    }
    if (board === 'dragon') {
      // CART follows the slot CTS selects: a read whose DRQ rises while CTS is on slot 1 sets no flag on PIA1 CB1
      // (rising edge, interrupts masked); selecting slot 4 again brings DRQ's CART in, a rising edge. This part
      // runs from RAM ($0D00), as $C000 is slot 1's (empty) meanwhile. No NMI: the vector is in slot 4's ROM.
      latch(0, { nmi: false });
      e(`        LDA     #$03`); e(`        STA     $FF23`); e(`        LDA     #$FF`); e(`        STA     $FF22`);
      e(`        LDA     #$07`); e(`        STA     $FF23`); e(`        CLR     $FF22`); e(`        LDA     $FF22`);
      regw(SEC, 3); delay(8);
      e(`        LDX     #MPRAM`); e(`        LDY     #$0D00`);
      e(`MPCP    LDA     ,X+`); e(`        STA     ,Y+`); e(`        CMPX    #MPRAME`); e(`        BNE     MPCP`);
      e(`        JSR     $0D00`);
      e(`        LDX     #$1000`); call('READBUF');
      e(`        LDA     $FF22`); e(`        LDA     #$04`); e(`        STA     $FF23`);
      e(`        BRA     MPDONE`);
      // position-independent: copied to $0D00
      e(`MPRAM   LDA     #$03`); e(`        STA     $FF7F`);
      e(`        LDA     $FF23`); log('A');
      cmd(B.rd);
      e(`MPR1    LDA     ${STAT}`); e(`        BITA    #2`); e(`        BNE     MPR2`); e(`        BITA    #1`); e(`        BNE     MPR1`);
      e(`MPR2    STA     ,U+`);
      e(`        LDA     $FF23`); log('A');
      e(`        LDA     $C000`); log('A'); e(`        LDA     $FEFF`); log('A');
      e(`        LDA     #$33`); e(`        STA     $FF7F`);
      e(`        LDA     $FF23`); log('A');
      e(`        RTS`);
      e(`MPRAME  EQU     *`);
      e(`MPDONE  EQU     *`);
    }
    e(`        LDA     $FF7F`); log('A');
  }

  // ---------------- the tests
  // RAM below the stack starts in a state MAME and we fill differently: clear $0000-$7EFF first
  if (board === 'alpha') {
    e(`START   ORCC    #$50`); e(`        LDS     #$7F00`);
    // PIA2: port A bits 0-2 out ($04 idle: PA2 high keeps the boot ROM), CA2 output low; port B all out
    e(`        CLR     $FF25`); e(`        LDA     #$07`); e(`        STA     $FF24`); e(`        LDA     #$34`); e(`        STA     $FF25`);
    e(`        LDA     #$04`); e(`        STA     $FF24`);
    e(`        CLR     $FF27`); e(`        LDA     #$FF`); e(`        STA     $FF26`); e(`        LDA     #$04`); e(`        STA     $FF27`);
    // AY register 7: port A an output (tone and noise off): the latch now reaches the disk interface
    e(`        LDA     #$7F`); e(`        LDB     #7`); e(`        JSR     AYW`);
    e(`        LDX     #$0000`);
  } else e(`START   LDX     #$0000`);
  e(`        LDD     #$0000`);
  e(`CLRRAM  STD     ,X++`);
  e(`        CMPX    #$7F00`);
  e(`        BNE     CLRRAM`);
  e(`        LDA     #$FF`);
  e(`        TFR     A,DP`);
  e(`        LDU     #$6000`);
  e(`        CLR     NMICNT`);
  e(`        CLR     NMIX`);
  // the format firmware's track table: one MFM track, IDs and data patched per track and side (FTRACK)
  const mfm18 = (track, side, fill) => {
    const r = [[32, 0x4e]];
    for (let s = 1; s <= 18; s++) r.push([12, 0x00], [3, 0xf5], [1, 0xfe], [1, track], [1, side], [1, s], [1, 1], [1, 0xf7], [22, 0x4e], [12, 0x00], [3, 0xf5], [1, 0xfb], [256, fill], [1, 0xf7], [24, 0x4e]);
    r.push([600, 0x4e]);
    return r;
  };
  if (kind === 'format') {
    // side select: the WD2797 takes it in the command (U, bit 1); the CoCo and Premier boards from the latch
    const sideCmd = board === 'dragon';
    const side = (h) => { if (!sideCmd) latch(0, { nmi: false, side: h }); };
    latch(0, { nmi: false });
    cmd(0xd0); delay(20);
    cmd(0x00); call('WAITNB');
    // what the blank holds: sector 1 of track 0, sector 18 of the last track and side
    rd(1); sum();
    seek(tracks - 1);
    side(heads - 1);
    rd(18, { cmdv: B.rd | (sideCmd && heads === 2 ? B.side : 0) }); sum();
    side(0);
    // every track and side
    e(`CURT    EQU     $0F10`);
    e(`CURH    EQU     $0F11`);
    e(`        CLR     CURT`);
    e(`FLOOP   LDA     CURT`);
    e(`        STA     ${DAT}`);
    if (I) e(`        COM     ${DAT}`);
    delay(4);
    cmd(0x10); call('WAITNB');
    e(`        CLR     CURH`);
    call('FTRACK');
    if (heads === 2) {
      e(`        LDA     #1`); e(`        STA     CURH`);
      side(1); call('FTRACK'); side(0);
    }
    e(`        INC     CURT`);
    e(`        LDA     CURT`);
    e(`        CMPA    #${tracks}`);
    e(`        LBNE    FLOOP`);
    // read back: the last track and side's sector 18, then sector 1 of track 0
    side(heads - 1);
    rd(18, { cmdv: B.rd | (sideCmd && heads === 2 ? B.side : 0) }); sum();
    side(0);
    cmd(0x00); call('WAITNB');
    rd(1); sum();
    e(`        LBRA    FDONE`);
    // FTRACK: the track table built at $4000, the IDs' track and side and the data (FILLS) patched, written
    const tbl = mfm18(0, 0, 0xe5);
    const idAt = [], dataAt = [];
    let off = 0;
    for (const [n, v] of tbl) {
      if (n === 1 && v === 0xfe) idAt.push(off + 1);
      if (n === 256) dataAt.push(off);
      off += n;
    }
    // a track is verified as a formatter does (sector 18, the last written, read back) and written again, at most
    // three times, if that finds no record: a write track can end early (track 73 side 1 of 80 x 2 does, in MAME
    // and here alike)
    e(`TRIES   EQU     $0F12`);
    e(`FTRACK  LDA     #3`); e(`        STA     TRIES`);
    e(`FTRY    LDY     #FMTBLK`); call('BUILD');
    e(`        LDA     CURT`); e(`        ASLA`); e(`        ADDA    CURH`); e(`        LDX     #FILLS`); e(`        LDB     A,X`); e(`        STB     BVAL`);
    e(`        LDA     CURT`); if (I) e(`        COMA`);
    e(`        LDB     CURH`); if (I) e(`        COMB`);
    for (const a of idAt) { e(`        STA     $${(0x4000 + a).toString(16).toUpperCase()}`); e(`        STB     $${(0x4000 + a + 1).toString(16).toUpperCase()}`); }
    for (const a of dataAt) {
      const l = lab('FD');
      e(`        LDX     #$${(0x4000 + a).toString(16).toUpperCase()}`); e(`        LDA     BVAL`); e(`        LDB     #0`);
      e(`${l}    STA     ,X+`); e(`        DECB`); e(`        BNE     ${l}`);
    }
    e(`        LDX     #$4000`);
    if (sideCmd) {
      const l1 = lab('FS'), l2 = lab('FS');
      e(`        LDB     CURH`); e(`        BEQ     ${l1}`); e(`        LDB     #${hx(0xf2 ^ I)}`); e(`        BRA     ${l2}`);
      e(`${l1}    LDB     #${hx(0xf0 ^ I)}`); e(`${l2}    STB     ${STAT}`);
    } else cmd(0xf0);
    call('WRFAST');
    regw(SEC, 18); delay(8);
    e(`        LDX     #$1000`);
    if (sideCmd) {
      const l1 = lab('FR'), l2 = lab('FR');
      e(`        LDB     CURH`); e(`        BEQ     ${l1}`); e(`        LDB     #${hx((B.rd | B.side) ^ I)}`); e(`        BRA     ${l2}`);
      e(`${l1}    LDB     #${hx(B.rd ^ I)}`); e(`${l2}    STB     ${STAT}`);
    } else cmd(B.rd);
    call('READBUF');
    e(`        LDA     -3,U`); e(`        BITA    #$10`); e(`        ${I ? 'BNE' : 'BEQ'}     FOK`);
    e(`        DEC     TRIES`); e(`        LBNE    FTRY`);
    e(`FOK     RTS`);
    // the data byte per (track, side), already as the bus carries it
    e(`FILLS`);
    for (let t = 0; t < tracks; t++) e(`        FCB     ${hx(formatFill(t, 0) ^ I)},${hx(formatFill(t, 1) ^ I)}`);
    e(`FDONE   EQU     *`);
  } else if (kind === 'write') {
    // the write firmware: on drives 0 and 1, restore, seek track 1, write sector 3 (drive 0: $11 + 3i,
    // drive 1: $22 + 3i), read it back and log the status, count and checksum; drive 1 may be write-protected
    for (const [drive, first] of [[0, 0x11], [1, 0x22]]) {
      latch(drive, { nmi: false });
      cmd(0xd0); delay(20);
      // the Alpha's READY is not tied: the drive is ready two index pulses after its motor starts
      if (board === 'alpha') { const l = lab('RDY'); e(`${l}    LDA     ${STAT}`); e(`        ${I ? 'BPL' : 'BMI'}     ${l}`); }
      cmd(0x00); call('WAITNB');
      seek(1);
      e(`        LDX     #$1200`); e(`        LDY     #256`); e(`        LDA     #${hx(first)}`); call('FILL');
      regw(SEC, 3); delay(8);
      e(`        LDX     #$1200`); cmd(B.wr); call('WRFAST');
      rd(3); sum();
    }
  } else {
    // S0: the restore the chip starts after reset, then force interrupt; register commit delays
    e(`        LDA     ${STAT}`); log('A');
    cmd(0xd0); delay(20);
    e(`        LDA     ${STAT}`); log('A');
    regw(TRK, 0x55); e(`        LDB     ${TRK}`); log('B'); delay(4); e(`        LDB     ${TRK}`); log('B');
    regw(SEC, 0xaa); e(`        LDB     ${SEC}`); log('B'); delay(4); e(`        LDB     ${SEC}`); log('B');
    regw(DAT, 0x3c); e(`        LDB     ${DAT}`); log('B');
    // S1: drive 0, motor on; index pulses (IP in the type I status)
    latch(0, {});
    cmd(0xd0); delay(20);
    e(`        LDA     ${STAT}`); log('A');
    for (const level of [0, 2, 0, 2]) { e(`        LDB     #${level ^ (I & 2)}`); call('WAITIP'); }
    // S2: restore, seek at every rate, verify
    cmd(0x00); call('WAITNB'); e(`        LDA     ${TRK}`); log('A');
    seek(5, 3);
    seek(8, 1, true);
    seek(6, 2);
    // step in with update, step out without, step (last direction), step out with update
    cmd(0x50); call('WAITNB'); e(`        LDA     ${TRK}`); log('A');
    cmd(0x60); call('WAITNB'); e(`        LDA     ${TRK}`); log('A');
    cmd(0x20); call('WAITNB'); e(`        LDA     ${TRK}`); log('A');
    cmd(0x71); call('WAITNB'); e(`        LDA     ${TRK}`); log('A');
    // restore with head load and verify at the slowest rate; then step out below track 0 with update
    cmd(0x0f); call('WAITNB'); e(`        LDA     ${TRK}`); log('A');
    cmd(0x70); call('WAITNB'); e(`        LDA     ${TRK}`); log('A');
    // verify failure: track register 20 with the head at 0 -> RNF after five index pulses
    regw(TRK, 20); delay(8);
    cmd(0x44); call('WAITNB'); e(`        LDA     ${TRK}`); log('A');
    cmd(0x00); call('WAITNB');
    // S3: read address on track 5
    seek(5);
    e(`        LDX     #$1000`); cmd(0xc0); call('READBUF'); e(`        LDA     ${SEC}`); log('A');
    e(`        LDX     #$1000`); e(`        LDY     #6`); call('CSUM');
    // S4: read sector 3; sector 18 with the E delay; two sectors of a multi-sector read
    rd(3); sum();
    rd(18, { cmdv: B.rd | 0x04 }); sum();
    regw(SEC, 17); delay(8);
    e(`        LDX     #$1000`); e(`        LDY     #512`); cmd(B.rd | 0x10); call('READN'); e(`        LDA     ${SEC}`); log('A');
    e(`        LDX     #$1100`); e(`        LDY     #256`); call('CSUM');
    // lost data: no one takes the bytes
    regw(SEC, 1); delay(8); cmd(B.rd); call('WAITNB');
    // record not found
    rd(30);
    // S5: write sector 4, read it back; deleted data mark on sector 6
    e(`        LDX     #$1200`); e(`        LDY     #256`); e(`        LDA     #$21`); call('FILL');
    regw(SEC, 4); delay(8);
    e(`        LDX     #$1200`); cmd(B.wr); call('WRFAST');
    rd(4); sum();
    e(`        LDX     #$1200`); e(`        LDY     #256`); e(`        LDA     #$7F`); call('FILL');
    regw(SEC, 6); delay(8);
    e(`        LDX     #$1200`); cmd(B.wr | 0x01); call('WRFAST');
    rd(6); sum();
    // S6: read track 5
    e(`        LDX     #$2000`); cmd(0xe0); call('READBUF');
    e(`        LDX     #$2000`); e(`        LDY     #6000`); call('CSUM');
    // S7: write track 10 (18 sectors, MFM), read address and sector 9 back
    seek(10);
    e(`        LDY     #FMTMFM`); call('BUILD');
    e(`        LDX     #$4000`); cmd(0xf0); call('WRFAST');
    e(`        LDX     #$1000`); cmd(0xc0); call('READBUF');
    rd(9); sum();
    // S8: side 1 of track 5
    seek(5);
    if (board === 'dragon' || board === 'alpha') { rd(2, { cmdv: B.rd | B.side }); sum(); }
    else {
      latch(0, { side: 1 });
      rd(2); sum();
      rd(2, { cmdv: 0x8a }); sum();
      // Premier: the WD2791 compares the side too, so asking for side 0 on side 1 finds no record
      if (board === 'premier') rd(2, { cmdv: 0x82 });
      latch(0, {});
    }
    // S9: Dragon: sector length from the b flag (b = 0: code 1 means 512 bytes, past the sector's CRC)
    if (board === 'dragon' || board === 'alpha') { rd(5, { cmdv: 0x80, dest: 0x2000 }); }
    // Premier: bit 3 is the S flag, not b: without C it changes nothing and the length code alone counts
    if (board === 'premier') { rd(5, { cmdv: 0x88, dest: 0x2000 }); }
    // S10: write protect (drive 1): type I status, write sector, write track
    latch(1, {});
    cmd(0x00); call('WAITNB');
    cmd(0xd0); delay(20); e(`        LDA     ${STAT}`); log('A');
    regw(SEC, 1); delay(8);
    e(`        LDX     #$1200`); cmd(B.wr); call('WRFAST');
    e(`        LDX     #$4000`); cmd(0xf0); call('WRFAST');
    rd(1); sum();
    // S11: drive 3 (DMK): seek, read, write, read back (boards with four drives)
    if ((B.drives || 4) > 3) {
      latch(3, {});
      cmd(0x00); call('WAITNB');
      seek(3);
      rd(7); sum();
      e(`        LDX     #$1200`); e(`        LDY     #256`); e(`        LDA     #$44`); call('FILL');
      regw(SEC, 8); delay(8);
      e(`        LDX     #$1200`); cmd(B.wr); call('WRFAST');
      rd(8); sum();
    }
    // S12: drive 2 has no disk (on the Alpha: no drive 2 fitted, so no drive is selected): no index pulse, a read
    // address never ends until force interrupt
    latch(2, {});
    cmd(0xd0); delay(20); e(`        LDA     ${STAT}`); log('A');
    cmd(0xc0);
    e(`        LDY     #3000`);
    { const l = lab('ND'); e(`${l}    LDA     ${STAT}`); e(`        LEAY    -1,Y`); e(`        BNE     ${l}`); }
    log('A');
    cmd(0xd0); delay(20); e(`        LDA     ${STAT}`); log('A');
    // S13: force interrupts on drive 0: immediate (INTRQ until the next command), index, during a seek
    latch(0, { nmi: true });
    if (B.nmi) {
      cmd(0x00); call('WAITNB');
      e(`        LDA     NMICNT`); log('A');
      cmd(0xd8); delay(40);
      e(`        LDA     ${STAT}`); log('A'); e(`        LDA     ${STAT}`); log('A');
      e(`        LDA     NMICNT`); log('A');
      cmd(0xd0); delay(20); e(`        LDA     ${STAT}`); log('A');
      e(`        LDA     NMICNT`); e(`        STA     NMIREF`);
      cmd(0xd4);
      e(`        LDY     #0`);
      { const l = lab('IX'); e(`${l}    LEAY    1,Y`); e(`        LDA     NMICNT`); e(`        CMPA    NMIREF`); e(`        BEQ     ${l}`); }
      e(`        STY     ,U++`);
      cmd(0xd0); delay(20); e(`        LDA     ${STAT}`); log('A');
      regw(DAT, 30); cmd(0x13); delay(200);
      e(`        LDA     ${STAT}`); log('A'); cmd(0xd0); delay(20); e(`        LDA     ${STAT}`); log('A'); e(`        LDA     ${TRK}`); log('A');
      // the interrupted seek left the head a step ahead of the track register (it steps, then counts): restore
      cmd(0x00); call('WAITNB');
      // NMI at the end of a seek
      e(`        LDA     NMICNT`); log('A'); e(`        STA     NMIREF`);
      regw(DAT, 12); cmd(0x10);
      e(`        LDY     #0`);
      { const l = lab('NM'); e(`${l}    LEAY    1,Y`); e(`        LDA     NMICNT`); e(`        CMPA    NMIREF`); e(`        BEQ     ${l}`); }
      e(`        STY     ,U++`);
      e(`        LDA     ${STAT}`); log('A');
    } else {
      // no interrupt reaches the CPU: the status alone shows each force interrupt and the interrupted seek
      cmd(0x00); call('WAITNB');
      cmd(0xd8); delay(40);
      e(`        LDA     ${STAT}`); log('A'); e(`        LDA     ${STAT}`); log('A');
      cmd(0xd0); delay(20); e(`        LDA     ${STAT}`); log('A');
      cmd(0xd4); delay(200); e(`        LDA     ${STAT}`); log('A');
      cmd(0xd0); delay(20); e(`        LDA     ${STAT}`); log('A');
      regw(DAT, 30); cmd(0x13); delay(200);
      e(`        LDA     ${STAT}`); log('A'); cmd(0xd0); delay(20); e(`        LDA     ${STAT}`); log('A'); e(`        LDA     ${TRK}`); log('A');
      cmd(0x00); call('WAITNB');
      seek(12);
    }
    latch(0, {});
    // S14: FM: write track 12 (8 sectors), read address, sector 3, read track; then MFM again
    latch(0, { fm: true });
    cmd(0xd0); delay(40);
    seek(12);
    e(`        LDY     #FMTFM`); call('BUILD');
    e(`        LDX     #$4000`); cmd(0xf0); call('WRITBUF');
    e(`        LDX     #$1000`); cmd(0xc0); call('READBUF');
    if (board === 'dragon') {
      // one byte per FIRQ: DRQ drives CART, PIA1 CB1 rising edge
      // port B all outputs (output register 00), so reading it to clear CB1's flag returns a defined value
      e(`        LDA     #$03`); e(`        STA     $FF23`); e(`        LDA     #$FF`); e(`        STA     $FF22`);
      e(`        LDA     #$07`); e(`        STA     $FF23`); e(`        CLR     $FF22`); e(`        LDA     $FF22`);
      regw(SEC, 3); delay(8);
      e(`        LDX     #$1000`); e(`        ANDCC   #$BF`); cmd(B.rd); call('WAITNB');
      e(`        ORCC    #$40`); e(`        LDA     #$04`); e(`        STA     $FF23`);
      e(`        TFR     X,D`); e(`        STD     ,U++`);
    } else if (board === 'alpha') {
      // one byte per FIRQ: DRQ on PIA2 CB1, rising edge (CRB $07); the handler reads port B to clear the flag
      regw(SEC, 3); delay(8);
      e(`        LDA     #$07`); e(`        STA     $FF27`); e(`        LDA     $FF26`);
      e(`        LDX     #$1000`); e(`        ANDCC   #$BF`); cmd(B.rd); call('WAITNB');
      e(`        ORCC    #$40`); e(`        LDA     #$04`); e(`        STA     $FF27`);
      e(`        TFR     X,D`); e(`        STD     ,U++`);
    } else rd(3);
    sum();
    e(`        LDX     #$2000`); cmd(0xe0); call('READBUF');
    e(`        LDX     #$2000`); e(`        LDY     #3000`); call('CSUM');
    latch(0, {});
    cmd(0xd0); delay(20);
    e(`        LDY     #FMTMFM2`); call('BUILD');
    e(`        LDX     #$4000`); cmd(0xf0); call('WRFAST');
    rd(11); sum();
    // S15: CoCo: HALT transfer (the CPU stops until each DRQ; NMI at INTRQ ends the loop)
    if (board === 'coco') {
      seek(5);
      regw(SEC, 2); delay(8);
      e(`        LDD     #HALTEND`); e(`        STD     NMIRET`); e(`        LDA     #1`); e(`        STA     NMIX`);
      e(`        LDX     #$1000`); cmd(0x80);
      latch(0, { halt: true });
      e(`HALTLP  LDA     ${DAT}`); e(`        STA     ,X+`); e(`        BRA     HALTLP`);
      e(`HALTEND TFR     X,D`); e(`        STD     ,U++`);
      e(`        LDA     ${STAT}`); log('A');
      sum();
      latch(0, {});
    }
    // S16: multi-sector write (15, 16), then read both back
    seek(7);
    e(`        LDX     #$1200`); e(`        LDY     #512`); e(`        LDA     #$05`); call('FILL');
    regw(SEC, 15); delay(8);
    e(`        LDX     #$1200`); e(`        LDY     #512`); cmd(B.wr | 0x10); call('WRITEN'); e(`        LDA     ${SEC}`); log('A');
    rd(15); sum(); rd(16); sum();
    if (kind === 'multi') multi();
  }
  // motor off (the drive commits its disk), then HALT; the Premier runs the selected drive's motor, so
  // select the empty drive 2 (the Alpha's motors never stop: it deselects the drives)
  if (board === 'premier') latch(2, {});
  else if (board === 'alpha') latch(2, { nmi: false });   // the motors keep running: no drive selected
  else e(`        CLR     ${DSK}`);
  e(`        LDA     ${STAT}`); log('A');
  e(`        STU     $5FFE`);
  e(`HALT    BRA     HALT`);

  // ---------------- write track tables: (count, byte) runs
  const runs = (name, list) => {
    e(`${name}`);
    for (const [n, v] of list) e(`        FDB     ${n}\n        FCB     ${hx(v ^ I)}`);
    e(`        FDB     0`);
  };
  const mfm = (track, side) => {
    const r = [[32, 0x4e]];
    for (let s = 1; s <= 18; s++) r.push([12, 0x00], [3, 0xf5], [1, 0xfe], [1, track], [1, side], [1, s], [1, 1], [1, 0xf7], [22, 0x4e], [12, 0x00], [3, 0xf5], [1, 0xfb], [256, 0xe5], [1, 0xf7], [24, 0x4e]);
    r.push([600, 0x4e]);
    return r;
  };
  const fm = (track) => {
    const r = [[16, 0xff]];
    for (let s = 1; s <= 8; s++) r.push([6, 0x00], [1, 0xfe], [1, track], [1, 0], [1, s], [1, 1], [1, 0xf7], [11, 0xff], [6, 0x00], [1, 0xfb], [256, 0x30 + s], [1, 0xf7], [27, 0xff]);
    r.push([700, 0xff]);
    return r;
  };
  runs('FMTMFM', mfm(10, 0));
  runs('FMTFM', fm(12));
  runs('FMTMFM2', mfm(12, 0));
  if (kind === 'format') runs('FMTBLK', mfm18(0, 0, 0xe5));
  // the Alpha's firmware is the boot ROM: its own vectors (the entry table at $A000)
  if (board === 'alpha') { e(`        ORG     $BFF2`); e(`        FDB     $A009,$A009,$A006,$A009,$A009,$A003,START`); }
  return L.join('\n') + '\n';
}

function write() {
  writeAtomic(path.join(__dirname, 'boot.asm'), boot());
  writeAtomic(path.join(__dirname, 'boot3.asm'), boot3());
  for (const b of Object.keys(BOARDS)) {
    writeAtomic(path.join(__dirname, `${b}.asm`), diag(b));
    writeAtomic(path.join(__dirname, `${b}-write.asm`), diag(b, 'write'));
    if (b !== 'alpha') writeAtomic(path.join(__dirname, `${b}-multi.asm`), diag(b, 'multi'));
    for (const [tracks, heads] of FORMATS[b] || []) writeAtomic(path.join(__dirname, `${b}-format-${tracks}x${heads}.asm`), diag(b, 'format', { tracks, heads }));
  }
}
if (require.main === module) write();
module.exports = { write, dsk, BOARDS, FORMATS, formatFill };
