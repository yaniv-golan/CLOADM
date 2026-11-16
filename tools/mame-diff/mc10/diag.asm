VAL     EQU     $80
OPR     EQU     $81
CCV     EQU     $82
PTR     EQU     $84
W16     EQU     $86
OCN     EQU     $88
TON     EQU     $89
SWN     EQU     $8A
CNT     EQU     $8B
DSUB    EQU     $F0
MEM     EQU     $4100
TCSR    EQU     $08
CTR     EQU     $09
OCR     EQU     $0B
KBD     EQU     $BFFF
        ORG     $E000
RESET   SEI
        LDS     #$8FF0
        LDX     #$0080
CLI1    CLR     0,X
        INX
        CPX     #$0100
        BNE     CLI1
        LDX     #$4000
CLX1    CLR     0,X
        INX
        CPX     #$4800
        BNE     CLX1
        LDAA    #$39
        STAA    DSUB
        CLR     VAL
AL1     LDX     #OPS
AL2     LDAB    0,X
        STAB    OPR
        STX     PTR
        LDAA    #$C0
        STAA    CCV
        JSR     BLOCK
        LDAA    #$EF
        STAA    CCV
        JSR     BLOCK
        LDX     PTR
        INX
        CPX     #OPSEND
        BNE     AL2
        LDAA    VAL
        ADDA    #17
        STAA    VAL
        BCC     AL1
        JMP     PHASE2
