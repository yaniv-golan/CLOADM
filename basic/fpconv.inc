* ---------------- numbers to and from text, and integers ----------------

* POWX: X = the address of 10^B in POWTAB. Keeps B.
POWX    PSHS    B
        LDA     #5
        MUL
        LDX     #POWTAB
        LEAX    D,X
        PULS    B,PC
* FCMPP: compare 10^B with FAC (A and the flags as FCMP: > 0 when FAC is below it)
* FCMPM: compare the packed number at X with FAC, as FCMP
FCMPP   BSR     POWX
FCMPM   JSR     MOVAM
        BRA     FCMP
* FMULP: FAC = FAC x 10^B. FDIVP: FAC = FAC / 10^B.
FMULP   BSR     POWX
        JMP     FMULX
* FDIVR: FAC = FAC / the packed number at X
FDIVP   BSR     POWX
FDIVR   PSHS    X
        JSR     MOVAF
        PULS    X
        JSR     MOVFM
        JMP     FDIV
* E10INC, E10DEC: FPE10 + 1, - 1. E10ADJ: FPE10 + B (signed). The new value is in D too.
E10INC  LDB     #1
        FCB     $8C             ; (CMPX #: skips the LDB)
E10DEC  LDB     #-1
E10ADJ  SEX
        ADDD    <FPE10
        STD     <FPE10
        RTS

* I32FLT: FAC = the unsigned 32-bit integer in FACM, positive
I32FLT  CLR     <FACSGN
        LDA     #128+32
        BRA     FLT1

* GIVABF: FAC = D, a signed 16-bit integer
GIVABF  CLR     <FACSGN
        TSTA
        BPL     GIV1
        COM     <FACSGN
        JSR     NEGD
* GIV1: FAC = the unsigned 16-bit integer in D, with the sign FACSGN already holds
GIV1    STD     <FACM
        CLR     <FACM+2
        CLR     <FACM+3
        LDA     #128+16
FLT1    STA     <FACEXP
        CLR     <FACEXT
        JMP     NORM

* QINT: FACM = the integer part of |FAC| (truncated), for |FAC| below 2^32. Keeps the sign.
QINT    JSR     ROUND
        LDB     #128+32
        SUBB    <FACEXP         ; places to shift right
        BLS     QI3             ; (not reached: |FAC| >= 2^32)
        CMPB    #40
        BLO     QI1
        LDB     #40             ; below 1/256: 0 all the same
QI1     PSHS    X
        LDX     #FACM
        JSR     SHFTR
        CLR     <FACEXT         ; (the bits shifted out of the integer)
        PULS    X
QI3     RTS

* MUL10: FAC = FAC x 10. DIV10: FAC = FAC / 10.
MUL10   LDB     #1
        BRA     FMULP
DIV10   LDB     #1
        BRA     FDIVP

* ---------------- FOUT: FAC as text ----------------
* FBUFFR gets ' ' or '-', then the number: up to nine significant digits, trailing zeros dropped; fixed point
* from 0.01 up to below 1E9, otherwise d.ddddE+nn [UM; the bounds to be confirmed by black-box runs].
* Returns X = FBUFFR, the text 0-terminated.
FOUT    LDA     #' '
        TST     <FACSGN
        BPL     FO1
        LDA     #'-'
FO1     STA     FBUFFR
        LDU     #FBUFFR+1
        CLR     <FACSGN
        JSR     ROUND
        TST     <FACEXP
        BNE     FO2
        LDA     #'0'
        STA     ,U+
        LBRA    FOEND
FO2     CLRA
        CLRB
        STD     <FPE10
* scale FAC into [1E8, 1E9): steps of 1E9 from 1E17 down and from below 1 up, then single steps of 10, each one
* rounded: the original prints 1E5 - 6 x 2^-15 (its SQR(1E10)) as 99999.9999, as four such steps do and one
* product by 1E4 does not [BB bb1 fn-math, bb2 fn-sqr-bits]
        LDB     #9
        JSR     FCMPP
        BGT     FOU0            ; below 1E9
FOD1    LDB     #17             ; 1E17 and up: / 1E9
        JSR     FCMPP
        BGT     FOFIX
        LDB     #9
        JSR     FDIVP
        LDB     #9
        JSR     E10ADJ
        BRA     FOD1
FOU0    LDB     #8
        JSR     FCMPP
        BLE     FOFIX           ; already in range
FOU1    CLRB                    ; below 1: x 1E9
        JSR     FCMPP
        BLE     FOFIX
        LDB     #9
        JSR     FMULP
        LDB     #-9
        JSR     E10ADJ
        BRA     FOU1
FOFIX
FO3     LDX     #FP1E8          ; while FAC < 1E8: x 10
        JSR     FCMPM
        BLE     FO4
        JSR     MUL10
        JSR     E10DEC
        BRA     FO3
FO4     LDX     #FP1E9          ; while FAC >= 1E9: / 10
        JSR     FCMPM
        BGT     FO5
        JSR     DIV10
        JSR     E10INC
        BRA     FO4
FO5     LDX     #FPHALF         ; + 0.5, and the integer part: nine digits
        JSR     FADDX
        LDX     #FP1E9          ; rounded up to 1000000000: 100000000 and one more place (compared before the
*                                 integer is taken: QINT rounds as FCMPM does, then only drops the fraction)
        JSR     FCMPM
        BGT     FO5B
        LDX     #FP1E8
        JSR     MOVFM
        JSR     E10INC
