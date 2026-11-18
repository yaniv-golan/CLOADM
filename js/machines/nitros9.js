/*
 * Booting NitrOS-9 without a ROM: our own boot loaders for the CoCo 3, kept here as assembly source and assembled
 * with the project's assembler when first needed. Each takes the place of the CoCo 3's internal ROM (Super
 * Extended Color BASIC, which is never involved), reads the boot track of drive 0 and jumps into it, as Disk
 * BASIC's DOS command does:
 *   drivewire  DriveWire drive 0 over the Becker port (a DriveWire-aware Disk BASIC's DOS)
 *   floppy     floppy drive 0 on the CoCo disk controller (WD1773), whose own ROM is never used
 *
 *   NITROS9_LOADERS            { drivewire, floppy }: the sources
 *   nitros9LoaderRom(kind)     the 32K ROM image ($8000-$FFFF, unused bytes $FF), assembled once
 *   nitros9LoaderKind(rom)     'drivewire' | 'floppy' when rom is one of ours (the same bytes object), else null
 *   nitros9LoaderByCrc(crc)    the kind whose ROM has this CRC32, or null (Session.snapshotRoms: built in)
 *   NITROS9_STATUS             where a loader reports how far it got ($0100), and its codes
 *
 * Used by the page (Session.bootNitros9), tools/nitros9/ (our machine and MAME run the same image) and the tests.
 */
import { assemble } from '../asm/assembler.js';
import { crc32 } from '../util.js';