OPS     FCB     $00,$01,$0F,$10,$7F,$80,$81,$FF,$55,$AA,$09,$99
OPSEND  EQU     *
BLOCK   EQU     *
        LDAA    CCV
        TAP
        LDAA    VAL
        SUBA    OPR
        LDAA    CCV
        TAP
        LDAA    VAL
        CMPA    OPR
        LDAA    CCV
        TAP
        LDAA    VAL
        SBCA    OPR
        LDAA    CCV
        TAP
        LDAA    VAL
        ANDA    OPR
        LDAA    CCV
        TAP
        LDAA    VAL
        BITA    OPR
        LDAA    CCV
        TAP
        LDAA    VAL
        EORA    OPR
        LDAA    CCV
        TAP
        LDAA    VAL
        ADCA    OPR
        LDAA    CCV
        TAP
        LDAA    VAL
        ORAA    OPR
        LDAA    CCV
        TAP
        LDAA    VAL
        ADDA    OPR
        LDAA    CCV
        TAP
        LDAB    VAL
        SUBB    #$5A
        LDAA    CCV
        TAP
        LDAB    VAL
        CMPB    #$5A
        LDAA    CCV
        TAP
        LDAB    VAL
        SBCB    #$5A
        LDAA    CCV
        TAP
        LDAB    VAL
        ANDB    #$5A
        LDAA    CCV
        TAP
        LDAB    VAL
        BITB    #$5A
        LDAA    CCV
        TAP
        LDAB    VAL
        EORB    #$5A
        LDAA    CCV
        TAP
        LDAB    VAL
        ADCB    #$5A
        LDAA    CCV
        TAP
        LDAB    VAL
        ORAB    #$5A
        LDAA    CCV
        TAP
        LDAB    VAL
        ADDB    #$5A
        LDAA    CCV
        TAP
        LDAA    VAL
        NEGA
        LDAA    CCV
        TAP
        LDAA    VAL
        COMA
        LDAA    CCV
        TAP
        LDAA    VAL
        LSRA
        LDAA    CCV
        TAP
        LDAA    VAL
        RORA
        LDAA    CCV
        TAP
        LDAA    VAL
        ASRA
        LDAA    CCV
        TAP
        LDAA    VAL
        ASLA
        LDAA    CCV
        TAP
        LDAA    VAL
        ROLA
        LDAA    CCV
        TAP
        LDAA    VAL
        DECA
        LDAA    CCV
        TAP
        LDAA    VAL
        INCA
        LDAA    CCV
        TAP
        LDAA    VAL
        TSTA
        LDAA    CCV
        TAP
        LDAA    VAL
        CLRA
        LDAB    OPR
        LDAA    CCV
        TAP
        NEGB
        LDAB    OPR
        LDAA    CCV
        TAP
        COMB
        LDAB    OPR
        LDAA    CCV
        TAP
        LSRB
        LDAB    OPR
        LDAA    CCV
        TAP
        RORB
        LDAB    OPR
        LDAA    CCV
        TAP
        ASRB
        LDAB    OPR
        LDAA    CCV
        TAP
        ASLB
        LDAB    OPR
        LDAA    CCV
        TAP
        ROLB
        LDAB    OPR
        LDAA    CCV
        TAP
        DECB
        LDAB    OPR
        LDAA    CCV
        TAP
        INCB
        LDAB    OPR
        LDAA    CCV
        TAP
        TSTB
        LDAB    OPR
        LDAA    CCV
        TAP
        CLRB
        LDAA    VAL
        STAA    MEM
        LDAA    CCV
        TAP
        NEG     MEM
        LDAA    MEM
        LDAA    VAL
        STAA    MEM
        LDAA    CCV
        TAP
        COM     MEM
        LDAA    MEM
        LDAA    VAL
        STAA    MEM
        LDAA    CCV
        TAP
        LSR     MEM
        LDAA    MEM
        LDAA    VAL
        STAA    MEM
        LDAA    CCV
        TAP
        ROR     MEM
        LDAA    MEM
        LDAA    VAL
        STAA    MEM
        LDAA    CCV
        TAP
        ASR     MEM
        LDAA    MEM
        LDAA    VAL
        STAA    MEM
        LDAA    CCV
        TAP
        ASL     MEM
        LDAA    MEM
        LDAA    VAL
        STAA    MEM
        LDAA    CCV
        TAP
        ROL     MEM
        LDAA    MEM
        LDAA    VAL
        STAA    MEM
        LDAA    CCV
        TAP
        DEC     MEM
        LDAA    MEM
        LDAA    VAL
        STAA    MEM
        LDAA    CCV
        TAP
        INC     MEM
        LDAA    MEM
        LDAA    VAL
        STAA    MEM
        LDAA    CCV
        TAP
        TST     MEM
        LDAA    MEM
        LDAA    VAL
        STAA    MEM
        LDAA    CCV
        TAP
        CLR     MEM
        LDAA    MEM
        LDAA    OPR
        LDX     #MEM-3
        STAA    3,X
        LDAA    CCV
        TAP
        NEG     3,X
        LDAB    3,X
        LDAA    OPR
        LDX     #MEM-3
        STAA    3,X
        LDAA    CCV
        TAP
        COM     3,X
        LDAB    3,X
        LDAA    OPR
        LDX     #MEM-3
        STAA    3,X
        LDAA    CCV
        TAP
        LSR     3,X
        LDAB    3,X
        LDAA    OPR
        LDX     #MEM-3
        STAA    3,X
        LDAA    CCV
        TAP
        ROR     3,X
        LDAB    3,X
        LDAA    OPR
        LDX     #MEM-3
        STAA    3,X
        LDAA    CCV
        TAP
        ASR     3,X
        LDAB    3,X
        LDAA    OPR
        LDX     #MEM-3
        STAA    3,X
        LDAA    CCV
        TAP
        ASL     3,X
        LDAB    3,X
        LDAA    OPR
        LDX     #MEM-3
        STAA    3,X
        LDAA    CCV
        TAP
        ROL     3,X
        LDAB    3,X
        LDAA    OPR
        LDX     #MEM-3
        STAA    3,X
        LDAA    CCV
        TAP
        DEC     3,X
        LDAB    3,X
        LDAA    OPR
        LDX     #MEM-3
        STAA    3,X
        LDAA    CCV
        TAP
        INC     3,X
        LDAB    3,X
        LDAA    OPR
        LDX     #MEM-3
        STAA    3,X
        LDAA    CCV
        TAP
        TST     3,X
        LDAB    3,X
        LDAA    OPR
        LDX     #MEM-3
        STAA    3,X
        LDAA    CCV
        TAP
        CLR     3,X
        LDAB    3,X
        LDAA    CCV
        TAP
        LDAA    VAL
        ADDA    OPR
        DAA
        LDAA    CCV
        TAP
        LDAA    VAL
        ADCA    OPR
        DAA
        LDAA    CCV
        TAP
        LDAA    VAL
        DAA
        LDAB    OPR
        LDAA    CCV
        TAP
        LDAA    VAL
        ABA
        LDAB    OPR
        LDAA    CCV
        TAP
        LDAA    VAL
        SBA
        LDAB    OPR
        LDAA    CCV
        TAP
        LDAA    VAL
        CBA
        LDAB    OPR
        LDAA    CCV
        TAP
        LDAA    VAL
        TAB
        LDAB    OPR
        LDAA    CCV
        TAP
        LDAA    VAL
        TBA
        LDAA    CCV
        TAP
        LDD     VAL
        ADDD    #$7F81
        LDAA    CCV
        TAP
        LDD     VAL
        SUBD    #$8001
        LDAA    CCV
        TAP
        LDD     VAL
        ADDD    VAL
        LDAA    CCV
        TAP
        LDD     VAL
        SUBD    VAL
        LDAA    CCV
        TAP
        LDX     VAL
        CPX     #$8000
        LDAA    CCV
        TAP
        LDX     VAL
        CPX     VAL
        LDAA    CCV
        TAP
        LDD     VAL
        LSRD
        LDAA    CCV
        TAP
        LDD     VAL
        ASLD
        LDAA    CCV
        TAP
        LDAA    VAL
        LDAB    OPR
        MUL
        LDAA    CCV
        TAP
        LDX     VAL
        LDAB    OPR
        ABX
        INX
        DEX
        DEX
        LDAA    CCV
        TAP
        TPA
        LDAA    CCV
        TAP
        CLC
        TPA
        LDAA    CCV
        TAP
        SEC
        TPA
        LDAA    CCV
        TAP
        CLV
        TPA
        LDAA    CCV
        TAP
        SEV
        TPA
        LDAA    CCV
        TAP
        LDAA    VAL
        CMPA    OPR
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
        LDAA    CCV
        TAP
        BRA     BS17
        NOP