FO5B    JSR     QINT
* the nine digits into FPDIG, by PRINT USING's decimal converter (the integer is 100000000-999999999: nine
* digits exactly)
FO6     LDU     #FPDIG+9
        JSR     U32DU
* how many digits matter: trailing zeros dropped
        LDB     #9
FO10    DECB
        LDX     #FPDIG
        LDA     B,X
        CMPA    #'0'
        BNE     FO11
        TSTB
        BNE     FO10
FO11    INCB
        STB     <FPND           ; significant digits, 1-9
        LDU     #FBUFFR+1       ; (the arithmetic above uses U)
        LDD     <FPE10          ; E: the decimal exponent of the first digit
        ADDD    #8
        STD     <FPE10
        CMPD    #-2
        BLT     FOSCI
        CMPD    #8
        BGT     FOSCI
* fixed point
        LDX     #FPDIG
        TSTA
        BMI     FOFR            ; E < 0: a fraction
        INCB                    ; E + 1 digits before the point
        JSR     CPYXU
        LDB     <FPE10+1
        INCB
        CMPB    <FPND
        BHS     FOEND           ; nothing after the point
        LDA     #'.'
        STA     ,U+
        LDB     <FPND
        SUBB    <FPE10+1
        DECB
        JSR     CPYXU
        BRA     FOEND
FOFR    LDA     #'.'
        STA     ,U+
        LDB     <FPE10+1        ; -E - 1 zeros
        NEGB
        DECB
        BEQ     FOF2
        LDA     #'0'
FOF1    STA     ,U+
        DECB
        BNE     FOF1
FOF2    LDB     <FPND
        JSR     CPYXU
        BRA     FOEND
* d.ddddE+nn
FOSCI   LDX     #FPDIG
        LDA     ,X+
        STA     ,U+
        LDB     <FPND
        DECB
        BEQ     FOS2
        LDA     #'.'
        STA     ,U+
        JSR     CPYXU
FOS2    LDD     <FPE10
        BSR     EXPOUT
FOEND   CLR     ,U
        LDX     #FBUFFR
        RTS
* EXPOUT: E, the sign and two digits of the exponent D (-99 to 99) to U on
EXPOUT  PSHS    A
        LDA     #'E'
        STA     ,U+
        LDA     #'+'
        TST     ,S+
        BPL     EXO1
        LDA     #'-'
        NEGB
EXO1    STA     ,U+
        LDA     #'0'-1
EXO2    INCA
        SUBB    #10
        BHS     EXO2
        ADDB    #'0'+10
        STD     ,U++
        RTS


