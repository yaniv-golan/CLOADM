* gen-bare.js: the dragon disk controller driven with no ROM (rom build); our own code
STAT    EQU     $F00
CNT     EQU     $F01
TICK    EQU     $F03
TRIG    EQU     $F05
DONE    EQU     $F06
NMIC    EQU     $F07
BUF     EQU     $1000
        ORG     $8000
START   ORCC    #$50
        LDS     #$7F00
        CLR     NMIC
        CLR     DONE
        JSR     READ
HALT    BRA     HALT
NMIH    INC     NMIC
        RTI
* read track 0 sector 1 of drive 0 into BUF; STAT, CNT
READ    PSHS    CC,DP
        ORCC    #$50
        LDA     #$FF
        TFR     A,DP
        LDD     #0
        STD     CNT
        LDA     <$40
        CMPA    #$FF            ; nothing answers at the controller's address
        BEQ     RDOUT
        LDA     #$04
        STA     <$48
        LDB     #$00            ; restore
        STB     <$40
        BSR     SETTLE
        BSR     NOTBSY
        LDA     #1
        STA     <$42
        LDB     #$88            ; read sector, side 0 (the WD2797: IBM sector lengths, 256 bytes)
        STB     <$40
        BSR     SETTLE
        LDX     #BUF
RB1     LDA     <$40
        BITA    #2
        BNE     RB2
        LSRA
        BCS     RB1
        BRA     RB3
RB2     LDB     <$43
        STB     ,X+
        BRA     RB1
RB3     LDA     <$40
        STA     STAT
        TFR     X,D
        SUBD    #BUF
        STD     CNT
        LDA     #$00
        STA     <$48
RDOUT   INC     DONE
        PULS    CC,DP,PC
SETTLE  LDB     #8              ; the busy bit is valid a few cycles after a command
SET1    DECB
        BNE     SET1
        RTS
NOTBSY  LDA     <$40
        LSRA
        BCS     NOTBSY
        RTS
RTIV    RTI
        ORG     $BFF2
        FDB     RTIV,RTIV,RTIV,RTIV,RTIV,NMIH,START
        END     START
