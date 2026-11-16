VAL     EQU     $00
OPR     EQU     $01
TMP     EQU     $02
CNT     EQU     $04
W16     EQU     $06
IRQN    EQU     $08
FIRQN   EQU     $09
SWIN    EQU     $0A
BANKID  EQU     $BF00
        ORG     $8000
RESET   ORCC    #$50
        STA     $FFDD
        LDS     #$7F00
        LDU     #$6000
        LDX     #$0000
        LDY     #$0000
        LDD     #$0000
        TFR     A,DP
        LDX     #$0000
CLRDP   CLR     ,X+
        CMPX    #$7F00
        BNE     CLRDP
        CLR     <VAL
AL1     LDY     #OPS
AL2     LDB     ,Y
        STB     <OPR
        ANDCC   #$D0
        JSR     BLOCK
        ORCC    #$2F
        JSR     BLOCK
        LEAY    1,Y
        CMPY    #OPSEND
        BNE     AL2
        LDA     <VAL
        ADDA    #17
        STA     <VAL
        BCC     AL1
        JMP     PHASE2
OPS     FCB     $00,$01,$0F,$10,$7F,$80,$81,$FF,$55,$AA,$09,$99
OPSEND  EQU     *
BLOCK   PSHS    Y
        PSHS    CC
        LDA     <VAL
        SUBA    <OPR
        PULS    CC
        PSHS    CC
        LDA     <VAL
        CMPA    <OPR
        PULS    CC
        PSHS    CC
        LDA     <VAL
        SBCA    <OPR
        PULS    CC
        PSHS    CC
        LDA     <VAL
        ANDA    <OPR
        PULS    CC
        PSHS    CC
        LDA     <VAL
        BITA    <OPR
        PULS    CC
        PSHS    CC
        LDA     <VAL
        EORA    <OPR
        PULS    CC
        PSHS    CC
        LDA     <VAL
        ADCA    <OPR
        PULS    CC
        PSHS    CC
        LDA     <VAL
        ORA    <OPR
        PULS    CC
        PSHS    CC
        LDA     <VAL
        ADDA    <OPR
        PULS    CC
        PSHS    CC
        LDB     <VAL
        SUBB    #$5A
        PULS    CC
        PSHS    CC
        LDB     <VAL
        CMPB    #$5A
        PULS    CC
        PSHS    CC
        LDB     <VAL
        SBCB    #$5A
        PULS    CC
        PSHS    CC
        LDB     <VAL
        ANDB    #$5A
        PULS    CC
        PSHS    CC
        LDB     <VAL
        BITB    #$5A
        PULS    CC
        PSHS    CC
        LDB     <VAL
        EORB    #$5A
        PULS    CC
        PSHS    CC
        LDB     <VAL
        ADCB    #$5A
        PULS    CC
        PSHS    CC
        LDB     <VAL
        ORB    #$5A
        PULS    CC
        PSHS    CC
        LDB     <VAL
        ADDB    #$5A
        PULS    CC
        PSHS    CC
        LDA     <VAL
        NEGA
        PULS    CC
        PSHS    CC
        LDA     <VAL
        COMA
        PULS    CC
        PSHS    CC
        LDA     <VAL
        LSRA
        PULS    CC
        PSHS    CC
        LDA     <VAL
        RORA
        PULS    CC
        PSHS    CC
        LDA     <VAL
        ASRA
        PULS    CC
        PSHS    CC
        LDA     <VAL
        ASLA
        PULS    CC
        PSHS    CC
        LDA     <VAL
        ROLA
        PULS    CC
        PSHS    CC
        LDA     <VAL
        DECA
        PULS    CC
        PSHS    CC
        LDA     <VAL
        INCA
        PULS    CC
        PSHS    CC
        LDA     <VAL
        TSTA
        PULS    CC
        PSHS    CC
        LDA     <VAL
        CLRA
        PULS    CC
        PSHS    CC
        LDB     <OPR
        NEGB
        PULS    CC
        PSHS    CC
        LDB     <OPR
        COMB
        PULS    CC
        PSHS    CC
        LDB     <OPR
        LSRB
        PULS    CC
        PSHS    CC
        LDB     <OPR
        RORB
        PULS    CC
        PSHS    CC
        LDB     <OPR
        ASRB
        PULS    CC
        PSHS    CC
        LDB     <OPR
        ASLB
        PULS    CC
        PSHS    CC
        LDB     <OPR
        ROLB
        PULS    CC
        PSHS    CC
        LDB     <OPR
        DECB
        PULS    CC
        PSHS    CC
        LDB     <OPR
        INCB
        PULS    CC
        PSHS    CC
        LDB     <OPR
        TSTB
        PULS    CC
        PSHS    CC
        LDB     <OPR
        CLRB
        PULS    CC
        PSHS    CC
        LDA     <VAL
        STA     <TMP
        PULS    CC
        PSHS    CC
        NEG     <TMP
        LDA     <TMP
        PULS    CC
        PSHS    CC
        LDA     <VAL
        STA     <TMP
        PULS    CC
        PSHS    CC
        COM     <TMP
        LDA     <TMP
        PULS    CC
        PSHS    CC
        LDA     <VAL
        STA     <TMP
        PULS    CC
        PSHS    CC
        LSR     <TMP
        LDA     <TMP
        PULS    CC
        PSHS    CC
        LDA     <VAL
        STA     <TMP
        PULS    CC
        PSHS    CC
        ROR     <TMP
        LDA     <TMP
        PULS    CC
        PSHS    CC
        LDA     <VAL
        STA     <TMP
        PULS    CC
        PSHS    CC
        ASR     <TMP
        LDA     <TMP
        PULS    CC
        PSHS    CC
        LDA     <VAL
        STA     <TMP
        PULS    CC
        PSHS    CC
        ASL     <TMP
        LDA     <TMP
        PULS    CC
        PSHS    CC
        LDA     <VAL
        STA     <TMP
        PULS    CC
        PSHS    CC
        ROL     <TMP
        LDA     <TMP
        PULS    CC
        PSHS    CC
        LDA     <VAL
        STA     <TMP
        PULS    CC
        PSHS    CC
        DEC     <TMP
        LDA     <TMP
        PULS    CC
        PSHS    CC
        LDA     <VAL
        STA     <TMP
        PULS    CC
        PSHS    CC
        INC     <TMP
        LDA     <TMP
        PULS    CC
        PSHS    CC
        LDA     <VAL
        STA     <TMP
        PULS    CC
        PSHS    CC
        TST     <TMP
        LDA     <TMP
        PULS    CC
        PSHS    CC
        LDA     <VAL
        STA     <TMP
        PULS    CC
        PSHS    CC
        CLR     <TMP
        LDA     <TMP
        PULS    CC
        PSHS    CC
        LDA     <VAL
        ADDA    <OPR
        DAA
        PULS    CC
        PSHS    CC
        LDA     <VAL
        ADCA    <OPR
        DAA
        PULS    CC
        PSHS    CC
        LDA     <VAL
        DAA
        PULS    CC
        PSHS    CC
        LDD     <VAL
        ADDD    #$7F81
        PULS    CC
        PSHS    CC
        LDD     <VAL
        SUBD    #$8001
        PULS    CC
        PSHS    CC
        LDD     <VAL
        CMPD    #$1234
        PULS    CC
        PSHS    CC
        LDX     <VAL
        CMPX    #$8000
        PULS    CC
        PSHS    CC
        LDY     <VAL
        CMPY    #$00FF
        PULS    CC
        PSHS    CC
        LDU     <VAL
        CMPU    #$FFFF
        PULS    CC
        PSHS    CC
        LDA     <VAL
        LDB     <OPR
        MUL
        PULS    CC
        PSHS    CC
        LDB     <VAL
        SEX
        PULS    CC
        PSHS    CC
        LDX     <VAL
        LDB     <OPR
        ABX
        PULS    CC
        PSHS    CC
        LDX     <VAL
        LEAX    -1,X
        PULS    CC
        PSHS    CC
        LDA     <VAL
        CMPA    <OPR
        BRA     BR1
        NOP
