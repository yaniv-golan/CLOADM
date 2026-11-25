* ---------------- numeric functions ----------------
* Our own approximations [OWN]: arguments reduced (Cody and Waite: the multiple of pi/2 or ln 2 taken off in two
* parts), then Taylor series evaluated by Horner's rule; the constants come from tools/basic-consts.js.
* tests/basic-math.test.js checks them against exact values over many arguments.

        INCLUDE "mathconst.inc"
FPONE   EQU     POWTAB          ; 1
FPM1    FCB     $81,$80,$00,$00,$00     ; -1


* FNARGN: ( numeric expression )
FNARGN  JSR     LPAREN
        JSR     EVNUM
        JMP     RPAREN
* FSTX, FLDX: FAC to or from the packed number at X. FMULX, FADDX: FAC = [X] x FAC, [X] + FAC.
FSTX    JMP     MOVMF
FLDX    JMP     MOVFM
FMULX   JSR     MOVAM
        JMP     FMUL
FADDX   JSR     MOVAM
        JMP     FADD
* GIVUNS: D (unsigned) into FAC, a number
GIVUNS  STD     <FACM
        CLR     <FACM+2
        CLR     <FACM+3
        CLR     <FACEXT
        CLR     <FACSGN
        CLR     <VALTYP
        LDA     #128+16
        STA     <FACEXP
        JMP     NORM

* POLY: FAC = c0 x^(n-1) + ... + c(n-1) for the variable x in FAC, the B coefficients packed at X (highest first)
POLY    PSHS    B,X
        LDX     #POLYV
        JSR     MOVMF
        PULS    B,X
        JSR     MOVFM
        DECB
PL1     PSHS    B,X
        LDX     #POLYV
        JSR     FMULX
        PULS    B,X
        LEAX    5,X
        PSHS    B,X
        JSR     FADDX
        PULS    B,X
        DECB
        BNE     PL1
        RTS
* ODDPOL: FAC = x P(x^2), P as POLY
ODDPOL  PSHS    B,X
        LDX     #FPT4
        JSR     MOVMF
        JSR     FMULX           ; x^2
        PULS    B,X
        JSR     POLY
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
FINT    JSR     FTRUNC
        TST     <TRSGN
        BPL     FTR9
        TST     <FRACNZ
        BEQ     FTR9
        LDX     #FPM1
        JMP     FADDX

* INT(x), FIX(x), ABS(x), SGN(x)
INT     JSR     FNARGN
        BRA     FINT
FIX     JSR     FNARGN
        BRA     FTRUNC
ABS     JSR     FNARGN
        CLR     <FACSGN
        RTS
SGN     JSR     FNARGN
        LDD     #0
        TST     <FACEXP
        BEQ     SGN1
        LDD     #1
        TST     <FACSGN
        BPL     SGN1
        LDD     #-1
SGN1    JMP     GIVABF

* SQR(x): Newton's iteration, y = (y + x/y)/2, six times from a guess with half the exponent
SQR     JSR     FNARGN
FSQR    TST     <FACEXP
        BEQ     SQ9
        TST     <FACSGN
        LBMI    FCERR
        LDX     #FPT1
        JSR     MOVMF
        LDA     <FACEXP
        SUBA    #128
        ASRA
        ADDA    #128
        STA     <FACEXP
        LDA     #6
        STA     <FPK2
SQ1     LDX     #FPT2
        JSR     MOVMF
        LDX     #FPT1
        JSR     MOVAM
        JSR     FDIV            ; x / y
        LDX     #FPT2
        JSR     FADDX
        DEC     <FACEXP         ; / 2
        DEC     <FPK2
        BNE     SQ1
SQ9     RTS

* LOG(x): x = m 2^e with m in [sqrt 1/2, sqrt 2); t = (m-1)/(m+1); ln m = 2t (1 + t^2/3 + t^4/5 + ...)
LOG     JSR     FNARGN
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
        JSR     MOVAM
        JSR     FCMP
        BLE     LOG1
        INC     <FACEXP         ; below sqrt 1/2: m x 2
        DEC     <LOGE
