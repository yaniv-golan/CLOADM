* ---------------- expressions ----------------
* Precedence, highest first [UM]: ^; unary minus; * /; + -; relations (= < > <= >= <>); NOT; AND; OR. The
* operators of one level go left to right. A number ends in FAC (VALTYP 0), a string as STRPTR (VALTYP $FF).
* Every level starts on the expression's first character (CHRGOT) and ends on the first one after it.

* EVAL: an expression of either type
EVAL    JSR     CHKSP
* OR
EVOR    BSR     EVAND
EO1     JSR     CHRGOT
        CMPA    #T_OR
        BNE     EVRTS
        JSR     PSHINT
        JSR     CHRGET
        BSR     EVAND
        JSR     POPINT          ; D: the left operand, INTVAL: the right
        ORA     <INTVAL
        ORB     <INTVAL+1
        JSR     GIVABF
        BRA     EO1
* AND
EVAND   BSR     EVNOT
EA1     JSR     CHRGOT
        CMPA    #T_AND
        BNE     EVRTS
        JSR     PSHINT
        JSR     CHRGET
        BSR     EVNOT
        JSR     POPINT
        ANDA    <INTVAL
        ANDB    <INTVAL+1
        JSR     GIVABF
        BRA     EA1
EVRTS   RTS
* NOT: applies to a relation
EVNOT   JSR     CHRGOT
        CMPA    #T_NOT
        BNE     EVREL
        JSR     CHRGET
        BSR     EVNOT
        JSR     INTCNV
        COMA
        COMB
        JMP     GIVABF
* relations: one or more of < = > make the operator; the result is -1 (true) or 0 (false)
EVREL   BSR     EVADD
ER1     JSR     CHRGOT
        CLRB
ER2     CMPA    #T_LT
        BNE     ER3
        ORB     #1
        BRA     ER5
ER3     CMPA    #T_EQ
        BNE     ER4
        ORB     #2
        BRA     ER5
ER4     CMPA    #T_GT
        BNE     ER6
        ORB     #4
ER5     JSR     CHRGET
        BRA     ER2
ER6     TSTB
        BEQ     EVRTS
        PSHS    B
        JSR     PUSHV
        BSR     EVADD
        JSR     POPARG
        LDA     <LEFTTY
        CMPA    <VALTYP
        LBNE    TMERR
        TSTA
        BNE     ER7
        JSR     FCMP
        BRA     ER8
ER7     JSR     STRCMP
ER8     INCA                    ; $FF, 0, 1 -> the bit 1, 2 or 4
        LDB     #1
ER9     DECA
        BMI     ER10
        ASLB
        BRA     ER9
ER10    ANDB    ,S+
        BEQ     ER11
        LDD     #-1
        BRA     ER12
ER11    LDD     #0
ER12    CLR     <VALTYP
        JSR     GIVABF
        BRA     ER1
* + and -; + also joins strings
EVADD   BSR     EVMUL
EAD1     JSR     CHRGOT
        CMPA    #T_PLUS
        BEQ     EAD2
        CMPA    #T_MINUS
        BNE     EVRTS2
EAD2     PSHS    A
        JSR     PUSHV
        JSR     CHRGET
        BSR     EVMUL
        JSR     POPARG
        PULS    A
        LDB     <LEFTTY
        CMPB    <VALTYP
        LBNE    TMERR
        TSTB
        BEQ     EAD3
        CMPA    #T_PLUS         ; strings: only +
        LBNE    TMERR
        JSR     CONCAT
        BRA     EAD1
EAD3     CMPA    #T_PLUS
        BNE     EAD4
        JSR     FADD
        BRA     EAD1
EAD4     JSR     FSUB
        BRA     EAD1
EVRTS2  RTS
* * and /
EVMUL   BSR     EVNEG
EM1     JSR     CHRGOT
        CMPA    #T_MUL
        BEQ     EM2
        CMPA    #T_DIV
        BNE     EVRTS2
