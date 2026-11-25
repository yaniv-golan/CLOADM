* ---------------- numbers to and from text, and integers ----------------

* constants (packed; tests/basic-fp.test.js checks each against exact values)
FPHALF  FCB     $80,$00,$00,$00,$00     ; 0.5
* POWTAB: 10^0 to 10^17, rounded to nearest (exact up to 10^13)
POWTAB  FCB     $81,$00,$00,$00,$00
FPTEN   FCB     $84,$20,$00,$00,$00
        FCB     $87,$48,$00,$00,$00
        FCB     $8A,$7A,$00,$00,$00
        FCB     $8E,$1C,$40,$00,$00
        FCB     $91,$43,$50,$00,$00
        FCB     $94,$74,$24,$00,$00
        FCB     $98,$18,$96,$80,$00
FP1E8   FCB     $9B,$3E,$BC,$20,$00
FP1E9   FCB     $9E,$6E,$6B,$28,$00
        FCB     $A2,$15,$02,$F9,$00
        FCB     $A5,$3A,$43,$B7,$40
        FCB     $A8,$68,$D4,$A5,$10
        FCB     $AC,$11,$84,$E7,$2A
        FCB     $AF,$35,$E6,$20,$F5
        FCB     $B2,$63,$5F,$A9,$32
        FCB     $B6,$0E,$1B,$C9,$BF
        FCB     $B9,$31,$A2,$BC,$2F

* POWX: X = the address of 10^B in POWTAB. Keeps B.
POWX    PSHS    B
        LDA     #5
        MUL
        LDX     #POWTAB
        LEAX    D,X
        PULS    B,PC
* FCMPP: compare 10^B with FAC (A and the flags as FCMP: > 0 when FAC is below it)
FCMPP   BSR     POWX
        JSR     MOVAM
        JMP     FCMP
* FMULP: FAC = FAC x 10^B. FDIVP: FAC = FAC / 10^B.
FMULP   BSR     POWX
        JSR     MOVAM
        JMP     FMUL
FDIVP   PSHS    B
        JSR     MOVAF
        PULS    B
        BSR     POWX
        JSR     MOVFM
        JMP     FDIV
* FPE10 + FPK, FPE10 - FPK
E10ADD  LDB     <FPK
        CLRA
        ADDD    <FPE10
        STD     <FPE10
        RTS
E10SUB  LDD     <FPE10
        SUBB    <FPK
        SBCA    #0
        STD     <FPE10
        RTS

* I32FLT: FAC = the unsigned 32-bit integer in FACM, positive
I32FLT  CLR     <FACEXT
        CLR     <FACSGN
        LDA     #128+32
        STA     <FACEXP
        JMP     NORM

* GIVABF: FAC = D, a signed 16-bit integer
GIVABF  CLR     <FACSGN
        TSTA
        BPL     GIV1
        COM     <FACSGN
        COMA
        COMB
        ADDD    #1
GIV1    STD     <FACM
        CLR     <FACM+2
        CLR     <FACM+3
        CLR     <FACEXT
        LDA     #128+16
        STA     <FACEXP
        JMP     NORM

* QINT: FACM = the integer part of |FAC| (truncated), for |FAC| below 2^32. Keeps the sign.
QINT    JSR     ROUND
        LDB     #128+32
        SUBB    <FACEXP         ; places to shift right
        BLS     QI3             ; (not reached: |FAC| >= 2^32)
        CMPB    #32
        BLO     QI1
        CLR     <FACM           ; below 1: 0
        CLR     <FACM+1
        CLR     <FACM+2
        CLR     <FACM+3
        RTS
QI1     CMPB    #8
        BLO     QI2
        LDA     <FACM+2
        STA     <FACM+3
        LDA     <FACM+1
        STA     <FACM+2
        LDA     <FACM
        STA     <FACM+1
        CLR     <FACM
        SUBB    #8
        BRA     QI1
QI2     TSTB
        BEQ     QI3
        LSR     <FACM
        ROR     <FACM+1
        ROR     <FACM+2
        ROR     <FACM+3
        DECB
        BRA     QI2
QI3     RTS

* MUL10: FAC = FAC x 10. DIV10: FAC = FAC / 10.
MUL10   LDX     #FPTEN
        JSR     MOVAM
        JMP     FMUL
DIV10   JSR     MOVAF
        LDX     #FPTEN
        JSR     MOVFM
        JMP     FDIV

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
        CLR     ,U
        LDX     #FBUFFR
        RTS
FO2     LDD     #0
        STD     <FPE10