BS17
        BRN     BS18
        NOP
BS18
        BHI     BS19
        NOP
BS19
        BLS     BS20
        NOP
BS20
        BCC     BS21
        NOP
BS21
        BCS     BS22
        NOP
BS22
        BNE     BS23
        NOP
BS23
        BEQ     BS24
        NOP
BS24
        BVC     BS25
        NOP
BS25
        BVS     BS26
        NOP
BS26
        BPL     BS27
        NOP
BS27
        BMI     BS28
        NOP
BS28
        BGE     BS29
        NOP
BS29
        BLT     BS30
        NOP
BS30
        BGT     BS31
        NOP
BS31
        BLE     BS32
        NOP
BS32
        RTS
PHASE2  LDX     #$4200
        CLRB
FILL    STAB    0,X
        INX
        INCB
        CPX     #$4400
        BNE     FILL
        LDX     #$4280
        LDAA    #$5A
        LDAB    #$5A
        ADDA    #$5A
        CMPB    #$5A
        LDAA    VAL
        LDAB    VAL
        ADDA    VAL
        CMPB    VAL
        LDAA    $90
        LDAB    $90
        ADDA    $90
        CMPB    $90
        LDAA    $4280
        LDAB    $4280
        ADDA    $4280
        CMPB    $4280
        LDAA    >$0081
        LDAB    >$0081
        ADDA    >$0081
        CMPB    >$0081
        LDAA    0,X
        LDAB    0,X
        ADDA    0,X
        CMPB    0,X
        LDAA    1,X
        LDAB    1,X
        ADDA    1,X
        CMPB    1,X
        LDAA    127,X
        LDAB    127,X
        ADDA    127,X
        CMPB    127,X
        LDAA    255,X
        LDAB    255,X
        ADDA    255,X
        CMPB    255,X
        LDD     $90
        ADDD    $90
        SUBD    $90
        CPX     $90
        LDX     $90
        LDX     #$4280
        STAA    $90
        STAB    $90
        STD     $90
        STX     $90
        STS     $90
        LDS     $90
        LDS     #$8FF0
        LDD     $4300
        ADDD    $4300
        SUBD    $4300
        CPX     $4300
        LDX     $4300
        LDX     #$4280
        STAA    $4300
        STAB    $4300
        STD     $4300
        STX     $4300
        STS     $4300
        LDS     $4300
        LDS     #$8FF0
        LDD     0,X
        ADDD    0,X
        SUBD    0,X
        CPX     0,X
        LDX     0,X
        LDX     #$4280
        STAA    0,X
        STAB    0,X
        STD     0,X
        STX     0,X
        STS     0,X
        LDS     0,X
        LDS     #$8FF0
        LDD     200,X
        ADDD    200,X
        SUBD    200,X
        CPX     200,X
        LDX     200,X
        LDX     #$4280
        STAA    200,X
        STAB    200,X
        STD     200,X
        STX     200,X
        STS     200,X
        LDS     200,X
        LDS     #$8FF0
        LDD     #$1234
        LDX     #$5678
        PSHA
        PSHB
        PSHX
        TSX
        LDAA    0,X
        PULX
        PULA
        PULB
        DES
        DES
        INS
        TSX
        TXS
        INS
        LDS     #$00FE
        PSHX
        PSHA
        PULB
        PULX
        LDS     #$8FF0
        BSR     SUB1
        JSR     SUB1
        JSR     DSUB
        LDX     #SUB1
        JSR     0,X
        LDX     #SUB1-4
        JSR     4,X
        LDX     #J1
        JMP     0,X
