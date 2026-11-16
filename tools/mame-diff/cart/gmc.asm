* gmc.asm: our own firmware for the Games Master Cartridge comparison (MAME coco_pak_gmc_device: the banked
* ROM cartridge plus an SN76489A at 4 MHz on $FF41), bank 0 of the image. Covers the bank register and CART as
* banked.asm does, then plays a sequence on the PSG that MAME records with -wavwrite (cart/audio.js compares it
* with ours): the three tone channels at several periods and every volume, period 0 and 1, latch and data bytes
* (including data bytes for the volume and noise registers), white and periodic noise at the three fixed rates and
* following tone 2, the noise register reset on each noise write, and writes closer together than one chip step.
        INCLUDE "head.asm"

PSG     EQU     $FF41
        ORG     $1000
        JSR     QTEST
        CLRB
BANKS   STB     $FF40
        LDA     $C000
        LDA     $E555
        LDA     $FEFF
        LDA     $FF41           ; SCS reads 00
        INCB
        BNE     BANKS
        CLR     $FF40
* silence everything (volumes are 0, loudest, at power-on)
        LDX     #SILENT
        BSR     PLAY
* tone 0: period $0FE, loudest; then the other channels
        LDX     #SEQ1
        BSR     PLAY
        LDX     #SEQ2
        BSR     PLAY
* every volume on channel 1
        LDB     #$B0
VOLS    STB     PSG
        LDY     #$0180
        BSR     WAIT
        INCB
        CMPB    #$C0
        BNE     VOLS
        LDX     #SEQ3
        BSR     PLAY
        LDX     #SEQ4
        BSR     PLAY
* bursts of writes back to back (closer than one chip step, 4 us)
        LDA     #$80
        STA     PSG
        LDA     #$01
        STA     PSG
        LDA     #$90
        STA     PSG
        LDA     #$92
        STA     PSG
        LDA     #$94
        STA     PSG
        LDY     #$1000
        BSR     WAIT
        LDX     #SILENT
        BSR     PLAY
HALT    BRA     HALT

* PLAY: X -> list of (byte, wait count high, wait count low), ended by $00 $00 $00
PLAY    LDA     ,X+
        LDY     ,X++
        BNE     PL1
        RTS
PL1     STA     PSG
        BSR     WAIT
        BRA     PLAY
* WAIT: Y x 8 cycles
WAIT    LEAY    -1,Y
        NOP
        BNE     WAIT
        RTS

SILENT  FCB     $9F,$00,$10,$BF,$00,$10,$DF,$00,$10,$FF,$00,$10,$00,$00,$00
* tone 0 at period $0FE (latch low nibble, data high bits), loud, then two more periods
SEQ1    FCB     $8E,$00,$08,$0F,$00,$08,$90,$20,$00
        FCB     $81,$00,$08,$20,$20,$00
        FCB     $8F,$00,$08,$3F,$20,$00
* period 0 and 1 on tone 0, then tones 1 and 2 with tone 0 quieter
        FCB     $80,$00,$08,$00,$10,$00
        FCB     $81,$00,$10,$00,$10,$00
        FCB     $93,$00,$10,$85,$00,$08,$06,$10,$00
        FCB     $00,$00,$00
SEQ2    FCB     $A3,$00,$08,$04,$00,$08,$B2,$18,$00
        FCB     $C7,$00,$08,$02,$00,$08,$D4,$18,$00
* a data byte without a latch goes to the last register latched: tone 2 frequency, then its volume
        FCB     $15,$10,$00
        FCB     $D0,$00,$08,$0A,$10,$00
        FCB     $00,$00,$00
* noise: white at N/512, N/1024, N/2048, following tone 2; periodic at each; the volume as a data byte
SEQ3    FCB     $9F,$00,$08,$BF,$00,$08,$DF,$00,$08
        FCB     $E4,$00,$08,$F2,$18,$00
        FCB     $E5,$18,$00,$E6,$18,$00
        FCB     $C9,$00,$08,$01,$00,$08,$E7,$18,$00
        FCB     $C3,$00,$08,$00,$18,$00
        FCB     $E0,$18,$00,$E1,$18,$00,$E2,$18,$00,$E3,$18,$00
        FCB     $F0,$00,$08,$07,$18,$00
        FCB     $00,$00,$00
* a noise register write with bit 7 clear (MAME takes its low nibble), noise with all tones, then the noise
* register rewritten often (each write resets the shift register)
SEQ4    FCB     $E4,$00,$08,$02,$18,$00
        FCB     $93,$00,$08,$B5,$00,$08,$D7,$00,$08,$F4,$20,$00
        FCB     $E4,$01,$00,$E4,$01,$00,$E4,$01,$00,$E4,$01,$00,$E4,$01,$00,$E4,$01,$00
        FCB     $00,$00,$00
        INCLUDE "qtest.asm"
RAMEND  EQU     *