* scale FAC into [1E8, 1E9) with as few roundings as possible: steps of 1E9 while far, then one product or
* quotient by an exact power of ten, then single steps if rounding left it a place out
        LDB     #9
        JSR     FCMPP
        BGT     FOU0            ; below 1E9
FOD1    LDB     #17             ; 1E17 and up: / 1E9
        JSR     FCMPP
        BGT     FOD2
        LDB     #9
        STB     <FPK
        JSR     FDIVP
        JSR     E10ADD
        BRA     FOD1
FOD2    LDB     #9
        JSR     FCMPP
        BGT     FOFIX
        LDB     #1              ; the smallest j with FAC < 10^(9+j)
        STB     <FPK
FOD3    LDB     <FPK
        CMPB    #8
        BHS     FOD4
        ADDB    #9
        JSR     FCMPP
        BGT     FOD4
        INC     <FPK
        BRA     FOD3
FOD4    LDB     <FPK
        JSR     FDIVP
        JSR     E10ADD
        BRA     FOFIX
FOU0    LDB     #8
        JSR     FCMPP
        BLE     FOFIX           ; already in range
FOU1    CLRB                    ; below 1: x 1E9
        JSR     FCMPP
        BLE     FOU2
        LDB     #9
        STB     <FPK
        JSR     FMULP
        JSR     E10SUB
        BRA     FOU1
FOU2    LDB     #8
        JSR     FCMPP
        BLE     FOFIX
        LDB     #1              ; the smallest j with FAC >= 10^(8-j)
        STB     <FPK
FOU3    LDB     <FPK
        CMPB    #8
        BHS     FOU4
        LDB     #8
        SUBB    <FPK
        JSR     FCMPP
        BLE     FOU4
        INC     <FPK
        BRA     FOU3
FOU4    LDB     <FPK
        JSR     FMULP
        JSR     E10SUB
FOFIX
FO3     LDX     #FP1E8          ; while FAC < 1E8: x 10
        JSR     MOVAM
        JSR     FCMP
        BLE     FO4
        JSR     MUL10
        LDD     <FPE10
        SUBD    #1
        STD     <FPE10
        BRA     FO3
FO4     LDX     #FP1E9          ; while FAC >= 1E9: / 10
        JSR     MOVAM
        JSR     FCMP
        BGT     FO5
        JSR     DIV10
        LDD     <FPE10
        ADDD    #1
        STD     <FPE10
        BRA     FO4
FO5     LDX     #FPHALF         ; + 0.5, and the integer part: nine digits
        JSR     MOVAM
        JSR     FADD
        JSR     QINT
        LDD     <FACM           ; 1000000000 = $3B9ACA00: back to 100000000, one more place
        CMPD    #$3B9A
        BLO     FO6
        BHI     FO5A
        LDD     <FACM+2
        CMPD    #$CA00
        BLO     FO6
FO5A    LDD     #$05F5
        STD     <FACM
        LDD     #$E100
        STD     <FACM+2
        LDD     <FPE10
        ADDD    #1
        STD     <FPE10
* the nine digits into FPDIG
FO6     LDX     #POW10
        LDY     #FPDIG
FO7     LDA     #'0'-1
FO8     INCA                    ; subtract the power of ten until it goes below 0
        PSHS    A
        LDD     <FACM+2
        SUBD    2,X
        PSHS    D
        LDD     <FACM
        SBCB    1,X
        SBCA    ,X
        BLO     FO9
        STD     <FACM
        PULS    D
        STD     <FACM+2
        PULS    A
        BRA     FO8
FO9     LEAS    2,S
        PULS    A
        STA     ,Y+
        LEAX    4,X
        CMPY    #FPDIG+9
        BLO     FO7
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
        STB     <FPCNT
FOI1    LDA     ,X+
        STA     ,U+
        DEC     <FPCNT
        BNE     FOI1
        LDB     <FPE10+1
        INCB
        CMPB    <FPND
        BHS     FOEND           ; nothing after the point
        LDA     #'.'
        STA     ,U+
        LDA     <FPND
        SUBA    <FPE10+1
        DECA
        STA     <FPCNT
FOI2    LDA     ,X+
        STA     ,U+
        DEC     <FPCNT
        BNE     FOI2
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
FOF3    LDA     ,X+
        STA     ,U+
        DECB
        BNE     FOF3
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
FOS1    LDA     ,X+
        STA     ,U+
        DECB
        BNE     FOS1
FOS2    LDA     #'E'
        STA     ,U+
        LDA     #'+'
        LDB     <FPE10+1
        TST     <FPE10
        BPL     FOS3
        LDA     #'-'
        NEGB