LOG1     LDX     #FPT1
        JSR     MOVMF           ; m
        LDX     #FPONE
        JSR     FADDX
        LDX     #FPT2
        JSR     MOVMF           ; m + 1
        LDX     #FPT1
        JSR     MOVFM
        LDX     #FPONE
        JSR     MOVAM
        JSR     FSUB
        JSR     FNEG            ; m - 1
        JSR     MOVAF
        LDX     #FPT2
        JSR     MOVFM
        JSR     FDIV            ; t
        LDX     #LOGTAB
        LDB     #8
        JSR     ODDPOL
        TST     <FACEXP
        BEQ     LOG2
        INC     <FACEXP         ; x 2
LOG2     LDX     #FPT3
        JSR     MOVMF
        LDB     <LOGE           ; + e ln 2
        SEX
        JSR     GIVABF
        LDX     #LN2
        JSR     FMULX
        LDX     #FPT3
        JMP     FADDX

* EXP(x): n = the nearest whole number to x / ln 2, r = x - n ln 2 (|r| <= ln 2 / 2), e^x = 2^n e^r
EXP     JSR     FNARGN
FEXP    LDX     #EXPMAX
        JSR     MOVAM
        JSR     FCMP
        LBMI    OVERR           ; above 127 ln 2: ?OV ERROR
        LDX     #EXPMIN
        JSR     MOVAM
        JSR     FCMP
        BLE     EXP1
        JMP     FZERO           ; below -129 ln 2: 0
EXP1     LDX     #FPT1
        JSR     MOVMF           ; x
        LDX     #INVLN2
        JSR     FMULX
        LDX     #FPHALF
        JSR     FADDX
        JSR     FINT
        JSR     INTCNV
        STB     <EXPN
        LDX     #LN2HI
        LDU     #LN2LO
        JSR     REDUCE          ; r
        LDX     #EXPTAB
        LDB     #12
        JSR     POLY
        LDB     <FACEXP         ; x 2^n
        CLRA
        PSHS    D
        LDB     <EXPN
        SEX
        ADDD    ,S++
        LBLE    FZERO
        TSTA
        LBNE    OVERR
        STB     <FACEXP
        RTS
* REDUCE: FAC = FPT1 - n HI - n LO for n = D (X = HI, U = LO): the argument reduction
REDUCE  PSHS    X,U
        JSR     GIVABF
        LDX     #FPT2
        JSR     MOVMF           ; n
        LDX     ,S
        JSR     FMULX           ; n HI (exact)
        LDX     #FPT1
        JSR     MOVAM
        JSR     FSUB            ; x - n HI
        LDX     #FPT1
        JSR     MOVMF
        LDX     #FPT2
        JSR     MOVFM
        LDX     2,S
        JSR     FMULX           ; n LO
        LDX     #FPT1
        JSR     MOVAM
        PULS    X,U
        JMP     FSUB

* SIN(x), COS(x): k = the nearest whole number to x / (pi/2), r = x - k pi/2 (|r| <= pi/4); the quarter
* (k, plus 1 for the cosine) picks sin r, cos r, -sin r or -cos r
COS     JSR     FNARGN
FCOS    LDA     #1
        BRA     SIN0
SIN     JSR     FNARGN
FSIN    CLRA
SIN0     STA     <QUAD
        LDX     #FPT1
        JSR     MOVMF
        LDX     #TWOOPI
        JSR     FMULX
        LDX     #FPHALF
        JSR     FADDX
        JSR     FINT
        JSR     INTCNV          ; (?FC ERROR when |x| is beyond about 51000)
        PSHS    B
        ADDB    <QUAD
        STB     <QUAD
        PULS    B
        LDX     #PIO2HI
        LDU     #PIO2LO
        JSR     REDUCE
        LDA     <QUAD
        BITA    #1
        BNE     SIN1
        LDX     #SINTAB
        LDB     #7
        JSR     ODDPOL
        BRA     SIN2
