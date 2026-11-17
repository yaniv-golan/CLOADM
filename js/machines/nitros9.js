/*
 * Booting NitrOS-9 without a ROM: our own DriveWire boot loader for the CoCo 3, kept here as assembly source and
 * assembled with the project's assembler when it is first needed. It takes the place of the CoCo 3's internal ROM
 * (Super Extended Color BASIC, which is never involved), reads the boot track of DriveWire drive 0 over the
 * Becker port and jumps into it, as a DriveWire-aware Disk BASIC's DOS command does.
 *
 *   NITROS9_LOADER_SOURCE   the source
 *   nitros9LoaderRom()      the 32K ROM image ($8000-$FFFF, unused bytes $FF), assembled once
 *   nitros9LoaderCrc()      its CRC32: how a snapshot names it (Session.snapshotRoms knows it as built in)
 *   NITROS9_STATUS          where the loader reports how far it got ($0100), and its codes
 *
 * Used by the page (Session.bootNitros9), tools/nitros9/ (our machine and MAME run the same image) and the tests.
 */
import { assemble } from '../asm/assembler.js';
import { crc32 } from '../util.js';

export const NITROS9_LOADER_SOURCE = `* NitrOS-9 DriveWire boot loader for the CoCo 3 Becker port. Written for CLOADM (js/machines/nitros9.js); it replaces
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
`;

export const NITROS9_STATUS = Object.freeze({ addr: 0x0100, running: 0x00, jumped: 0x01, dwError: 0xE1, notBootTrack: 0xE2, trap: 0xE3 });

let rom = null;
export function nitros9LoaderRom() {
  if (rom) return rom;
  const r = assemble(NITROS9_LOADER_SOURCE, '6809');
  if (!r.ok) throw new Error('NitrOS-9 loader: ' + r.errors.map((e) => `line ${e.line}: ${e.message}`).join('; '));
  const image = new Uint8Array(0x8000).fill(0xFF);
  for (const s of r.segments) if (s.addr >= 0x8000) image.set(s.data.subarray(0, 0x10000 - s.addr), s.addr - 0x8000);
  rom = image;
  return rom;
}
export const nitros9LoaderCrc = () => crc32(nitros9LoaderRom());