BR1
        BRN     BR2
        NOP
BR2
        BHI     BR3
        NOP
BR3
        BLS     BR4
        NOP
BR4
        BCC     BR5
        NOP
BR5
        BCS     BR6
        NOP
BR6
        BNE     BR7
        NOP
BR7
        BEQ     BR8
        NOP
BR8
        BVC     BR9
        NOP
BR9
        BVS     BR10
        NOP
BR10
        BPL     BR11
        NOP
BR11
        BMI     BR12
        NOP
BR12
        BGE     BR13
        NOP
BR13
        BLT     BR14
        NOP
BR14
        BGT     BR15
        NOP
BR15
        BLE     BR16
        NOP
BR16
        LBRA    LB17
        NOP
LB17
        LBRN    LB18
        NOP
LB18
        LBHI    LB19
        NOP
LB19
        LBLS    LB20
        NOP
LB20
        LBCC    LB21
        NOP
LB21
        LBCS    LB22
        NOP
LB22
        LBNE    LB23
        NOP
LB23
        LBEQ    LB24
        NOP
LB24
        LBVC    LB25
        NOP
LB25
        LBVS    LB26
        NOP
LB26
        LBPL    LB27
        NOP
LB27
        LBMI    LB28
        NOP
LB28
        LBGE    LB29
        NOP
