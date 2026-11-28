* ---------------- numeric functions ----------------
* Our own approximations [OWN]: arguments reduced (SIN, COS and TAN in turns, LOG and EXP in base 2, as the
* original's low bits show [BB bb10 fn-last-bit, fn-trig-big; bb2 fn-sqr-bits]), then series evaluated by
* Horner's rule; the constants come from tools/basic-consts.js.
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
FNARGN  JSR     <ZLPAREN
        JSR     <ZEVNUM
        JMP     <ZRPAREN
* FMULX, FADDX: FAC = [X] x FAC, [X] + FAC, for the packed number at X. FDIVX: [X] / FAC. FSUBX: [X] - FAC.
* (each is in fp.inc, in front of its operation, which it falls into)
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
K_2PI   EQU     (TWOPI-FPCON)/5+8
K_QTR   EQU     (QUARTR-FPCON)/5+8
K_LN2   EQU     (LN2-FPCON)/5+8
K_ILN2  EQU     (INVLN2-FPCON)/5+8
K_SQR3  EQU     (SQRT3-FPCON)/5+8
K_SQRH  EQU     (SQRHLF-FPCON)/5+8
K_SQR2  EQU     (SQRT2-FPCON)/5+8
K_PIO2  EQU     (PIO2-FPCON)/5+8
K_PIO6  EQU     (PIO6-FPCON)/5+8
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
        JSR     <ZFPRUN
        FCB     F_STO+7,0       ; POLYV
        LDX     2,S
        JSR     MOVFM
        DEC     1,S
PL1     JSR     <ZFPRUN
        FCB     F_MUL+7,0
        LDX     2,S
        LDB     ,S
        ABX
        STX     2,S
        JSR     FADDX
        DEC     1,S
        BNE     PL1
        PULS    D,X,PC
* ODDPOL: FAC = x P(x^2), P as POLY
* (A and B as POLY; bit 7 of A set: P(-x^2))
ODDPOL  PSHS    D,X
        JSR     <ZFPRUN
        FCB     F_STO+4,F_MUL+4,0       ; x kept; x^2
        PULS    D,X
        TSTA
        BPL     OP1
        ANDA    #$7F
        JSR     FNEG
OP1     BSR     POLY
        JSR     <ZFPRUN
        FCB     F_MUL+4,0
        RTS

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
        INC     <FRACNZ         ; below 1: 0, after a wait as the original's [BB bb10 time-int: INT(.5)]
        LDA     #INTB1
        BSR     FTRW
        JMP     FZERO
FTR1    LDB     #160
        SUBB    <FACEXP         ; bits to clear, 1-31: a wait of 23 cycles each, as the original's INT takes [BB
        TFR     B,A             ; bb10 time-int: INT of 3.5, 1000.5, 1E6+.5 and 1E9+.5]
        BSR     FTRW
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
INTB1   EQU     19
RNDDLY  EQU     25
* FTRW: a wait of A x 19 cycles (A not 0). Keeps B.
FTRW    PSHS    D
        PULS    D
        DECA
        BNE     FTRW
        RTS
* FINT: FAC rounded down (INT)
FINT    BSR     FTRUNC
        TST     <TRSGN
        BPL     FTR9
        TST     <FRACNZ
        BEQ     FTR9
        LDX     #FPM1
        JMP     FADDX