EM2     PSHS    A
        JSR     CHKNUM
        JSR     PUSHV
        JSR     CHRGET
        BSR     EVNEG
        JSR     CHKNUM
        JSR     POPARG
        PULS    A
        CMPA    #T_MUL
        BNE     EM3
        JSR     FMUL
        BRA     EM1
EM3     JSR     FDIV
        BRA     EM1
* unary minus and plus
EVNEG   JSR     CHRGOT
        CMPA    #T_MINUS
        BEQ     EN1
        CMPA    #T_PLUS
        BNE     EVPOW
        JSR     CHRGET
        BRA     EVNEG
EN1     JSR     CHRGET
        BSR     EVNEG
        JSR     CHKNUM
        JMP     FNEG
* ^ (its right operand may have a sign)
EVPOW   BSR     EVATOM
EP1     JSR     CHRGOT
        CMPA    #T_POW
        BNE     EVRTS2
        JSR     CHKNUM
        JSR     PUSHV
        JSR     CHRGET
        BSR     EVPWR
        JSR     CHKNUM
        JSR     POPARG
        JSR     FPOWER
        BRA     EP1
EVPWR   CMPA    #T_MINUS
        BNE     EVPW1
        JSR     CHRGET
        BSR     EVPWR
        JSR     CHKNUM
        JMP     FNEG
EVPW1   CMPA    #T_PLUS
        BNE     EVATOM
        JSR     CHRGET
        BRA     EVPWR

* an operand: a number, a string in quotes, ( expression ), a variable, a function
EVATOM  CLR     <VALTYP
        JSR     CHRGOT
        BCS     EVNUMB
        CMPA    #'.'
        BEQ     EVNUMB
        CMPA    #'"'
        LBEQ    STRLIT
        CMPA    #'('
        BEQ     EVPAR
        CMPA    #$FF
        BEQ     EVFUNC
        CMPA    #T_FN
        LBEQ    FNCALL
        CMPA    #'&'
        LBEQ    HEXLIT
        JSR     ISLET
        BCS     EVVAR
        JMP     SNERR
EVNUMB  JMP     FIN
EVPAR   JSR     CHRGET
        JSR     EVAL
RPAREN  LDB     #')'
        JMP     SYNCHR
LPAREN  LDB     #'('
        JMP     SYNCHR
EVVAR   CLR     <VARCRE
        JSR     PTRGET
        TST     <VALTYP
        BNE     EVV1
        JMP     MOVFM
EVV1    STX     <STRPTR
        RTS
* a function: $FF and its token; the routine starts on the character after the token
EVFUNC  JSR     CHRGET
        CMPA    #TF_LAST
        BHI     EVFSN
        SUBA    #$80
        BLO     EVFSN
        LDX     #FUNCDS
        LSLA
        BCC     EVF1
        LEAX    256,X
EVF1    LDX     A,X
        JSR     CHRGET
        JMP     ,X
EVFSN   JMP     SNERR

* EVNUM, EVSTR: an expression that must be a number, or a string (?TM ERROR)
EVNUM   JSR     EVAL
CHKNUM  TST     <VALTYP
        BEQ     CK1
        JMP     TMERR
CK1     RTS
EVSTR   JSR     EVAL
CHKSTR  TST     <VALTYP
        BNE     CK1
        JMP     TMERR
* CHKSP: room on the stack for another level (?OM ERROR)
CHKSP   PSHS    D
        TFR     S,D
        SUBD    #48
        CMPD    <ARYEND
        PULS    D
        BLO     CHKSP1
        RTS
CHKSP1  JMP     OMERR

