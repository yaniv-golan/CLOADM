* multi.asm: our own firmware for the Multi-Pak comparison (MAME coco_multipak_device), bank 0 of a Games Master
* image in slot 4 (the front-panel switch's default, so its ROM is at $C000 at reset). Slot 1 holds a banked ROM
* cartridge, slot 2 an Orchestra-90, slot 3 nothing. Covers: $FF7F read and written with every value (bits 1-0 pick
* the slot that gets SCS, bits 5-4 the one that gets CTS and CART; reads give the selection OR $CC), the ROM each
* CTS selection shows, SCS writes reaching only the selected slot (the banked cartridges' bank registers, the PSG),
* the Orchestra-90's DACs answering whatever is selected, and the CART line with each slot selected (three tie it
* to Q, the empty slot leaves it clear; MAME passes only the CTS slot's CART on). Ends in its HALT loop.
        INCLUDE "head.asm"

MPI     EQU     $FF7F
        ORG     $1000
        JSR     QTEST
        LDA     MPI
* every selection: what $FF7F reads back, the window, SCS reads (the top of the window at $FEFF, or on a CoCo 3 at
* $DEFF: there MAME reads the Orchestra-90's 8K ROM past its end above $DFFF, see orch90.asm)
        LDX     #$FEFF
        LDA     MACH
        BEQ     SEL0
        LDX     #$DEFF
SEL0    CLRB
SEL     STB     MPI
        LDA     MPI
        LDA     $C000
        LDA     $D234
        LDA     ,X
        LDA     $FF40
        LDA     $FF7A           ; the DACs are write-only wherever the selection points
        INCB
        BNE     SEL
* SCS writes go to the selected slot only: bank 2 in slot 1 (selected), then bank 5 in slot 4 (selected)
        LDA     #$00            ; SCS slot 1, CTS slot 1
        STA     MPI
        LDA     #$02
        STA     $FF40
        LDA     $C000
        LDA     #$33            ; SCS and CTS slot 4
        STA     MPI
        LDA     $C000           ; slot 4 still at bank 0
        LDA     #$05
        STA     $FF40
        LDA     $C000
        LDA     #$30            ; SCS slot 1, CTS slot 4
        STA     MPI
        LDA     #$01
        STA     $FF40           ; slot 1 to bank 1; slot 4 unchanged
        LDA     $C000
        LDA     #$03            ; SCS slot 4, CTS slot 1
        STA     MPI
        LDA     $C000           ; slot 1 at bank 1
        CLR     $FF40           ; slot 4 back to bank 0 (CLR reads $FF40 first)
* the PSG in slot 4 only hears $FF41 while slot 4 has SCS
        LDX     #TONE
PSG1    LDA     ,X+
        BEQ     PSG2
        STA     $FF41
        BRA     PSG1
PSG2    LDA     #$00            ; SCS slot 1: these writes go to the banked cartridge, which ignores $FF41
        STA     MPI
        LDA     #$9F
        STA     $FF41
        LDY     #$1000
        BSR     WAIT
        LDA     #$03
        STA     MPI
        LDA     #$9F
        STA     $FF41           ; now the tone stops
* the Orchestra-90 in slot 2 plays whatever slot is selected
        LDB     #$40
DAC     STB     $FF7A
        COMB
        STB     $FF7B
        COMB
        LDY     #$0020
        BSR     WAIT
        INCB
        BNE     DAC
* CART with each slot given CTS: the CB1 flag around a PIA1 write
        LDX     #CTSLIST
CART    LDA     ,X+
        BMI     DONE
        STA     MPI
        LDA     $FF23
        LDA     $FF22
        LDA     $FF23
        LDA     $FF21
        STA     $FF21
        LDA     $FF23
        LDA     $FF22
        BRA     CART
DONE    LDA     #$33
        STA     MPI
        CLR     $FF40
        JSR     QTEST
HALT    BRA     HALT
* WAIT: Y x 8 cycles
WAIT    LEAY    -1,Y
        NOP
        BNE     WAIT
        RTS
TONE    FCB     $8C,$06,$93,$BF,$DF,$FF,$00
CTSLIST FCB     $03,$13,$23,$33,$23,$03,$13,$33,$FF
        INCLUDE "qtest.asm"
RAMEND  EQU     *
