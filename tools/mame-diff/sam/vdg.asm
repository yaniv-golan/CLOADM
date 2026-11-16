; VDG comparison firmware: shows every display mode for a few frames.
; RAM $7000 holds the current phase number so both emulators can capture the same picture.
; Display data lives at $0000 (SAM F=0): under headless MAME the display start did not follow
; the SAM F bits, so the test keeps F at 0 and compares mode rendering only.
PHASE   EQU     $7000
        ORG     $8000
RESET   ORCC    #$50
        STA     $FFDD           ; SAM: 64K RAM
        LDS     #$7F00
        CLRA
        TFR     A,DP
        ; PIA setup: PIA0 B outputs, PIA1 B outputs for VDG
        CLR     $FF03
        LDA     #$FF
        STA     $FF02
        LDA     #$34
        STA     $FF03
        CLR     $FF23
        LDA     #$F8
        STA     $FF22
        LDA     #$34
        STA     $FF23
        ; display data at $0000-$17FF: byte = low(addr) + 3*high(addr)
        ; (the first 512 bytes hold every character code twice)
        LDX     #$0000
GX      TFR     X,D             ; A = high, B = low
        PSHS    B
        LDB     #3
        MUL                     ; B = 3*high (low byte)
        ADDB    ,S+             ; + low
        STB     ,X+
        CMPX    #$1800
        BLO     GX
        ; SAM display offset: text at $0400 (F=2)
        CLR     PHASE
        LDY     #MODES
NEXT    LDA     ,Y+             ; PIA1 PB value
        CMPA    #$FF
        BEQ     DONE
        STA     $FF22
        LDB     ,Y+             ; SAM V (0-7)
        LDX     #$FFC0
        BSR     SETBITS
        LDB     ,Y+             ; SAM F (display base / 512)
        LDX     #$FFC6
        LDA     #7
        BSR     SETBITN
        INC     PHASE
        LDB     #30             ; hold for 30 fields
WAIT    LDA     $FF02
W1      LDA     $FF03
        BPL     W1
        DECB
        BNE     WAIT
        BRA     NEXT
DONE    BRA     DONE

; SETBITS: write 3 SAM bits from B starting at X
SETBITS LDA     #3
SETBITN PSHS    A
SB1     LSRB
        BCS     SB2
        STA     ,X              ; even address clears the bit
        BRA     SB3
SB2     STA     1,X             ; odd address sets the bit
SB3     LEAX    2,X
        DEC     ,S
        BNE     SB1
        PULS    A,PC

; PB value, SAM V, SAM F
MODES   FCB     $00,0,0         ; text, CSS 0
        FCB     $08,0,0         ; text, CSS 1
        FCB     $10,0,0         ; SG6, CSS 0
        FCB     $18,0,0         ; SG6, CSS 1
        FCB     $80,1,0         ; CG1
        FCB     $88,1,0
        FCB     $90,1,0         ; RG1
        FCB     $98,1,0
        FCB     $A0,2,0         ; CG2
        FCB     $A8,2,0
        FCB     $B0,3,0         ; RG2
        FCB     $B8,3,0
        FCB     $C0,4,0         ; CG3
        FCB     $C8,4,0
        FCB     $D0,5,0         ; RG3
        FCB     $D8,5,0
        FCB     $E0,6,0         ; CG6
        FCB     $E8,6,0
        FCB     $F0,6,0         ; RG6
        FCB     $F8,6,0
        FCB     $00,0,0         ; extra phase so the previous one is captured (see run-vdg.js)
        FCB     $FF

        ORG     $BFFE
        FDB     RESET
        END     RESET