* INT(x), FIX(x), SGN(x) (ABS(x) is at this file's end)
FIX     JSR     <ZFNARGN
        BRA     FTRUNC
SGN     CLRA
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
FSQR    JSR     <ZFPRUN
        FCB     F_STO+6,F_LD+K_HALF,F_STO+5,F_LD+6,0
        JMP     PW5

* LOG(x): x = m 2^e with m in [1/2, 1); t = 1 - sqrt 2 / (m + sqrt 1/2); log2 m = t P(t^2) - 1/2 (LOGSER, four
* terms); then (log2 m + e) ln 2, each step rounded: base 2, as the original (its SQR(144) is 12 - 3 x 2^-28 and
* SQR(65536) 256 exactly, with EXP's base 2 below) [BB bb2 fn-sqr-bits]; the reduction's - 1/2 cancels near 1, as
* the original's (its LOG(1.1) is 27 units from the nearest, and LOG(.5) and LOG(2) one unit either side of ln 2) [BB
* bb10 fn-last-bit]. Worked as 1/2 - t P, less e, x ln 2, negated: the same bits.
FLOG    TST     <FACSGN
        LBMI    FCERR
        LDA     <FACEXP
        LBEQ    FCERR
        SUBA    #128
        STA     <LOGE
        LDA     #128
        STA     <FACEXP
        JSR     <ZFPRUN         ; m; + sqrt 1/2; sqrt 2 over that; 1 - that: t
        FCB     F_ADD+K_SQRH,F_DIVX+K_SQR2,F_SUBX+K_ONE,0
        LDX     #LOGSER
        LDD     #$0504
        JSR     ODDPOL          ; t P(t^2)
        JSR     <ZFPRUN
        FCB     F_SUBX+K_HALF,F_STO+3,0 ; 1/2 - t P: - log2 m
        LDB     <LOGE
        SEX
        JSR     GIVABF
        JSR     <ZFPRUN
        FCB     F_SUBX+3,F_MUL+K_LN2,0  ; - log2 m - e, x ln 2
        JMP     FNEG

* EXP(x): t = x / ln 2 (rounded), n = INT(t), r = (t - n) ln 2, e^x = 2^n e^r: base 2, as the original (its
* EXP(11.5129255) is 100000.00344849, the rounding of t showing in the low digits) [BB bb2 fn-sqr-bits]
FEXP    LDX     #EXPMAX
        JSR     FCMPM
        LBMI    OVERR           ; above 127 ln 2: ?OV ERROR
        LDX     #EXPMIN
        JSR     FCMPM
        LBGT    FZERO           ; below -129 ln 2: 0
EXP1    JSR     <ZFPRUN           ; t = x / ln 2, kept
        FCB     F_MUL+K_ILN2,F_STO+1,0
        JSR     FINT
        JSR     INTCNV
        PSHS    D               ; n, kept to the end (below -128 when x is near EXPMIN)
        JSR     GIVABF          ; r = (t - n) ln 2
        JSR     <ZFPRUN
        FCB     F_SUBX+1,F_MUL+K_LN2,0
        LDX     #FACTAB
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

* SIN(x) in turns, as the original [BB bb10 fn-last-bit: every SIN, COS and TAN bit for bit; fn-trig-big]:
* f = x / 2 pi less its INT (from 2^32 turns on f is 0: SIN(1E10) is 0; at 1E9 a sixteenth of a turn,
* SIN(1E9) .707106781), then folded to v (half turns, from -1/2 to 1/2, sin(pi v) = sin(2 pi f)) by the steps
* g = 2f, or 2f - 1 with the sign changed from 1 on, |1/2 - g|, 1/2 less that (each rounded: SIN(.001) is 82
* units below the nearest, as v rounded at 1/2 - g's place gives); then v x the series in v^2 (SINSER). COS(x) is
* SIN(x + pi/2), x + pi/2 rounded (COS(1E9) .923879533, COS(-1E9) .707106781). TAN(x) is SIN(x) over the sine of
* 1/4 - f turns (1 more when that is below 0): the same f, not COS(x) (TAN(1E9) is 1; TAN(100) 35 units off SIN(100)
* / COS(100))
FCOS    JSR     <ZFPRUN
        FCB     F_ADD+K_PIO2,0
FSIN    BSR     SINRED
* SINF: the sine of f turns, f in FAC from 0 to below 1
SINF    TST     <FACEXP         ; g = 2f
        BEQ     SF1
        INC     <FACEXP
SF1     LDX     #FPONE
        JSR     FCMPM
        STA     <QUAD           ; 1 below 1; 0 or $FF from 1 on: the sign changed
        BGT     SF2
        JSR     <ZFPRUN         ; g - 1 (as 2 - 2f, the sign aside)
        FCB     F_ADD+K_M1,0
SF2     JSR     <ZFPRUN
        FCB     F_SUBX+K_HALF,0
        CLR     <FACSGN
        JSR     <ZFPRUN
        FCB     F_SUBX+K_HALF,0
        LDX     #SINSER
        LDD     #$0506
        JSR     ODDPOL
        DEC     <QUAD
        LBNE    FNEG
        RTS
* SINRED: FAC = x / 2 pi less its INT, from 0 to below 1
SINRED  JSR     <ZFPRUN
        FCB     F_RDIV+K_2PI,F_STO+1,0
        JSR     FINT
        JSR     <ZFPRUN
        FCB     F_SUBX+1,F_STO+5,0      ; (kept for TAN)
        RTS
FTAN    BSR     SINRED
        BSR     SINF
        JSR     <ZFPRUN         ; the sine kept; 1/4 - f
        FCB     F_STO+6,F_LD+5,F_SUBX+K_QTR,0
        TST     <FACSGN
        BPL     FTN1
        JSR     <ZFPRUN
        FCB     F_ADD+K_ONE,0
FTN1    BSR     SINF
        JSR     <ZFPRUN
        FCB     F_DIVX+6,0
        RTS

* ATN(x): |x| > 1 uses pi/2 - ATN(1/x); above tan(pi/12) it uses pi/6 + ATN((x sqrt 3 - 1)/(x + sqrt 3));
* then x - x^3/3 + x^5/5 - ...
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
        JSR     <ZFPRUN
        FCB     F_ADD+K_PIO6,0
AT3     TST     <ATINV
        BEQ     AT4
        JSR     <ZFPRUN
        FCB     F_SUBX+K_PIO2,0 ; pi/2 - it
AT4     TST     <FACEXP
        BEQ     AT5
        LDA     <ATSGN
        STA     <FACSGN
AT5     RTS

* FPOWER: FAC = ARG ^ FAC, always EXP(e LOG |base|), as the original's: its 2^2 is 4 and a unit, 2^-1 just under
* .5, 2^66 44 units over, while 2^30 and 2^60 come out exact [BB bb13c fn-log-pow, bb10 num-print-big]. A base
* below 0 takes a whole exponent (else ?FC ERROR) and gives the result's sign by its parity ((-2)^3 is -8 and a
* unit there; a whole exponent of 32768 or more is taken as even [OWN]); a base of 0 gives 1 to the power 0, ?/0
* ERROR below 0, else 0 [BB bb13c].
FPOWER  JSR     <ZFPRUN
        FCB     F_STO+5,0       ; the exponent
        JSR     MOVFA
        JSR     <ZFPRUN
        FCB     F_STO+6,0       ; the base
PW5     CLR     <PWSGN          ; (SQR: FPT5 .5, FPT6 and FAC the number)
        TST     <FACEXP
        BNE     PW1
        LDX     #FPT5           ; 0 to a power: 1 to 0, ?/0 ERROR below 0, else 0
        LDA     ,X
        BEQ     PW0
        TST     1,X
        LBMI    DZERR
        JMP     FZERO
PW0     JSR     <ZFPRUN
        FCB     F_LD+K_ONE,0
        RTS
PW1     TST     <FACSGN
        BPL     PW6
        JSR     <ZFPRUN         ; below 0: the exponent whole, its parity the sign
        FCB     F_LD+5,0
        JSR     FTRUNC
        TST     <FRACNZ
        LBNE    FCERR
        LDA     <FACEXP
        CMPA    #128+15
        BHI     PW2
        JSR     INTCNV
        ANDB    #1
        STB     <PWSGN
PW2     JSR     <ZFPRUN
        FCB     F_LD+6,0
        CLR     <FACSGN
PW6     JSR     FLOG
        JSR     <ZFPRUN
        FCB     F_MUL+5,0
        JSR     FEXP
        TST     <PWSGN
        BEQ     PW9
        JMP     FNEG
PW9     RTS

* RND(x): the next number of the generator, seed = seed x $40E64DAB + $05B0658B (mod 2^32), the original's sequence
* [BB bb8 rnd-seq: inferred from its values, docs/clean-room-basic.md section 5]. RND(0) gives the new seed as a
* fraction from 0 to below 1, the product's bits 40-47 its guard byte (rounded when stored); a negative argument
* makes the seed its mantissa's four bytes, then gives what RND(0) gives [BB]; an exponent byte of 0 is 0 whatever
* its sign bit [BB bb9 rnd-neg]. RND(n) for n above 0 takes one step and gives INT(f x INT(n) + 1), f the fraction
* rounded, the product rounded before the 1 is added, the sum rounded before INT: RND(1.5) is 1 where f x 1.5 is
* 1.2, RND(1) is 2 where f is 1 - 2^-32 [BB bb9 rnd-args].
RNDF    TST     <FACEXP         ; (RNDF: RND of FAC)
        BEQ     RN1             ; 0, whatever its sign [BB bb9 rnd-neg]
        TST     <FACSGN
        BPL     RN1
        LDD     <FACM           ; reseed
        STD     SEED
        LDD     <FACM+2
        STD     SEED+2
        CLR     <FACEXP         ; then as RND(0) [BB bb8 rnd-seq]
RN1     LDB     #RNDDLY         ; RND's wait [BB bb9 rnd-timing]
RNW     DECB
        BNE     RNW
        JSR     <ZFPRUN
        FCB     F_STO+5,0
        LDD     SEED            ; seed x $40E64DAB: FMUL's 64-bit product
        STD     <FACM
        LDD     SEED+2
        STD     <FACM+2
        LDD     #$40E6
        STD     <ARGM
        LDD     #$4DAB
        STD     <ARGM+2
        JSR     MULMAN
        LDD     <PROD+6         ; its low 32 bits + $05B0658B: the seed, and the fraction's mantissa
        ADDD    #$658B
        STD     SEED+2
        STD     <FACM+2
        LDD     <PROD+4
        ADCB    #$B0
        ADCA    #$05
        STD     SEED
        STD     <FACM
        LDA     <PROD+2         ; the guard byte
        STA     <FACEXT
        CLR     <FACSGN
        LDA     #128
        STA     <FACEXP
        JSR     NORM
        LDX     #FPT5
        TST     ,X
        BEQ     RN9             ; RND(0)
        JSR     <ZFPRUN         ; f, rounded; n
        FCB     F_STO+4,F_LD+5,0
        JSR     FTRUNC          ; INT(n)
        JSR     <ZFPRUN         ; x f (f the right operand: the product's time hangs on its bits, as the original's
        FCB     F_STO+5,F_LD+4,F_MUL+5,F_ADD+K_ONE,0     ; [BB bb9 rnd-timing]), + 1
        JMP     FTRUNC
RN9     RTS

* FZERO: FAC = 0 (fp.inc's; here so that a routine starts at $A000: docs/clean-room-basic.md section 3)
FZERO   CLR     <FACEXP
        CLR     <FACSGN
        CLR     <FACEXT
        RTS

* MOVFM: FAC = the packed number at X. Keep X; use D. (fp.inc's, beside MOVAM; here so that a routine starts at
* $A000: docs/clean-room-basic.md section 3)
MOVFM   LDD     ,X
        STA     <FACEXP         ; the exponent
        SEX
        STA     <FACSGN         ; the sign: bit 7 of the first mantissa byte
        ORB     #$80
        STB     <FACM
        LDD     2,X
        STD     <FACM+1
        LDA     4,X
        STA     <FACM+3
        CLR     <FACEXT         ; the guard byte
        RTS

* E10INC, E10DEC: FPE10 + 1, - 1. E10ADJ: FPE10 + B (signed). The new value is in D too.
* (fpconv.inc's; here so that a routine starts at $A000: docs/clean-room-basic.md section 3)
E10INC  LDB     #1
        FCB     $8C             ; (CMPX #: skips the LDB)
E10DEC  LDB     #-1
E10ADJ  SEX
        ADDD    <FPE10
        STD     <FPE10
        RTS

* ABS(x)
ABS     CLR     <FACSGN
        RTS