export const NITROS9_LOADERS = Object.freeze({
  drivewire: `* NitrOS-9 DriveWire boot loader for the CoCo 3 Becker port. Written for CLOADM (js/machines/nitros9.js); it replaces
* the CoCo 3's internal ROM in our machine and in MAME, so no Tandy or HDB-DOS code is involved.
*
* It does what the "DOS" command of a DriveWire-aware Disk BASIC does for NitrOS-9 (NitrOS-9
* level1/coco1/modules/rel.asm: "the boot track is loaded into memory at $26xx and then jumps into it at
* address $2602"): read the 18 sectors of track 34 (LSN 612-629) from DriveWire drive 0 to $2600 and, if they
* start with "OS", jump to $2602.
*
* Machine set-up a CoCo 3 ROM leaves for REL: the MMU's task registers 0 and 1 hold blocks $38-$3F (the top
* 64K, as at reset with the MMU off). REL switches to all-RAM mode itself ("clr >$FFDF  added for OS-9 ROM
* Kit boots", rel.asm) before it copies itself to $ED00. The vectors at $FFF2-$FFFE point at the constant page ($FEEE..),
* where NitrOS-9's kernel puts its BRA table (level2/modules/kernel/krn.asm: "This list of addresses ends up
* at $FEEE (CoCo 3)").
*
* Status for the harness at $0100: $00 running, $01 loaded and jumping, $E1 DriveWire error (code at $0101),
* $E2 not a boot track, $E3 a 6309 trap through $FFF0 before the kernel took the vectors.
STAT    EQU     $FF41
DATA    EQU     $FF42
STATUS  EQU     $0100
BTRACK  EQU     $2600
LSN0    EQU     612
        ORG     $8000
RESET   ORCC    #$50
        LDS     #$0FFF
        LDX     #$FFA0          ; MMU task 0 and task 1: blocks $38-$3F
        LDA     #$38
MMU     STA     8,X
        STA     ,X+
        INCA
        CMPX    #$FFA8
        BNE     MMU
        CLR     $FF91           ; task 0, 1.78 MHz timer source left as at reset
        LDA     #$4E            ; MMU on, constant page $FExx, spare chip select (Becker), 32K internal ROM
        STA     $FF90
        CLR     STATUS
        LDX     #BTRACK
        LDU     #LSN0
SECT    LDA     #$D2            ; Read Extended: op, drive, LSN (3 bytes)
        BSR     PUTB
        CLRA
        BSR     PUTB
        CLRA
        BSR     PUTB
        TFR     U,D
        BSR     PUTB
        TFR     B,A
        BSR     PUTB
        LDY     #0              ; the 256 bytes, summed
        CLRB
GET     PSHS    B
        BSR     GETB
        STA     ,X+
        LEAY    A,Y             ; (A is signed in LEA: sum it as unsigned below)
        TSTA
        BPL     GOK
        LEAY    256,Y
GOK     PULS    B
        DECB
        BNE     GET
        TFR     Y,D             ; checksum, high byte first
        PSHS    B
        BSR     PUTB
        PULS    A
        BSR     PUTB
        BSR     GETB            ; result
        TSTA
        BNE     DWERR
        LEAU    1,U
        CMPU    #LSN0+18
        BNE     SECT
        LDD     BTRACK
        CMPD    #$4F53          ; "OS"
        BNE     NOTOS
        LDA     #$01
        STA     STATUS
        JMP     BTRACK+2
DWERR   STA     STATUS+1
        LDA     #$E1
        BRA     STOP
NOTOS   LDA     #$E2
        BRA     STOP
TRAP    LDA     #$E3
STOP    STA     STATUS
HALT    BRA     HALT
PUTB    STA     DATA
        RTS
GETB    LDA     STAT
        BITA    #$02
        BEQ     GETB
        LDA     DATA
        RTS
        ORG     $FFF0
        FDB     TRAP,$FEEE,$FEF1,$FEF4,$FEF7,$FEFA,$FEFD,RESET
`,
  floppy: `* NitrOS-9 floppy boot loader for the CoCo 3 with the WD1773 disk controller cartridge. Written for CLOADM (js/machines/nitros9.js); it
* replaces the CoCo 3's internal ROM, so no Tandy code is involved (the cartridge's own ROM is never used).
*
* It does what Disk BASIC's DOS command does (NitrOS-9 level1/coco1/modules/rel.asm: "the boot track is loaded
* into memory at $26xx and then jumps into it at address $2602"): drive 0, motor on, double density; restore,
* seek track 34; read its 18 sectors (side 0) to $2600 the way DSKCON does, with the controller's HALT enable
* (the CPU waits for each byte's DRQ) and the end of the command signalled by INTRQ on NMI; if the track starts
* with "OS", jump to $2602.
*
* Controller (MAME src/devices/bus/coco/coco_fdc.cpp; Color Computer Disk System manual): $FF40 control latch
* (bits 0-2 drive select, 3 motor, 5 double density and NMI enable, 7 HALT enable), WD1773 at $FF48-$FF4B
* (command/status, track, sector, data). NMI = INTRQ while bit 5 is set; HALT = !DRQ while bit 7 is set.
*
* Machine set-up, as the DriveWire loader: MMU task registers 0 and 1 hold blocks
* $38-$3F, the constant page $FExx is RAM; the vectors point into it ($FEEE..), and NMI's ($FEFD) gets a JMP to
* our handler until NitrOS-9's kernel takes the page over.
*
* Status at $0100: $00 running, $01 loaded and jumping, $E1 controller error (status at $0101, sector at $0102),
* $E2 not a boot track, $E3 a 6309 trap through $FFF0.
DSKREG  EQU     $FF40
FDCCMD  EQU     $FF48
FDCTRK  EQU     $FF49
FDCSEC  EQU     $FF4A
FDCDAT  EQU     $FF4B
DRIVE0  EQU     $29             ; drive 0, motor on, double density (and NMI enabled)
STATUS  EQU     $0100
NMIFLG  EQU     $0103           ; nonzero: an NMI ends the sector transfer
BTRACK  EQU     $2600
        ORG     $8000
RESET   ORCC    #$50
        LDS     #$0FFF
        LDX     #$FFA0          ; MMU task 0 and task 1: blocks $38-$3F
        LDA     #$38
MMU     STA     8,X
        STA     ,X+
        INCA
        CMPX    #$FFA8
        BNE     MMU
        CLR     $FF91           ; task 0
        LDA     #$4E            ; MMU on, constant page $FExx, 32K internal ROM
        STA     $FF90
        CLR     STATUS
        CLR     NMIFLG
        LDA     #$7E            ; NMI: JMP NMIH at $FEFD
        STA     $FEFD
        LDX     #NMIH
        STX     $FEFE
        LDA     #$D0            ; force interrupt: stops the restore the WD1773 starts at master reset (as
        STA     FDCCMD          ; NitrOS-9's boot_1773.asm HWInit does), before NMI is enabled
        BSR     DELAY
        LDA     FDCCMD          ; (clears INTRQ)
        LDA     #DRIVE0
        STA     DSKREG
        LDX     #0              ; let the motor come up to speed (Disk BASIC waits too)
SPIN    LEAX    -1,X
        BNE     SPIN
        LDA     #$00            ; restore (6 ms steps)
        BSR     TYPE1
        LDA     #34
        STA     FDCDAT
        LDA     #$10            ; seek track 34
        BSR     TYPE1
        LDX     #BTRACK
        LDB     #1
SECT    STB     FDCSEC
        PSHS    B
        BSR     DELAY
        LDA     #1
        STA     NMIFLG
        LDA     #$80            ; read sector
        STA     FDCCMD
        BSR     DELAY
WDRQ    LDA     FDCCMD          ; the first byte: the controller's DRQ latch only follows the WD from its
        BITA    #$02            ; first DRQ on (coco_fdc.cpp starts it high), so HALT can't hold the first read
        BEQ     WDRQ            ; (an error ends the command first: NMI)
        LDA     #DRIVE0+$80     ; HALT enable: each read below waits for its byte
        STA     DSKREG
READ    LDA     FDCDAT
        STA     ,X+
        BRA     READ
DONE    LDA     #DRIVE0         ; (NMIH comes here when the command ends)
        STA     DSKREG
        LDA     FDCCMD
        ANDA    #$9C            ; not ready, record not found, CRC error, lost data
        PULS    B
        BNE     FDCERR
        INCB
        CMPB    #19
        BNE     SECT
        CLR     DSKREG          ; motor off
        LDD     BTRACK
        CMPD    #$4F53          ; "OS"
        BNE     NOTOS
        LDA     #$01
        STA     STATUS
        JMP     BTRACK+2
* a type I command (restore, seek): wait until it is no longer busy
TYPE1   STA     FDCCMD
        BSR     DELAY
T1WAIT  LDA     FDCCMD
        BITA    #$01
        BNE     T1WAIT
        RTS
* the WD1773 needs a few microseconds after a command before its status is valid
DELAY   PSHS    B
        LDB     #8
DL      DECB
        BNE     DL
        PULS    B,PC
* NMI: the end of a command. During a sector transfer it leaves the read loop (dropping the interrupt's frame);
* otherwise (INTRQ after a restore or seek) it returns
NMIH    TST     NMIFLG
        BNE     NMIEND
        RTI
NMIEND  CLR     NMIFLG
        LEAS    12,S
        BRA     DONE
FDCERR  STA     STATUS+1
        STB     STATUS+2
        LDA     #$E1
        BRA     STOP
NOTOS   LDA     #$E2
        BRA     STOP
TRAP    LDA     #$E3
STOP    STA     STATUS
HALT    BRA     HALT
        ORG     $FFF0
        FDB     TRAP,$FEEE,$FEF1,$FEF4,$FEF7,$FEFA,$FEFD,RESET
`,
});