* PUSHV: the value just evaluated onto the stack (under the caller's return address): a number packed (5 bytes)
* and 0, or the descriptor pointer and $FF. POPARG takes it back: a number into ARG, a string into ARGSTR;
* its type in LEFTTY.
PUSHV   PULS    U
        TST     <VALTYP
        BNE     PV1
        LEAS    -5,S
        TFR     S,X
        JSR     MOVMF
        CLRA
        PSHS    A
        JMP     ,U
PV1     LDX     <STRPTR
        PSHS    X
        LDA     #$FF
        PSHS    A
        JMP     ,U
POPARG  PULS    U
        PULS    A
        STA     <LEFTTY
        TSTA
        BNE     PA1
        TFR     S,X
        JSR     MOVAM
        LEAS    5,S
        JMP     ,U
PA1     PULS    X
        STX     <ARGSTR
        JMP     ,U
* PSHINT: the number just evaluated as a 16-bit integer, onto the stack. POPINT: D = it, INTVAL = the number
* evaluated since, as an integer.
PSHINT  BSR     INTCNV
        PULS    U
        PSHS    D
        JMP     ,U
POPINT  BSR     INTCNV
        STD     <INTVAL
        PULS    U
        PULS    D
        JMP     ,U

* INTCNV: FAC (a number) as a signed 16-bit integer in D, its fraction dropped: -32768 to 32767, or ?FC ERROR
INTCNV  JSR     CHKNUM
        JSR     QINT
        LDD     <FACM
        BNE     ICFC
        LDD     <FACM+2
        TST     <FACSGN
        BMI     IC1
        CMPD    #$7FFF
        BHI     ICFC
        RTS
IC1     CMPD    #$8000
        BHI     ICFC
        COMA
        COMB
        ADDD    #1
        RTS
ICFC    JMP     FCERR
* GETADR: FAC as an address, 0-65535, in D (?FC ERROR otherwise)
GETADR  JSR     CHKNUM
        TST     <FACSGN
        BMI     ICFC
        JSR     QINT
        LDD     <FACM
        BNE     ICFC
        LDD     <FACM+2
        RTS
* GETBYT: an expression 0-255 into B (and D)
GETBYT  JSR     EVNUM
CNVBYT  BSR     GETADR
        TSTA
        BNE     ICFC
        RTS
* GETNUM: an expression as an integer -32768 to 32767 into D
GETNUM  JSR     EVNUM
        BRA     INTCNV

* &H hexadecimal and &O octal numbers (&nn is octal) [UM]
HEXLIT  CLR     <FPN
        CLR     <FPN+1
        LDB     #4              ; bits a digit: &H
        JSR     CHRGET
        CMPA    #'H'
        BEQ     HX1
        LDB     #3
        CMPA    #'O'
        BNE     HX2
HX1     JSR     CHRGET
HX2     STB     <TMPCNT
HX3     JSR     CHRGOT
        SUBA    #'0'
        BLO     HXEND
        CMPA    #9
        BLS     HX4
        LDB     <TMPCNT
        CMPB    #4
        BNE     HXEND
        SUBA    #7
        CMPA    #10
        BLO     HXEND
        CMPA    #15
        BHI     HXEND
HX4     LDB     <TMPCNT
        CMPB    #3
        BNE     HX5
        CMPA    #7
        BHI     HXEND
HX5     PSHS    A
HX6     ASL     <FPN+1
        ROL     <FPN
        BCS     HXOV
        DECB
        BNE     HX6
        PULS    A
        ORA     <FPN+1
        STA     <FPN+1
        JSR     CHRGET
        BRA     HX3
HXOV    JMP     OVERR
HXEND   LDD     <FPN
        STD     <FACM
        CLR     <FACM+2
        CLR     <FACM+3
        CLR     <FACEXT
        CLR     <FACSGN
        LDA     #128+16
        STA     <FACEXP
        JSR     NORM
        JMP     CHRGOT

* FPOWER: FAC = ARG ^ FAC (M6)
FPOWER  JMP     FCERR
* FNCALL: FN name(argument) (M6)
FNCALL  JMP     UNIMPL
