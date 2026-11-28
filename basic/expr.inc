* ---------------- expressions ----------------
* Precedence, highest first [UM]: ^; unary minus; * /; + -; relations (= < > <= >= <>); NOT; AND; OR. The
* operators of one level go left to right. A number ends in FAC (VALTYP 0), a string as STRPTR (VALTYP $FF).
* Every level starts on the expression's first character and ends on the first one after it, with that
* character in A both times: only EVAL and an operand (EP1, EVATOM) read it again, and each level reads it after
* its own operation (the FCB $8C before that, CMPX #, skips the two-byte call on the way in).

* EVAL: an expression of either type
EVAL    LEAX    -48,S           ; (CHKSP, inline)
        CMPX    <ARYEND
        LBLO    OMERR
        JSR     <ZCHRGOT
* OR
EVOR    BSR     EVAND
        FCB     $8C
EO0     JSR     <ZCHRGOT
EO1     CMPA    #T_OR
        BNE     EVRTS
        JSR     PSHINT
        JSR     <ZCHRGET
        BSR     EVAND
        JSR     POPINT          ; D: the left operand, INTVAL: the right
        ORA     <INTVAL
        ORB     <INTVAL+1
        JSR     GIVABF
        BRA     EO0
* AND
EVAND   BSR     EVNOT
        FCB     $8C
EA0     JSR     <ZCHRGOT
EA1     CMPA    #T_AND
        BNE     EVRTS
        JSR     PSHINT
        JSR     <ZCHRGET
        BSR     EVNOT
        LDB     #ANDDLY         ; AND's wait: ours would be faster than the original [BB bb10 time-ops: X=I AND 1]
EA2     DECB
        BNE     EA2
        JSR     POPINT
        ANDA    <INTVAL
        ANDB    <INTVAL+1
        JSR     GIVABF
        BRA     EA0
EVRTS   RTS
* NOT: applies to a relation; also an operand (EVATOM)
EVNOT   CMPA    #T_NOT
        BNE     EVREL
        JSR     <ZCHRGET
        BSR     EVNOT
        JSR     INTCNV
        COMA
        COMB
        JSR     GIVABF
        JMP     <ZCHRGOT
* relations: one or more of < = > make the operator; the result is -1 (true) or 0 (false)
EVREL   BSR     EVADD
        FCB     $8C
ER0     JSR     <ZCHRGOT
ER1     CLRB
ER2     CMPA    #T_GT           ; >, = and < are three tokens in a row
        BLO     ER6
        CMPA    #T_GT+2
        BHI     ER6
        LDX     #RELBIT-T_GT+256 ; (A,X takes A as signed, and the tokens are $80 and up)
        ORB     A,X
        JSR     <ZCHRGET
        BRA     ER2
RELBIT  FCB     4,2,1           ; the bits of >, =, <
ER6     TSTB
        BEQ     EVRTS
        PSHS    B
        JSR     PUSHV
        JSR     <ZCHRGOT        ; (PUSHV uses A)
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
ER8     NEGA                    ; $FF, 0, 1 -> the bit 1, 2 or 4
        INCA
        LDX     #RELBIT
        LDB     A,X
ER10    CLR     <VALTYP         ; -1 (true) or 0, from the constants
        LDX     #FPM1
        ANDB    ,S+
        BNE     ER11
        LDX     #ZEROV
ER11    JSR     MOVFM
        BRA     ER0
* + and -; + also joins strings
ANDDLY  EQU     83
DIVDLY  EQU     27
MULDLY  EQU     35
EVADD   BSR     EVMUL
        FCB     $8C
EAD0    JSR     <ZCHRGOT
EAD1    CMPA    #T_PLUS
        BEQ     EAD2
        CMPA    #T_MINUS
        BNE     EVRTS2
EAD2     PSHS    A
        JSR     PUSHV
        JSR     <ZCHRGET
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
        BRA     EAD0
EAD3     CMPA    #T_PLUS
        BEQ     EAD4
        JSR     FNEG            ; -: the negative added
EAD4    JSR     FADD
        BRA     EAD0
EVRTS2  RTS
* * and /
EVMUL   BSR     EVNEG
        FCB     $8C
EM0     JSR     <ZCHRGOT
EM1     CMPA    #T_MUL
        BEQ     EM2
        CMPA    #T_DIV
        BNE     EVRTS2
EM2     PSHS    A
        JSR     <ZCHKNUM
        JSR     PUSHV
        JSR     <ZCHRGET
        BSR     EVNEG
        JSR     <ZCHKNUM
        JSR     POPARG
        PULS    A
        CMPA    #T_MUL
        BNE     EM3
        LDB     #MULDLY         ; a product's wait [BB ram-pointers2: X=I*2.5]
EM2A    DECB
        BNE     EM2A
        JSR     FMUL
        BRA     EM0
EM3     LDB     #DIVDLY         ; a quotient's wait [BB ram-pointers2: X=I/3]
EM4     DECB
        BNE     EM4
        JSR     FDIV
        BRA     EM0
* unary minus and plus
EVNEG   CMPA    #T_MINUS
        BEQ     EN1
        CMPA    #T_PLUS
        BNE     EVPOW
        JSR     <ZCHRGET
        BRA     EVNEG
EN1     JSR     <ZCHRGET
        BSR     EVNEG
        JSR     <ZCHKNUM
        BRA     EVNEGJ
* ^ (its right operand may have a sign)
EVPOW   BSR     EVATOM
EP1     JSR     <ZCHRGOT
        CMPA    #T_POW
        BNE     EVRTS2
        JSR     <ZCHKNUM
        JSR     PUSHV
        JSR     <ZCHRGET
        BSR     EVPWR
        JSR     <ZCHKNUM
        JSR     POPARG
        JSR     FPOWER
        BRA     EP1
EVPWR   CMPA    #T_MINUS
        BNE     EVPW1
        JSR     <ZCHRGET
        BSR     EVPWR
        BSR     CHKNUM
EVNEGJ  JMP     FNEG
EVPW1   CMPA    #T_PLUS
        BNE     EVATOM
        JSR     <ZCHRGET
        BRA     EVPWR

* an operand: a number, a string in quotes, ( expression ), a variable, a function
EVATOM  CLR     <VALTYP
        JSR     <ZCHRGOT
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
        CMPA    #T_NOT          ; NOT as an operand, after an operator: NOT and a relation, as at the start
        BNE     EVASN           ; ("1<NOT 0" is 1<(NOT 0), 0; "5+NOT 0" 4; "-NOT 0" 1) [BB bb9 expr-not]
        JSR     CHKSP
        JMP     EVNOT
EVASN   JMP     <ZSNERR
EVNUMB  JMP     FIN
EVPAR   JSR     <ZCHRGET
        JSR     EVAL
        JMP     <ZRPAREN
EVVAR   CLR     <VARCRE
        JSR     PTRGET
        TST     <VALTYP
        LBEQ    MOVFM
EVV1    STX     <STRPTR
        RTS
* a function: $FF and its token; the routine starts on the character after the token
EVFUNC  JSR     <ZCHRGET
        CMPA    #TF_LAST
        BHI     EVFSN
        TFR     A,B
        ASLB                    ; (the token's bit 7 goes: twice its place in the table)
        BCC     EVFSN
        LDX     #FUNCDS
        ABX
        LDX     ,X
        JSR     <ZCHRGET
        JMP     ,X
EVFSN   JMP     <ZSNERR

* EVNUM, EVSTR: an expression that must be a number, or a string (?TM ERROR)
EVNUM   JSR     EVAL
CHKNUM  TST     <VALTYP
        BNE     CKTM
CK1     RTS
EVSTR   JSR     EVAL
CHKSTR  TST     <VALTYP
        BNE     CK1
CKTM    JMP     TMERR
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
        JSR     <ZMOVMF
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
INTCNV  BSR     CHKNUM
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
        LBLS    NEGD
ICFC    JMP     <ZFCERR
GETIDX  JSR     INTCNV
        TSTA
        BMI     ICFC
        RTS
* GETADR: FAC as an address, 0-65535, in D (?FC ERROR otherwise)
* EVADR: an expression as an address
EVADR   JSR     <ZEVNUM
GETADR  JSR     <ZCHKNUM
        TST     <FACSGN
        BMI     ICFC
        JSR     QINT
        LDD     <FACM
        BNE     ICFC
        LDD     <FACM+2
        RTS
* GETBYT: an expression 0-255 into B (and D)
GETBYT  JSR     <ZEVNUM
CNVBYT  BSR     GETADR
        TSTA
        BNE     ICFC
        RTS

* &H hexadecimal and &O octal numbers (&nn is octal) [UM]. An octal number takes 8 and 9 as digits too, x 8 and
* added: &O8 and VAL("&O8") are 8 [BB bb10 num-val-hex; 9 is our inference]
HEXLIT  CLR     <FPN
        CLR     <FPN+1
        LDX     #$040F          ; &H: the bits a digit, the largest digit
        JSR     <ZCHRGET
        CMPA    #'H'
        BEQ     HX1
        LDX     #$0309          ; &O, and & alone
        CMPA    #'O'
        BNE     HX2
HX1     JSR     <ZCHRGET
HX2     STX     <TMPCNT
HX3     JSR     <ZCHRGOT
        SUBA    #'0'
        BLO     HXEND
        CMPA    #9
        BLS     HX4
        SUBA    #7              ; a letter: A is 10
        CMPA    #10
        BLO     HXEND
HX4     CMPA    <TMPCNT+1
        BHI     HXEND
        LDB     <TMPCNT
HX5     PSHS    A
HX6     ASL     <FPN+1
        ROL     <FPN
        BCS     HXOV
        DECB
        BNE     HX6
        PULS    B
        CLRA
        ADDD    <FPN
        BCS     HXOV
        STD     <FPN
        JSR     <ZCHRGET
        BRA     HX3
HXOV    JMP     OVERR
HXEND   LDD     <FPN
        JSR     GIVUNS
        JMP     <ZCHRGOT