SIN1     LDX     #FPT4
        JSR     MOVMF
        JSR     FMULX           ; r^2
        LDX     #COSTAB
        LDB     #8
        JSR     POLY
SIN2     LDA     <QUAD
        BITA    #2
        BEQ     SIN3
        JMP     FNEG
SIN3     RTS
* TAN(x) = SIN(x) / COS(x)
TAN     JSR     FNARGN
        LDX     #FPT5
        JSR     MOVMF
        JSR     FSIN
        LDX     #FPT6
        JSR     MOVMF
        LDX     #FPT5
        JSR     MOVFM
        JSR     FCOS
        LDX     #FPT6
        JSR     MOVAM
        JMP     FDIV

* ATN(x): |x| > 1 uses pi/2 - ATN(1/x); above tan(pi/12) it uses pi/6 + ATN((x sqrt 3 - 1)/(x + sqrt 3));
* then x - x^3/3 + x^5/5 - ...
ATN     JSR     FNARGN
FATN    LDA     <FACSGN
        STA     <ATSGN
        CLR     <FACSGN
        CLR     <ATINV
        CLR     <ATADD
        LDX     #FPONE
        JSR     MOVAM
        JSR     FCMP
        BPL     AT1
        INC     <ATINV          ; 1/x
        JSR     FDIV
AT1     LDX     #TANP12
        JSR     MOVAM
        JSR     FCMP
        BPL     AT2
        INC     <ATADD
        LDX     #FPT1
        JSR     MOVMF           ; x
        LDX     #SQRT3
        JSR     FADDX
        LDX     #FPT2
        JSR     MOVMF           ; x + sqrt 3
        LDX     #FPT1
        JSR     MOVFM
        LDX     #SQRT3
        JSR     FMULX
        LDX     #FPONE
        JSR     MOVAM
        JSR     FSUB
        JSR     FNEG            ; x sqrt 3 - 1
        JSR     MOVAF
        LDX     #FPT2
        JSR     MOVFM
        JSR     FDIV
AT2     LDX     #ATNTAB
        LDB     #10
        JSR     ODDPOL
        TST     <ATADD
        BEQ     AT3
        LDX     #PIO6
        JSR     FADDX
AT3     TST     <ATINV
        BEQ     AT4
        LDX     #PIO2
        JSR     MOVAM
        JSR     FSUB            ; pi/2 - it
AT4     TST     <FACEXP
        BEQ     AT5
        LDA     <ATSGN
        STA     <FACSGN
AT5     RTS

* FPOWER: FAC = ARG ^ FAC. A whole exponent (below 32768) by repeated squaring; otherwise EXP(e LOG(base)),
* which needs a base above 0 (?FC ERROR; 0 to a power above 0 is 0)
FPOWER  LDX     #FPT5
        JSR     MOVMF           ; the exponent
        JSR     MOVFA
        LDX     #FPT6
        JSR     MOVMF           ; the base
        LDX     #FPT5
        JSR     MOVFM
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
        LDX     #FPONE
        JSR     MOVFM
        LDX     #FPT1
        JSR     MOVMF           ; the result: 1
PW2     LDD     <PWN
        BEQ     PW4
        LSRA
        RORB
        STD     <PWN
        BCC     PW3
        LDX     #FPT1           ; result x base
        JSR     MOVFM
        LDX     #FPT6
        JSR     FMULX
        LDX     #FPT1
        JSR     MOVMF
PW3     LDD     <PWN
        BEQ     PW4
        LDX     #FPT6           ; base x base
        JSR     MOVFM
        LDX     #FPT6
        JSR     FMULX
        LDX     #FPT6
        JSR     MOVMF
        BRA     PW2
PW4     LDX     #FPT1
        JSR     MOVFM
        TST     <PWSGN
        BPL     PW9
        LDX     #FPONE          ; a negative exponent: 1 / it
        JSR     MOVAM
        JMP     FDIV
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
RND     JSR     FNARGN
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
