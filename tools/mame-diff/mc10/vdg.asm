; MC-10 VDG comparison firmware (our own code): shows every display mode for a while.
; RAM $8F00 holds the phase number so that both emulators capture the same picture.
; Display data at $4000-$57FF: byte = low(addr) + 3*high(addr).
PHASE   EQU     $8F00
LATCH   EQU     $BFFF
        ORG     $E000
RESET   SEI
        LDS     #$8EFF
        LDAA    #$FF
        STAA    $00             ; DDR1: keyboard strobes
        STAA    $02
        LDX     #$4000
GX      STX     $80
        LDAA    $80             ; high byte
        LDAB    #3
        MUL                     ; B = 3*high (low byte)
        ADDB    $81             ; + low
        STAB    0,X
        INX
        CPX     #$5800
        BNE     GX
        CLR     PHASE
        LDX     #MODES
NEXT    LDAA    0,X
        STAA    LATCH
        INC     PHASE
        CMPA    #$FF
        BEQ     DONE
        INX
        STX     $82
        LDAB    #30             ; hold for about 30 frames
HOLD    LDX     #2489           ; 2489 * 6 cycles = one frame
DLY     DEX
        BNE     DLY
        DECB
        BNE     HOLD
        LDX     $82
        BRA     NEXT
DONE    BRA     DONE
; latch values: bit 2 GM2+INT/EXT, 3 GM1, 4 GM0, 5 A/G, 6 CSS
MODES   FCB     $00,$40,$04,$44
        FCB     $20,$60,$30,$70,$28,$68,$38,$78
        FCB     $24,$64,$34,$74,$2C,$6C,$3C,$7C
        FCB     $00,$FF
        ORG     $FFFE
        FDB     RESET
        END     RESET