LB29
        LBLT    LB30
        NOP
LB30
        LBGT    LB31
        NOP
LB31
        LBLE    LB32
        NOP
LB32
        PULS    CC
        PSHS    CC
        LDU     #$6000
        LEAS    1,S
        PULS    Y,PC
PHASE2  LDX     #$1C00
        LDD     #$0000
FILL    STB     ,X+
        INCB
        CMPX    #$3000
        BNE     FILL
        LDX     #$2080
        LDY     #$2180
        LDU     #$2280
        LDA     #$03
        LDB     #$FD
        LDA     #$03
        LDB     #$FD
        LDA     0,X
        LEAX    0,X
        CMPX    #$2300
        BLO     K33
        LDX     #$2080
K33
        STB     0,X
        LDA     #$03
        LDB     #$FD
        LDA     5,X
        LEAX    5,X
        CMPX    #$2300
        BLO     K34
        LDX     #$2080
K34
        STB     5,X
        LDA     #$03
        LDB     #$FD
        LDA     -5,Y
        LEAX    -5,Y
        CMPX    #$2300
        BLO     K35
        LDX     #$2080
K35
        STB     -5,Y
        LDA     #$03
        LDB     #$FD
        LDA     15,U
        LEAX    15,U
        CMPX    #$2300
        BLO     K36
        LDX     #$2080
K36
        STB     15,U
        LDA     #$03
        LDB     #$FD
        LDA     -16,X
        LEAX    -16,X
        CMPX    #$2300
        BLO     K37
        LDX     #$2080
K37
        STB     -16,X
        LDA     #$03
        LDB     #$FD
        LDA     100,Y
        LEAX    100,Y
        CMPX    #$2300
        BLO     K38
        LDX     #$2080
K38
        STB     100,Y
        LDA     #$03
        LDB     #$FD
        LDA     -100,U
        LEAX    -100,U
        CMPX    #$2300
        BLO     K39
        LDX     #$2080
K39
        STB     -100,U
        LDA     #$03
        LDB     #$FD
        LDA     1000,X
        LEAX    1000,X
        CMPX    #$2300
        BLO     K40
        LDX     #$2080
K40
        STB     1000,X
        LDA     #$03
        LDB     #$FD
        LDA     -1000,Y
        LEAX    -1000,Y
        CMPX    #$2300
        BLO     K41
        LDX     #$2080
K41
        STB     -1000,Y
        LDA     #$03
        LDB     #$FD
        LDA     ,X+
        LEAX    ,X+
        CMPX    #$2300
        BLO     K42
        LDX     #$2080
K42
        STB     ,X+
        LDA     #$03
        LDB     #$FD
        LDA     ,X++
        LEAX    ,X++
        CMPX    #$2300
        BLO     K43
        LDX     #$2080
K43
        STB     ,X++
        LDA     #$03
        LDB     #$FD
        LDA     ,-X
        LEAX    ,-X
        CMPX    #$2300
        BLO     K44
        LDX     #$2080
K44
        STB     ,-X
        LDA     #$03
        LDB     #$FD
        LDA     ,--X
        LEAX    ,--X
        CMPX    #$2300
        BLO     K45
        LDX     #$2080
K45
        STB     ,--X
        LDA     #$03
        LDB     #$FD
        LDA     A,X
        LEAX    A,X
        CMPX    #$2300
        BLO     K46
        LDX     #$2080
