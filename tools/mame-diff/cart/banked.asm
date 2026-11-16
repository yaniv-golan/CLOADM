* banked.asm: our own firmware for the banked ROM cartridge comparison (MAME coco_pak_banked_device, an RPK with
* PCB type "paged16k"), bank 0 of the image; spec.js fills the other banks with a pattern that names the bank.
* Covers: the CART line (auto-start, tied to Q), every bank register value 0-255 with reads from the start, middle
* and end of the window, the rest of the SCS range ($FF41-$FF5F: writes ignored, reads 00), the $FF60-$FF7F
* space (nothing there), and writes to the cartridge window (ignored). Ends in its HALT loop.
        INCLUDE "head.asm"

        ORG     $1000
        JSR     QTEST
* every bank value: the window shows bank (value mod 8)
        CLRB
BANKS   STB     $FF40
        LDA     $C000
        LDA     $C001
        LDA     $DABC
        LDA     $FEFF
        LDA     $FF40           ; SCS reads 00
        INCB
        BNE     BANKS
* SCS: $FF41-$FF5F do nothing; every SCS address reads 00
        LDB     #3
        STB     $FF40
        LDX     #$FF41
SCS     STB     ,X
        LDA     ,X
        LDA     $C000           ; still bank 3
        INCB
        LEAX    1,X
        CMPX    #$FF60
        BNE     SCS
* $FF60-$FF7F: no cartridge handler
        LDX     #$FF60
SPACE   LDA     ,X+
        CMPX    #$FF80
        BNE     SPACE
* the window is ROM: writes are lost
        LDA     #$A5
        STA     $C123
        LDA     $C123
        STA     $FEFE
        LDA     $FEFE
* back to bank 0 (the FIRQ vector leads into it), CART after all that, then the HALT loop
        CLR     $FF40
        LDA     $C000
        JSR     QTEST
HALT    BRA     HALT
        INCLUDE "qtest.asm"
RAMEND  EQU     *
