* ---------------- numeric functions ----------------
* Our own approximations [OWN]: arguments reduced (SIN and COS by Cody and Waite: the multiple of pi/2 taken off in
* two parts; LOG and EXP in base 2, as the original's low digits show [BB bb2 fn-sqr-bits]), then Taylor series
* evaluated by Horner's rule; the constants come from tools/basic-consts.js.
* tests/basic-math.test.js checks them against exact values over many arguments.

        INCLUDE "mathconst.inc"
FPM1    FCB     $81,$80,$00,$00,$00     ; -1
* (FPM1, FPHALF and POWTAB follow FPCON's block: tests/basic-fp.test.js checks each against exact values)
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

FPONE   EQU     POWTAB          ; 1

* FNARGN: ( numeric expression )
FNARGN  JSR     LPAREN
        JSR     <ZEVNUM
        JMP     RPAREN
* FMULX, FADDX: FAC = [X] x FAC, [X] + FAC, for the packed number at X. FDIVX: [X] / FAC. FSUBX: [X] - FAC.
FMULX   JSR     MOVAM
        JMP     FMUL
FADDX   JSR     MOVAM
        JMP     FADD
FDIVX   JSR     MOVAM
        JMP     FDIV
FSUBX   JSR     MOVAM
        JMP     FSUB
* FPRUN: do the steps that follow the call, a byte each, up to a 0 byte; the code after it then goes on. A step
* is an operation (bits 7-5) on a packed number (bits 4-0): 1-7 are FPT1-FPT6 and POLYV, 8 and up the constants
* from FPCON on. Keeps nothing but the stack.
F_STO   EQU     $20             ; store FAC (rounded)
F_LD    EQU     $40             ; FAC = it
F_MUL   EQU     $60             ; FAC = it x FAC
F_ADD   EQU     $80             ; FAC = it + FAC
F_RDIV  EQU     $A0             ; FAC = FAC / it
F_DIVX  EQU     $C0             ; FAC = it / FAC
F_SUBX  EQU     $E0             ; FAC = it - FAC
K_P2HI  EQU     (PIO2HI-FPCON)/5+8
K_P2LO  EQU     (PIO2LO-FPCON)/5+8
K_2OPI  EQU     (TWOOPI-FPCON)/5+8
K_LN2   EQU     (LN2-FPCON)/5+8
K_ILN2  EQU     (INVLN2-FPCON)/5+8
K_SQR3  EQU     (SQRT3-FPCON)/5+8
K_M1    EQU     (FPM1-FPCON)/5+8
K_HALF  EQU     (FPHALF-FPCON)/5+8
K_ONE   EQU     (FPONE-FPCON)/5+8
FPRUN   PULS    U
FPR1    LDB     ,U+
        BEQ     FPR3
        PSHS    B,U
        ANDB    #$1F
        LDX     #FPT1-5
        CMPB    #8
        BLO     FPR2
        LDX     #FPCON-40
FPR2    LDA     #5
        MUL
        ABX
        PULS    B
        LSRB
        LSRB
        LSRB
        LSRB
        ANDB    #$0E
        LDU     #FPOPS-2
        JSR     [B,U]
        PULS    U
        BRA     FPR1
FPR3    JMP     ,U
FPOPS   FDB     MOVMF,MOVFM,FMULX,FADDX,FDIVR,FDIVX,FSUBX
* GIVUNS: D (unsigned) into FAC, a number
GIVUNS  CLR     <FACSGN
        CLR     <VALTYP
        JMP     GIV1

* POLY: FAC = c0 x^(n-1) + ... + c(n-1) for the variable x in FAC, the B coefficients packed at X (highest first)
* A = the step from one coefficient to the next: 5, or 10 for every other one of the table.
POLY    PSHS    D,X
        LDX     #POLYV
        JSR     MOVMF
        LDX     2,S
        JSR     MOVFM
        DEC     1,S
PL1     LDX     #POLYV
        BSR     FMULX
        LDX     2,S
        LDB     ,S
        ABX
        STX     2,S
        BSR     FADDX
        DEC     1,S
        BNE     PL1
        PULS    D,X,PC
* ODDPOL: FAC = x P(x^2), P as POLY
* (A and B as POLY; bit 7 of A set: P(-x^2))
ODDPOL  PSHS    D,X
        LDX     #FPT4
        JSR     MOVMF
        JSR     FMULX           ; x^2
        PULS    D,X
        TSTA
        BPL     OP1
        ANDA    #$7F
        JSR     FNEG
OP1     BSR     POLY
        LDX     #FPT4
        JMP     FMULX

* FTRUNC: FAC with its fraction dropped (towards 0). FRACNZ: nonzero if a fraction was dropped; TRSGN: the sign.
FTRUNC  JSR     ROUND
        CLR     <FRACNZ
        LDA     <FACSGN
        STA     <TRSGN
        LDA     <FACEXP
        BEQ     FTR9
        CMPA    #160
        BHS     FTR9            ; 2^32 and up: whole already
        CMPA    #129
        BHS     FTR1
        INC     <FRACNZ         ; below 1
        JMP     FZERO
FTR1    LDB     #160
        SUBB    <FACEXP         ; bits to clear, 1-31
        LDX     #FACM+3
FTR2    CMPB    #8
        BLO     FTR3
        TST     ,X
        BEQ     FTR2A
        INC     <FRACNZ
FTR2A   CLR     ,X
        LEAX    -1,X
        SUBB    #8
        BRA     FTR2
FTR3    TSTB
        BEQ     FTR9
        LDA     #$FF            ; the mask of the B low bits
FTR4    LSLA
        DECB
        BNE     FTR4
        PSHS    A
        COMA
        ANDA    ,X
        BEQ     FTR5
        INC     <FRACNZ
FTR5    PULS    A
        ANDA    ,X
        STA     ,X
FTR9    RTS
* FINT: FAC rounded down (INT)
FINT    BSR     FTRUNC
        TST     <TRSGN
        BPL     FTR9
        TST     <FRACNZ
        BEQ     FTR9
        LDX     #FPM1
        JMP     FADDX

* INT(x), FIX(x), ABS(x), SGN(x)
INT     JSR     <ZFNARGN
        BRA     FINT
FIX     JSR     <ZFNARGN
        BRA     FTRUNC
ABS     JSR     <ZFNARGN
        CLR     <FACSGN
        RTS
SGN     JSR     <ZFNARGN
        CLRA
        CLRB
        TST     <FACEXP
        BEQ     SGN1
        LDD     #1
        TST     <FACSGN
        BPL     SGN1
        LDD     #-1
SGN1    JMP     GIVABF

* SQR(x): x^.5, through ^'s EXP(.5 LOG x) [BB]: the original prints SQR(1E10) as 99999.9999 (bb1, fn-math), so it
* is not a square root rounded once
SQR     JSR     <ZFNARGN
FSQR    JSR     <ZFPRUN
        FCB     F_STO+6,F_LD+K_HALF,F_STO+5,0
        JMP     PW5

* LOG(x): x = m 2^e with m in [sqrt 1/2, sqrt 2); t = (m-1)/(m+1); ln m = 2t (1 + t^2/3 + t^4/5 + ...); then
* (ln m / ln 2 + e) ln 2, each step rounded: base 2, as the original (its SQR(144) is 12 - 3 x 2^-28 and SQR(65536)
* 256 exactly, with EXP's base 2 below) [BB bb2 fn-sqr-bits]
LOG     JSR     <ZFNARGN
FLOG    TST     <FACSGN
        LBMI    FCERR
        TST     <FACEXP
        LBEQ    FCERR
        LDA     <FACEXP
        SUBA    #128
        STA     <LOGE
        LDA     #128
        STA     <FACEXP
        LDX     #SQRHLF
        JSR     FCMPM
        BLE     LOG1
        INC     <FACEXP         ; below sqrt 1/2: m x 2
        DEC     <LOGE
LOG1    JSR     <ZFPRUN           ; m; m + 1; m again; m - 1; t
        FCB     F_STO+1,F_ADD+K_ONE,F_STO+2,F_LD+1,F_ADD+K_M1,F_RDIV+2,0
        LDX     #ODDTAB+10
        LDD     #$0508
        JSR     ODDPOL
        TST     <FACEXP
        BEQ     LOG2
        INC     <FACEXP         ; x 2
LOG2    JSR     <ZFPRUN         ; log2 m; + e; x ln 2
        FCB     F_MUL+K_ILN2,F_STO+3,0
        LDB     <LOGE
        SEX
        JSR     GIVABF
        JSR     <ZFPRUN
        FCB     F_ADD+3,F_MUL+K_LN2,0
        RTS

* EXP(x): t = x / ln 2 (rounded), n = INT(t), r = (t - n) ln 2, e^x = 2^n e^r: base 2, as the original (its
* EXP(11.5129255) is 100000.00344849, the rounding of t showing in the low digits) [BB bb2 fn-sqr-bits]
EXP     JSR     <ZFNARGN
FEXP    LDX     #EXPMAX
        JSR     FCMPM
        LBMI    OVERR           ; above 127 ln 2: ?OV ERROR
        LDX     #EXPMIN
        JSR     FCMPM
        BLE     EXP1
        JMP     FZERO           ; below -129 ln 2: 0
EXP1    JSR     <ZFPRUN           ; t = x / ln 2, kept
        FCB     F_MUL+K_ILN2,F_STO+1,0
        JSR     FINT
        JSR     INTCNV
        PSHS    D               ; n, kept to the end (below -128 when x is near EXPMIN)
        JSR     GIVABF          ; r = (t - n) ln 2
        JSR     <ZFPRUN
        FCB     F_SUBX+1,F_MUL+K_LN2,0
        LDX     #FACTAB+15
        LDD     #$050C
        JSR     POLY
        LDB     <FACEXP         ; x 2^n
        CLRA
        ADDD    ,S++
        LBLE    FZERO
        TSTA
        LBNE    OVERR
        STB     <FACEXP
        RTS

* SIN(x), COS(x): k = the nearest whole number to x / (pi/2), r = x - k pi/2 (|r| <= pi/4); the quarter
* (k, plus 1 for the cosine) picks sin r, cos r, -sin r or -cos r
COS     JSR     <ZFNARGN
FCOS    LDA     #1
        BRA     SIN0
SIN     JSR     <ZFNARGN
FSIN    CLRA
SIN0    STA     <QUAD
        JSR     <ZFPRUN
        FCB     F_STO+1,F_MUL+K_2OPI,F_ADD+K_HALF,0
        JSR     FINT
        JSR     INTCNV          ; (?FC ERROR when |x| is beyond about 51000)
        PSHS    B
        ADDB    <QUAD
        STB     <QUAD
        PULS    B
        JSR     GIVABF          ; the argument reduction, as EXP's
        JSR     <ZFPRUN
        FCB     F_STO+2,F_MUL+K_P2HI,F_SUBX+1,F_STO+1,F_LD+2,F_MUL+K_P2LO,F_SUBX+1,0
        LDA     <QUAD
        BITA    #1
        BNE     SIN1
        LDX     #FACTAB+5
        LDD     #$8A07
        JSR     ODDPOL
        BRA     SIN2
SIN1    JSR     <ZFPRUN
        FCB     F_STO+4,F_MUL+4,0       ; r^2
        JSR     FNEG
        LDX     #FACTAB
        LDD     #$0A08
        JSR     POLY
SIN2    LDA     <QUAD
        BITA    #2
        BEQ     SIN3
        JMP     FNEG
SIN3    RTS
* TAN(x) = SIN(x) / COS(x)
TAN     JSR     <ZFNARGN
FTAN    JSR     <ZFPRUN
        FCB     F_STO+5,0
        BSR     FSIN
        JSR     <ZFPRUN
        FCB     F_STO+6,F_LD+5,0
        BSR     FCOS
        LDX     #FPT6
        JMP     FDIVX

* ATN(x): |x| > 1 uses pi/2 - ATN(1/x); above tan(pi/12) it uses pi/6 + ATN((x sqrt 3 - 1)/(x + sqrt 3));
* then x - x^3/3 + x^5/5 - ...
ATN     JSR     <ZFNARGN
FATN    LDA     <FACSGN
        STA     <ATSGN
        CLR     <FACSGN
        CLR     <ATINV
        CLR     <ATADD
        LDX     #FPONE
        JSR     FCMPM
        BPL     AT1
        INC     <ATINV          ; 1/x
        JSR     FDIV
AT1     LDX     #TANP12
        JSR     FCMPM
        BPL     AT2
        INC     <ATADD
        JSR     <ZFPRUN           ; x; x + sqrt 3; x again; x sqrt 3; - 1; / (x + sqrt 3)
        FCB     F_STO+1,F_ADD+K_SQR3,F_STO+2,F_LD+1,F_MUL+K_SQR3,F_ADD+K_M1,F_RDIV+2,0
AT2     LDX     #ODDTAB
        LDD     #$850A
        JSR     ODDPOL
        TST     <ATADD
        BEQ     AT3
        LDX     #PIO6
        JSR     FADDX
AT3     TST     <ATINV
        BEQ     AT4
        LDX     #PIO2
        JSR     FSUBX           ; pi/2 - it
AT4     TST     <FACEXP
        BEQ     AT5
        LDA     <ATSGN
        STA     <FACSGN
AT5     RTS

* FPOWER: FAC = ARG ^ FAC. A whole exponent (below 32768) by repeated squaring; otherwise EXP(e LOG(base)),
* which needs a base above 0 (?FC ERROR; 0 to a power above 0 is 0)
FPOWER  JSR     <ZFPRUN
        FCB     F_STO+5,0       ; the exponent
        JSR     MOVFA
        JSR     <ZFPRUN
        FCB     F_STO+6,F_LD+5,0        ; the base
        JSR     FTRUNC
        TST     <FRACNZ
        BNE     PW5
        LDA     <FACEXP
        CMPA    #128+15
        BHI     PW5
        JSR     INTCNV
        STA     <PWSGN
        TSTA
        BPL     PW1
        COMA
        COMB
        ADDD    #1
PW1     STD     <PWN
        JSR     <ZFPRUN
        FCB     F_LD+K_ONE,F_STO+1,0    ; the result: 1
PW2     LDD     <PWN
        BEQ     PW4
        LSRA
        RORB
        STD     <PWN
        BCC     PW3
        JSR     <ZFPRUN
        FCB     F_LD+1,F_MUL+6,F_STO+1,0        ; result x base
PW3     LDD     <PWN
        BEQ     PW4
        JSR     <ZFPRUN
        FCB     F_LD+6,F_MUL+6,F_STO+6,0        ; base x base
        BRA     PW2
PW4     LDX     #FPT1
        JSR     MOVFM
        TST     <PWSGN
        BPL     PW9
        LDX     #FPONE          ; a negative exponent: 1 / it
        JMP     FDIVX
PW5     LDX     #FPT6
        JSR     MOVFM
        TST     <FACEXP
        BNE     PW6
        LDX     #FPT5           ; 0 to a power: 0, or ?/0 ERROR below 0
        TST     1,X
        LBMI    DZERR
        JMP     FZERO
PW6     JSR     FLOG
        LDX     #FPT5
        JSR     FMULX
        JMP     FEXP
PW9     RTS

* RND(x): the next number of the generator, seed = seed x 1664525 + 1013904223 (mod 2^32) [OWN]. RND(0) gives it
* as a fraction from 0 to below 1; RND(n) for n of 1 and up a whole number from 1 to n [UM]; a negative argument
* first makes the seed from its bits.
RND     JSR     <ZFNARGN
        TST     <FACSGN
        BPL     RN1
        LDD     <FACM           ; reseed (LSB first)
        STB     <SEED+2
        STA     <SEED+3
        LDD     <FACM+2
        STB     <SEED
        STA     <SEED+1
        CLR     <FACSGN
RN1     LDX     #FPT5
        JSR     MOVMF
        CLR     <RNDR
        CLR     <RNDR+1
        CLR     <RNDR+2
        CLR     <RNDR+3
        CLR     <FPI
RN2     CLR     <FPJ
RN3     LDA     <FPI
        ADDA    <FPJ
        CMPA    #3
        BHI     RN6
        LDX     #SEED
        LDB     <FPI
        LDA     B,X
        LDX     #RNDK
        LDB     <FPJ
        LDB     B,X
        MUL
        PSHS    A
        LDA     <FPI
        ADDA    <FPJ
        LDX     #RNDR
        LEAX    A,X
        PULS    A
        ADDB    ,X
        STB     ,X+
        ADCA    #0
RN4     CMPX    #RNDR+4
        BHS     RN6
        ADDA    ,X
        STA     ,X+
        LDA     #0
        ROLA                    ; the carry on up
        BRA     RN4
RN6     INC     <FPJ
        LDA     <FPJ
        CMPA    #4
        BLO     RN3
        INC     <FPI
        LDA     <FPI
        CMPA    #4
        BLO     RN2
        LDX     #RNDR           ; + 1013904223 ($3C6EF35F), into the seed
        LDY     #RNDC
        LDU     #SEED
        LDB     #4
        ANDCC   #$FE
RN7     LDA     ,X+
        ADCA    ,Y+
        STA     ,U+
        DECB
        BNE     RN7
        LDA     <SEED+3         ; the fraction: seed / 2^32
        LDB     <SEED+2
        STD     <FACM
        LDA     <SEED+1
        LDB     <SEED
        STD     <FACM+2
        CLR     <FACSGN
        CLR     <FACEXT
        LDA     #128
        STA     <FACEXP
        JSR     NORM
        LDX     #FPT5
        TST     ,X
        BEQ     RN9             ; RND(0)
        JSR     FMULX           ; x n, rounded down, + 1
        JSR     FINT
        LDX     #FPONE
        JMP     FADDX
RN9     RTS
RNDK    FCB     $0D,$66,$19,$00 ; 1664525, low byte first
RNDC    FCB     $5F,$F3,$6E,$3C ; 1013904223, low byte first