K46
        STB     A,X
        LDA     #$03
        LDB     #$FD
        LDA     B,Y
        LEAX    B,Y
        CMPX    #$2300
        BLO     K47
        LDX     #$2080
K47
        STB     B,Y
        LDA     #$03
        LDB     #$FD
        LDA     D,U
        LEAX    D,U
        CMPX    #$2300
        BLO     K48
        LDX     #$2080
K48
        STB     D,U
        LDA     #$03
        LDB     #$FD
        LDA     [,X]
        LEAX    1,X
        CMPX    #$2300
        BLO     K49
        LDX     #$2080
K49
        STB     [,X]
        LDA     #$03
        LDB     #$FD
        LDA     [2,Y]
        LEAX    1,X
        CMPX    #$2300
        BLO     K50
        LDX     #$2080
K50
        STB     [2,Y]
        LDA     #$03
        LDB     #$FD
        LDA     [,X++]
        LEAX    1,X
        CMPX    #$2300
        BLO     K51
        LDX     #$2080
K51
        STB     [,X++]
        LDA     #$03
        LDB     #$FD
        LDA     [,--Y]
        LEAX    1,X
        CMPX    #$2300
        BLO     K52
        LDX     #$2080
K52
        STB     [,--Y]
        LDA     #$03
        LDB     #$FD
        LDA     [$2010]
        LEAX    1,X
        CMPX    #$2300
        BLO     K53
        LDX     #$2080
K53
        STB     [$2010]
        LDA     #$03
        LDB     #$FD
        LDA     TAB,PCR
        LEAX    1,X
        CMPX    #$2300
        BLO     K54
        LDX     #$2080
K54
        STB     $2050
        LDA     #$03
        LDB     #$FD
        LDA     [TABP,PCR]
        LEAX    1,X
        CMPX    #$2300
        BLO     K55
        LDX     #$2080
K55
        STB     $2050
        LDA     #$03
        LDB     #$FD
        LDA     -2,S
        LEAX    1,X
        CMPX    #$2300
        BLO     K56
        LDX     #$2080
K56
        STB     -2,S
        LDX     #$2080
        LDD     #$1234
        LDX     #$5678
        LDY     #$9ABC
        LDU     #$DEF0
        TFR     A,B
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        LDX     #$5678
        EXG     A,B
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        TFR     A,X
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        LDX     #$5678
        EXG     A,X
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        TFR     B,Y
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        LDX     #$5678
        EXG     B,Y
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        TFR     X,Y
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        LDX     #$5678
        EXG     X,Y
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        TFR     D,U
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        LDX     #$5678
        EXG     D,U
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        TFR     CC,A
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        LDX     #$5678
        EXG     CC,A
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        TFR     DP,B
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        LDX     #$5678
        EXG     DP,B
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        TFR     A,DP
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        LDX     #$5678
        EXG     A,DP
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        TFR     X,D
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        LDX     #$5678
        EXG     X,D
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        TFR     U,X
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        LDX     #$5678
        EXG     U,X
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        TFR     S,Y
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        LDX     #$5678
        EXG     U,Y
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        TFR     PC,X
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        LDX     #$5678
        EXG     Y,X
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        TFR     A,CC
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        LDX     #$5678
        EXG     A,CC
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        TFR     B,D
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        LDX     #$5678
        EXG     B,D
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        TFR     X,A
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        LDX     #$5678
        EXG     X,A
        ORCC    #$50
        CLRA
        TFR     A,DP
        LDD     #$1234
        LDU     #$6000
        PSHS    A,B,X,Y,U,DP,CC
        PULS    A,B,X,Y,U,DP,CC
        PSHU    A,B,X,Y,S,DP,CC
        PULU    A,B,X,Y,S,DP,CC
        PSHS    D,X
        LEAU    ,S
        PULU    D,X
        PULS    D,X
        LDU     #$6000
        SWI
        SWI2
        SWI3
        BSR     SUB1
        LBSR    SUB1
        JSR     SUB1
        JSR     [SUBV]
        LDX     #SUB1
        JSR     ,X
        JMP     PHASE3
SUB1    INC     <CNT
        RTS
