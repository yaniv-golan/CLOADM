* gen-bare.js: the coco disk controller driven with no ROM (rom build); our own code
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
        LDA     <$48
        CMPA    #$FF            ; nothing answers at the controller's address
        BEQ     RDOUT
        LDA     #$29
        STA     <$40
        LDB     #$00            ; restore
        STB     <$48
        BSR     SETTLE
        BSR     NOTBSY
        LDA     #1
        STA     <$4A
        LDB     #$80            ; read sector, side 0
        STB     <$48
        BSR     SETTLE
        LDX     #BUF
RB1     LDA     <$48
        BITA    #2
        BNE     RB2
        LSRA
        BCS     RB1
        BRA     RB3
RB2     LDB     <$4B
        STB     ,X+
        BRA     RB1
RB3     LDA     <$48
        STA     STAT
        TFR     X,D
        SUBD    #BUF
        STD     CNT
        LDA     #$00
        STA     <$40
RDOUT   INC     DONE
        PULS    CC,DP,PC
SETTLE  LDB     #8              ; the busy bit is valid a few cycles after a command
SET1    DECB
        BNE     SET1
        RTS
NOTBSY  LDA     <$48
        LSRA
        BCS     NOTBSY
        RTS
RTIV    RTI
        ORG     $BFF2
        FDB     RTIV,RTIV,RTIV,RTIV,RTIV,NMIH,START
        END     START
