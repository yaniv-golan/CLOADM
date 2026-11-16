* orch90.asm: our own firmware for the Orchestra-90 comparison (MAME coco_orch90_device), installed as its 8K ROM
* ("orchestra 90,1984,26 - 3143,tandy.rom"). Covers: the ROM mirrored through $C000-$FEFF, the CART line (tied
* to Q from power-on), SCS reads (00), the $FF60-$FF7F space (the DACs at $FF7A/$FF7B are write-only: reading
* them reads the floating bus), and the two DACs, which MAME records with -wavwrite (cart/audio.js): ramps on each
* side at different rates, both sides together, every code on the left, fast and slow changes. Ends in its HALT
* loop.
        INCLUDE "head.asm"

LDAC    EQU     $FF7A
RDAC    EQU     $FF7B
        ORG     $1000
        JSR     QTEST
* the 8K ROM repeats every $2000 (on a CoCo 3 only its first 8K: MAME 0.264's GIME reads the cartridge through
* get_cart_base() with the default 32K get_cart_size(), so $E000-$FEFF read past the 8K region, memory that
* changes from run to run; the board decodes A0-A12 only, as MAME's cts_read for the other machines does)
        LDA     $C000
        LDA     $DFFF
        LDA     MACH
        BNE     MIRROR
        LDA     $E000
        LDA     $FEFF
        LDA     $FC03
MIRROR
* SCS reads 00; $FF60-$FF7F has nothing to read, the DACs included
        LDX     #$FF40
SCS     LDA     ,X+
        CMPX    #$FF60
        BNE     SCS
SPACE   LDA     ,X+
        LDA     -1,X
        CMPX    #$FF80
        BNE     SPACE
* every code on the left, slowly
        CLRA
LRAMP   STA     LDAC
        LDY     #$0040
        BSR     WAIT
        INCA
        BNE     LRAMP
* the right side in steps of 3, faster
        CLRA
RRAMP   STA     RDAC
        LDY     #$0010
        BSR     WAIT
        ADDA    #3
        BCC     RRAMP
* both sides: a square wave, opposite phases, then the same phase
        LDB     #200
SQ      LDA     #$E0
        STA     LDAC
        LDA     #$20
        STA     RDAC
        LDY     #$0030
        BSR     WAIT
        LDA     #$20
        STA     LDAC
        LDA     #$E0
        STA     RDAC
        LDY     #$0030
        BSR     WAIT
        DECB
        BNE     SQ
        LDB     #100
SQ2     LDA     #$FF
        STA     LDAC
        STA     RDAC
        LDY     #$0055
        BSR     WAIT
        CLR     LDAC            ; CLR reads first (the floating bus), then writes 0
        CLR     RDAC
        LDY     #$0055
        BSR     WAIT
        DECB
        BNE     SQ2
* writes back to back
        LDD     #$4080
        STA     LDAC
        STB     RDAC
        STB     LDAC
        STA     RDAC
        LDA     #$80
        STA     LDAC
        STA     RDAC
        LDY     #$2000
        BSR     WAIT
HALT    BRA     HALT
* WAIT: Y x 8 cycles
WAIT    LEAY    -1,Y
        NOP
        BNE     WAIT
        RTS
        INCLUDE "qtest.asm"
RAMEND  EQU     *