SUBV    FDB     SUB1
TAB     FCB     $11,$22,$33,$44
TABP    FDB     TAB
PHASE3  CLR     $FF01
        CLR     $FF00
        LDA     #$FF
        CLR     $FF03
        STA     $FF02
        LDA     #$34
        STA     $FF01
        STA     $FF03
        CLR     $FF21
        LDA     #$FE
        STA     $FF20
        LDA     #$34
        STA     $FF21
        CLR     $FF23
        LDA     #$FC
        STA     $FF22
        LDA     #$34
        STA     $FF23
        LDA     $FF01
        LDA     $FF03
        LDA     $FF21
        LDA     $FF23
        LDA     #$04
        STA     $FF22
        LDA     $FF00
        LDA     $FF02
WFS1    LDA     $FF03
        BPL     WFS1
        LDA     $FF02
        LDA     $FF00
        LDX     #0
HSL     LDA     $FF01
        BPL     HSL0
        LDA     $FF00
        LEAX    1,X
HSL0    LDA     $FF03
        BPL     HSL
        STX     <W16
        LDA     #$36
        STA     $FF03
        LDA     $FF02
WFS2    LDA     $FF03
        BPL     WFS2
        LDA     $FF02
        LDA     #$35
        STA     $FF03
        LDA     $FF02
        ANDCC   #$EF
        LDX     #0
BUSY    LEAX    1,X
        LDA     <IRQN
        CMPA    #4
        BNE     BUSY
        ORCC    #$50
        CWAI    #$EF
        ORCC    #$50
        LDA     $FF02
        SYNC
        LDA     $FF02
        LDA     #$34
        STA     $FF03
        LDX     #$FFC0
        LDA     #0
SAMV    STA     A,X
        INCA
        CMPA    #$14
        BNE     SAMV
        STA     $FFC0
        STA     $FFC2
        STA     $FFC4
        STA     $FFC9
        STA     $FFCA
        STA     $FFCC
        STA     $FFCE
        STA     $FFD0
        STA     $FFD2
        LDA     BANKID
        CLR     $FF23
        LDA     #$FE
        STA     $FF22
        LDA     #$34
        STA     $FF23
        LDA     #$00
        STA     $FF22
        LDA     BANKID
        LDA     #$04
        STA     $FF22
        LDA     BANKID
        TFR     CC,B
        ORCC    #$50
        LDA     #$5A
        STA     $1000
        STA     $FFD5
        LDA     #$C3
        STA     $1001
        LDA     #$96
        STA     $7FFF
        LDA     $1001
        LDA     $7FFF
        LDA     $9001
        STA     $FFDC
        LDA     $1000
        LDA     $1001
        STA     $FFDF
        LDA     $9001
        STA     $9001
        STA     $FFDE
        STA     $FFDD
        LDA     $1001
        STA     $FFD4
        LDA     $1001
        TFR     B,CC
        LDX     #TYCODE
        LDY     #$3000
TYCP    LDA     ,X+
        STA     ,Y+
        CMPX    #TYEND
        BNE     TYCP
        JSR     $3000
        LDA     $FFFE
        LDA     $FFFF
        LDB     #$FE
KB      STB     $FF02
        LDA     $FF00
        ANDA    #$7F
        ORCC    #$01
        ROLB
        BCS     KB
        LDA     #$FF
        STA     $FF02
        LDA     $FF00
        LDA     $FF02
DONE    LDA     #$01
        STA     <TMP
HALT    BRA     HALT
TYCODE  STA     $FFDF
        LDA     #$3C
        STA     $9000
        STA     $FFDE
        LDA     #$A5
        STA     $9000
        LDA     $9000
        STA     $FFDF
        LDA     $9000
        STA     $FFD5
        LDA     $1000
        LDA     $9001
        STA     $FFD4
        STA     $FFDE
        RTS
TYEND   EQU     *
IRQH    INC     <IRQN
        LDA     $FF00
        LDA     $FF02
        RTI
FIRQH   INC     <FIRQN
        LDA     $FF20
        LDA     $FF22
        RTI
SWIH    INC     <SWIN
        RTI
NMIH    RTI
        ORG     $BF00
        FCB     $11
        ORG     $BFF2
        FDB     SWIH,SWIH,FIRQH,IRQH,SWIH,NMIH,RESET
        END     RESET