// $E1: a DriveWire or controller error (its code or status at $0101; the floppy loader's sector at $0102)
export const NITROS9_STATUS = Object.freeze({ addr: 0x0100, running: 0x00, jumped: 0x01, ioError: 0xE1, notBootTrack: 0xE2, trap: 0xE3 });

const roms = {};
export function nitros9LoaderRom(kind) {
  if (!Object.hasOwn(NITROS9_LOADERS, kind)) throw new Error(`no NitrOS-9 loader "${kind}" (${Object.keys(NITROS9_LOADERS).join(', ')})`);
  if (roms[kind]) return roms[kind];
  const r = assemble(NITROS9_LOADERS[kind], '6809');
  if (!r.ok) throw new Error(`NitrOS-9 ${kind} loader: ` + r.errors.map((e) => `line ${e.line}: ${e.message}`).join('; '));
  const image = new Uint8Array(0x8000).fill(0xFF);
  for (const seg of r.segments) if (seg.addr >= 0x8000) image.set(seg.data.subarray(0, 0x10000 - seg.addr), seg.addr - 0x8000);
  roms[kind] = image;
  return image;
}
export const nitros9LoaderKind = (rom) => (rom ? Object.keys(NITROS9_LOADERS).find((k) => roms[k] === rom) || null : null);
export const nitros9LoaderByCrc = (crc) => Object.keys(NITROS9_LOADERS).find((k) => crc32(nitros9LoaderRom(k)) === crc) || null;
