// The disk controller with no ROM: a program that drives the controller itself, as a game reading its own level disk
// does, through the registers alone (no DOS, no NMI-driven transfer: it polls DRQ). Our own code, generated here for
// each board, in two builds of the same read routine:
//
//   source(board, 'rom')  in place of the BASIC ROM ($8000, its own vectors), with the cartridge ROM socket empty:
//                         reads track 0 sector 1 of drive 0 once and ends in HALT (run.js <profile> --fdc --bare,
//                         the lockstep comparison with MAME on an empty cartridge ROM)
//   source(board, 'ram')  a program at $3000 for the built-in firmware (no ROM at all): reads the sector at its start,
//                         shows the result on the top line, then counts in TICK and reads again each time TRIG is set
//                         (tests/disk-bare.test.js, the browser check). Its NMI goes through the firmware's RAM
//                         vector at $0109, which it points at its own handler.
//
// board: 'dragon' (the Dragon controller, WD2797 at $FF40-$FF43, the latch at $FF48: drive 0, motor on, double
// density, no NMI) or 'coco' (the CoCo controller, DSKREG at $FF40: drive 0, motor on, double density and NMI enable;
// the WD1773 at $FF48-$FF4B). The steps: restore, sector register 1, read sector, every byte taken on DRQ into BUF.
// What it leaves in memory (both builds): STAT the status after the read, CNT (2 bytes) the bytes read, BUF the
// sector, NMIC the NMIs taken, DONE the reads finished; the RAM build also TICK (2 bytes, the idle loop's count)
// and TRIG (set it to read again). Interrupts are masked during a read (the firmware's 60 Hz IRQ would cost a byte).
// A status of $FF reads as no controller (the read gives up at once, CNT 0).
const REGS = {
  dragon: { status: '$40', sector: '$42', data: '$43', select: '$48', on: '$04', off: '$00', read: '$88' },
  coco: { status: '$48', sector: '$4A', data: '$4B', select: '$40', on: '$29', off: '$00', read: '$80' },
};
const ADDR = { STAT: 0x0F00, CNT: 0x0F01, TICK: 0x0F03, TRIG: 0x0F05, DONE: 0x0F06, NMIC: 0x0F07, BUF: 0x1000 };

function source(board, build) {
  const r = REGS[board];
  if (!r) throw new Error(`gen-bare: no board ${board} (dragon or coco)`);
  if (build !== 'rom' && build !== 'ram') throw new Error(`gen-bare: build is rom or ram, not ${build}`);
  const rom = build === 'rom';
  return `* gen-bare.js: the ${board} disk controller driven with no ROM (${build} build); our own code
STAT    EQU     $${ADDR.STAT.toString(16).toUpperCase()}
CNT     EQU     $${ADDR.CNT.toString(16).toUpperCase()}
TICK    EQU     $${ADDR.TICK.toString(16).toUpperCase()}
TRIG    EQU     $${ADDR.TRIG.toString(16).toUpperCase()}
DONE    EQU     $${ADDR.DONE.toString(16).toUpperCase()}
NMIC    EQU     $${ADDR.NMIC.toString(16).toUpperCase()}
BUF     EQU     $${ADDR.BUF.toString(16).toUpperCase()}
        ORG     ${rom ? '$8000' : '$3000'}
${rom ? `START   ORCC    #$50
        LDS     #$7F00
        CLR     NMIC
        CLR     DONE
        JSR     READ
HALT    BRA     HALT` : `START   CLR     NMIC
        CLR     DONE
        CLR     TRIG
        LDD     #0
        STD     TICK
        LDA     #$7E            ; the firmware's NMI vector at $0109: JMP NMIH
        STA     $0109
        LDX     #NMIH
        STX     $010A
        JSR     READ
        JSR     SHOW
IDLE    LDD     TICK
        ADDD    #1
        STD     TICK
        TST     TRIG
        BEQ     IDLE
        CLR     TRIG
        JSR     READ
        JSR     SHOW
        BRA     IDLE`}
NMIH    INC     NMIC
        RTI
* read track 0 sector 1 of drive 0 into BUF; STAT, CNT
READ    PSHS    CC,DP
        ORCC    #$50
        LDA     #$FF
        TFR     A,DP
        LDD     #0
        STD     CNT
        LDA     <${r.status}
        CMPA    #$FF            ; nothing answers at the controller's address
        BEQ     RDOUT
        LDA     #${r.on}
        STA     <${r.select}
        LDB     #$00            ; restore
        STB     <${r.status}
        BSR     SETTLE
        BSR     NOTBSY
        LDA     #1
        STA     <${r.sector}
        LDB     #${r.read}            ; read sector, side 0${board === 'dragon' ? ' (the WD2797: IBM sector lengths, 256 bytes)' : ''}
        STB     <${r.status}
        BSR     SETTLE
        LDX     #BUF
RB1     LDA     <${r.status}
        BITA    #2
        BNE     RB2
        LSRA
        BCS     RB1
        BRA     RB3
RB2     LDB     <${r.data}
        STB     ,X+
        BRA     RB1
RB3     LDA     <${r.status}
        STA     STAT
        TFR     X,D
        SUBD    #BUF
        STD     CNT
        LDA     #${r.off}
        STA     <${r.select}
RDOUT   INC     DONE
        PULS    CC,DP,PC
SETTLE  LDB     #8              ; the busy bit is valid a few cycles after a command
SET1    DECB
        BNE     SET1
        RTS
NOTBSY  LDA     <${r.status}
        LSRA
        BCS     NOTBSY
        RTS
${rom ? `RTIV    RTI
        ORG     $BFF2
        FDB     RTIV,RTIV,RTIV,RTIV,RTIV,NMIH,START` : `* the top line: "READ OK" or "NO DISK", then the first four bytes read, in hex
SHOW    LDX     #$0400
        LDY     #MSGNO
        LDD     CNT
        CMPD    #256
        BNE     SH1
        TST     STAT
        BNE     SH1
        LDY     #MSGOK
SH1     LDA     ,Y+
        BEQ     SH2
        STA     ,X+
        BRA     SH1
SH2     LDY     #BUF
SH3     LDA     ,Y
        LSRA
        LSRA
        LSRA
        LSRA
        BSR     HEX
        LDA     ,Y+
        BSR     HEX
        LDA     #$60
        STA     ,X+
        CMPY    #BUF+4
        BNE     SH3
        RTS
HEX     ANDA    #$0F
        CMPA    #10
        BLO     HEX1
        SUBA    #9              ; A-F: the VDG's letters $01-$06, shown as normal text ($41-$46)
        ORA     #$40
        STA     ,X+
        RTS
HEX1    ORA     #$70            ; 0-9: $70-$79
        STA     ,X+
        RTS
MSGOK   FCC     "READ"          ; (a space is $60 on the VDG's screen)
        FCB     $60
        FCC     "OK"
        FCB     $60,0
MSGNO   FCC     "NO"
        FCB     $60
        FCC     "DISK"
        FCB     $60,0`}
        END     START
`;
}

// the ROM builds as files beside the other firmware (bare-dragon.asm, bare-coco.asm), as gen-diag.js writes its own
function write() {
  const fs = require('fs'), path = require('path');
  for (const board of Object.keys(REGS)) fs.writeFileSync(path.join(__dirname, `bare-${board}.asm`), source(board, 'rom'));
}
if (require.main === module) write();
module.exports = { source, write, ADDR, BOARDS: Object.keys(REGS) };