* ---------------- FIN: text to a number ----------------
* FIN: the number at the text pointer (CHRGOT's character first) into FAC: an optional sign, digits with
* an optional point, an optional exponent E[+|-]digits; spaces between are skipped (CHRGET). The digits are
* kept exactly while they fit in 32 bits; the first that does not rounds, and later ones only count as places. Leaves the text pointer on the first character
* after the number.
FIN     CLR     <FPDP
        CLR     <FPDROP
        CLRA
        CLRB
        STD     <FPE10
        STD     <FPN
        STD     <FPN+2
        JSR     <ZCHRGOT
        BSR     FISGN
        STB     <FPSGNI         ; (the carry is still CHRGET's: a digit)
FI1     BCS     FIDIG
        CMPA    #'.'
        BNE     FI3
        TST     <FPDP
        LBNE    FIEND
        COM     <FPDP
        JSR     <ZCHRGET
        BRA     FI1
FIDIG   SUBA    #'0'
        TST     <FPDROP
        BNE     FIIGN
        LDX     <FPN            ; room for another digit within 32 bits: below 429496729 ($19999999), or
        CMPX    #$1999          ; equal to it with a digit up to 5
        BHI     FIDRP
        BLO     FID1
        LDX     <FPN+2
        CMPX    #$9999
        BLO     FID1
        BHI     FIDRP
        CMPA    #5
        BHI     FIDRP
FID1    JSR     FPNX10          ; x 10 + the digit
        TST     <FPDP
        BEQ     FINX
        JSR     E10DEC
        BRA     FINX
FIDRP   COM     <FPDROP         ; the first digit that does not fit rounds
        CMPA    #5
        BLO     FIIGN
        LDD     <FPN+2
        ADDD    #1
        STD     <FPN+2
        BCC     FIIGN
        LDD     <FPN
        ADDD    #1
        BCS     FIUND           ; (it was $FFFFFFFF: left as it was)
        STD     <FPN
        BRA     FIIGN
FIUND   LDD     #$FFFF
        STD     <FPN+2
FIIGN   TST     <FPDP           ; a digit not kept is still a place before the point
        BNE     FINX
        JSR     E10INC
FINX    JSR     <ZCHRGET
        BRA     FI1
* FISGN: a sign at A (the character at the text pointer)? It is taken. B = $FF for a minus, 0 otherwise; A and the
* flags are the next character's (CHRGET's) after a sign, the same one's (CHRGOT's) without
FISGN   CLRB
        CMPA    #'-'
        BEQ     FISM
        CMPA    #T_MINUS
        BNE     FISP
FISM    COMB
        BRA     FISN
FISP    CMPA    #'+'
        BEQ     FISN
        CMPA    #T_PLUS
        BNE     FISG
FISN    JMP     <ZCHRGET
FISG    JMP     <ZCHRGOT
* the exponent
FI3     CMPA    #'E'
        BNE     FIEND
        CLR     <FPEX
        JSR     <ZCHRGET
        BSR     FISGN
        STB     <FPEXS
FIE4    BCC     FIE6
        SUBA    #'0'            ; x 10 + the digit, in a byte that wraps: "1E997" is 1E-27, no ?OV ERROR
        PSHS    A               ; [BB bb2 str-val-cut]
        LDA     <FPEX
        LDB     #10
        MUL
        ADDB    ,S+
        STB     <FPEX
        JSR     <ZCHRGET
        BRA     FIE4
FIE6    LDB     <FPEX           ; a signed byte
        SEX
        TST     <FPEXS
        BEQ     FIE7
        JSR     NEGD
FIE7    ADDD    <FPE10
        STD     <FPE10
* the integer, then the places
FIEND   LDD     <FPN
        STD     <FACM
        LDD     <FPN+2
        STD     <FACM+2
        JSR     I32FLT
FIE8    LDD     <FPE10          ; steps of 1E9, then one product or quotient by 10^k
        CMPD    #9
        BLT     FIE9
        SUBD    #9
        STD     <FPE10
        LDB     #9
        JSR     FMULP
        BRA     FIE8
FIE9    CMPD    #-9
        BGT     FIE9A
        ADDD    #9
        STD     <FPE10
        LDB     #9
        JSR     FDIVP
        BRA     FIE8
FIE9A   TSTB
        BEQ     FIE10
        BMI     FIE9B
        JSR     FMULP
        BRA     FIE10
FIE9B   NEGB
        JSR     FDIVP
FIE10   LDA     <FPSGNI
        STA     <FACSGN
        TST     <FACEXP
        BNE     FIE11
        CLR     <FACSGN
FIE11   JMP     <ZCHRGOT

* FPNX10: FPN = FPN x 10 + A (32 bits), a byte at a time from the last, the carry on the stack
FPNX10  LDX     #FPN+4
        PSHS    A
FPX1    LDA     ,-X
        LDB     #10
        MUL
        ADDB    ,S
        ADCA    #0
        STB     ,X
        STA     ,S
        CMPX    #FPN
        BNE     FPX1
        PULS    A,PC