FOS3    STA     ,U+
        LDA     #'0'-1
FOS4    INCA
        SUBB    #10
        BHS     FOS4
        ADDB    #'0'+10
        STA     ,U+
        STB     ,U+
FOEND   CLR     ,U
        LDX     #FBUFFR
        RTS

POW10   FDB     $05F5,$E100     ; 100000000
        FDB     $0098,$9680     ; 10000000
        FDB     $000F,$4240     ; 1000000
        FDB     $0001,$86A0     ; 100000
        FDB     $0000,$2710     ; 10000
        FDB     $0000,$03E8     ; 1000
        FDB     $0000,$0064     ; 100
        FDB     $0000,$000A     ; 10
        FDB     $0000,$0001     ; 1

* ---------------- FIN: text to a number ----------------
* FIN: the number at the text pointer (CHRGOT's character first) into FAC: an optional sign, digits with
* an optional point, an optional exponent E[+|-]digits; spaces between are skipped (CHRGET). The digits are
* kept exactly while they fit in 32 bits; the first that does not rounds, and later ones only count as places. Leaves the text pointer on the first character
* after the number.
FIN     CLR     <FPSGNI
        CLR     <FPDP
        CLR     <FPDROP
        LDD     #0
        STD     <FPE10
        STD     <FPN
        STD     <FPN+2
        JSR     CHRGOT
        CMPA    #'-'
        BEQ     FIM
        CMPA    #T_MINUS
        BNE     FIP
FIM     COM     <FPSGNI
        BRA     FIS
FIP     CMPA    #'+'
        BEQ     FIS
        CMPA    #T_PLUS
        BNE     FI0
FIS     JSR     CHRGET
        BRA     FI1
FI0     JSR     CHRGOT
FI1     BCS     FIDIG
        CMPA    #'.'
        LBNE    FI3
        TST     <FPDP
        LBNE    FIEND
        COM     <FPDP
        JSR     CHRGET
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
FID1    PSHS    A
        JSR     FPNX10
        PULS    B
        CLRA
        ADDD    <FPN+2
        STD     <FPN+2
        LDD     <FPN
        ADCB    #0
        ADCA    #0
        STD     <FPN
        TST     <FPDP
        BEQ     FINX
        LDD     <FPE10          ; a digit after the point: one place down
        SUBD    #1
        STD     <FPE10
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
        LDD     <FPE10
        ADDD    #1
        STD     <FPE10
FINX    JSR     CHRGET
        LBRA    FI1
* the exponent
FI3     CMPA    #'E'
        BNE     FIEND
        CLR     <FPEXS
        LDD     #0
        STD     <FPEX
        JSR     CHRGET
        CMPA    #'-'
        BEQ     FIE1
        CMPA    #T_MINUS
        BNE     FIE2
FIE1    COM     <FPEXS
        BRA     FIE3
FIE2    CMPA    #'+'
        BEQ     FIE3
        CMPA    #T_PLUS
        BEQ     FIE3
        JSR     CHRGOT
        BRA     FIE4
FIE3    JSR     CHRGET
FIE4    BCC     FIE6
        SUBA    #'0'
        PSHS    A
        LDD     <FPEX
        CMPD    #1000
        BHS     FIE5            ; large enough already
        LSLB                    ; x 10
        ROLA
        PSHS    D
        LSLB
        ROLA
        LSLB
        ROLA
        ADDD    ,S++
        ADDB    ,S
        ADCA    #0
        STD     <FPEX
FIE5    LEAS    1,S
        JSR     CHRGET
        BRA     FIE4
FIE6    LDD     <FPEX
        TST     <FPEXS
        BEQ     FIE7
        COMA
        COMB
        ADDD    #1
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
FIE11   JMP     CHRGOT

* FPNX10: FPN = FPN x 10 (32 bits)
FPNX10  LDD     <FPN+2
        LSLB
        ROLA
        STD     <FPN+2
        LDD     <FPN
        ROLB
        ROLA
        STD     <FPN            ; x 2
        PSHS    D
        LDD     <FPN+2
        PSHS    D               ; (x 2 saved: low word on top)
        LDB     #2
FPX1    ASL     <FPN+3
        ROL     <FPN+2
        ROL     <FPN+1
        ROL     <FPN
        DECB
        BNE     FPX1            ; x 8
        PULS    D
        ADDD    <FPN+2
        STD     <FPN+2
        PULS    D
        ADCB    <FPN+1
        ADCA    <FPN
        STD     <FPN
        RTS