J1      JMP     J2
J2      SWI
        SWI
        FCB     $02,$41,$5E
        JMP     PHASE3
SUB1    INC     CNT
        RTS
PHASE3  LDAA    TCSR
        LDD     CTR
        LDAA    CTR
        LDAB    CTR+1
        LDD     CTR
        ADDD    #100
        STD     OCR
WOC     LDAA    TCSR
        BITA    #$40
        BEQ     WOC
        LDD     CTR
        LDAA    TCSR
        LDD     OCR
        ADDD    #50
        STD     OCR
        LDAA    TCSR
        LDD     OCR
        STD     OCR
        LDAA    TCSR
        LDAA    #$08
        STAA    TCSR
        LDD     CTR
        ADDD    #300
        STD     OCR
        CLI
BUSY    INC     CNT
        LDAA    OCN
        CMPA    #4
        BNE     BUSY
        SEI
        LDD     CTR
        ADDD    #400
        STD     OCR
        CLI
        NOP
        WAI
        LDD     CTR
        WAI
        SEI
        LDD     CTR
        LDAA    #$09
        STAA    TCSR
        LDAA    #$03
        STAA    $01
        LDAA    #$13
        ANDA    $03
        CLI
        WAI
        SEI
        LDAA    #$13
        ANDA    $03
        LDAA    #$08
        STAA    TCSR
TOV     LDAA    TCSR
        STAA    CTR
        LDD     CTR
        NOP
        LDAA    TCSR
        LDAA    TCSR
        LDAA    CTR
        LDAA    TCSR
        LDD     #$FF80
        STD     CTR
WTOF    LDAA    TCSR
        BITA    #$20
        BEQ     WTOF
        LDAA    CTR
        LDAA    TCSR
        LDAA    #$04
        STAA    TCSR
        LDD     #$FE00
        STD     CTR
        CLI
        WAI
        SEI
        CLR     TCSR
        LDD     CTR
        ADDD    #40
        STD     OCR
WOC2    LDAA    TCSR
        BITA    #$40
        BEQ     WOC2
        LDAA    #$08
        STAA    TCSR
        LDAA    #$C0
        TAP
        NOP
        NOP
        SEI
        CLR     TCSR
        LDAA    #$FF
        STAA    $00
        LDX     #STRB
KB      LDAA    0,X
        STAA    $02
        LDAB    KBD
        LDAA    #$13
        ANDA    $03
        LDAA    $02
        INX
        CPX     #STRBE
        BNE     KB
        LDAA    #$0F
        STAA    $00
        LDAA    $02
        LDAA    #$F0
        STAA    $02
        LDAA    $02
        LDAB    KBD
        LDAA    #$FF
        STAA    $00
        LDAA    #$01
        STAA    $01
        LDAA    #$01
        STAA    $03
        CLR     $03
        LDAA    #$13
        ANDA    $03
        CLRA
VL      STAA    KBD
        ADDA    #3
        BCC     VL
        CLR     KBD
        LDAA    $4000
        LDAA    $3000
        LDAA    $C000
        LDAA    $0020
        LDAA    $14
        LDAA    $11
DONE    LDAA    #$01
        STAA    CNT
HALT    BRA     HALT
STRB    FCB     $FE,$FD,$FB,$F7,$EF,$DF,$BF,$7F,$00,$FF,$7E,$5A
STRBE   EQU     *
OCIH    INC     OCN
        LDAA    TCSR
        LDD     OCR
        ADDD    #300
        STD     OCR
        RTI
TOIH    INC     TON
        LDAA    TCSR
        LDAA    CTR
        RTI
SWIH    INC     SWN
        TSX
        LDAA    0,X
        RTI
OTHER   RTI
        ORG     $FFF0
        FDB     OTHER,TOIH,OCIH,OTHER,OTHER,SWIH,OTHER,RESET
        END     RESET
