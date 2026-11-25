* ---------------- floating point ----------------
* The Microsoft Binary Format [MBF]: 5 bytes, an exponent byte (excess 128; 0 means the number is 0) and a 32-bit
* mantissa, most significant byte first, whose top bit (always 1) is stored as the sign.
* Two unpacked accumulators in the direct page, FAC and ARG: the exponent, the mantissa with its top bit
* explicit, a guard byte below it (EXT), and the sign ($00 or $FF). Binary operations take the left operand in
* ARG (always loaded from a packed number, so its guard byte is 0) and the right one in FAC, and leave the result
* in FAC with 8 guard bits. Each operation first rounds FAC (ROUND: up when the guard byte is $80 or more).
* tests/basic/fpmodel.js is the bit-exact model these routines are tested against.

* MOVFM: FAC = the packed number at X. MOVAM: ARG = it. Keep X.
MOVFM   PSHS    D,U
        LDU     #FACEXP
        BRA     MOV1
MOVAM   PSHS    D,U
        LDU     #ARGEXP
MOV1    LDA     ,X
        STA     ,U              ; the exponent
        LDA     1,X
        ORA     #$80
        STA     1,U
        LDD     2,X
        STD     2,U
        LDA     4,X
        STA     4,U
        CLR     5,U             ; the guard byte
        CLR     6,U             ; the sign
        LDA     1,X
        BPL     MOV2
        COM     6,U
MOV2    PULS    D,U,PC

* ROUND: FAC rounded to 32 bits (?OV ERROR if that carries out of the largest exponent). Keeps X, Y, U.
ROUND   TST     <FACEXP
        BEQ     RND2
        LDA     <FACEXT
        BPL     RND2
        CLR     <FACEXT
        LDD     <FACM+2
        ADDD    #1
        STD     <FACM+2
        LDD     <FACM
        ADCB    #0
        ADCA    #0
        STD     <FACM
        BCC     RND1
        ROR     <FACM           ; it carried out: $80000000 and the next exponent
        INC     <FACEXP
        BEQ     RNDOV
RND1    RTS
RND2    CLR     <FACEXT
        RTS
RNDOV   JMP     OVERR

* MOVMF: store FAC, rounded, packed at X. Keeps X.
MOVMF   BSR     ROUND
        PSHS    D
        LDA     <FACEXP
        STA     ,X
        BEQ     MMF2
        LDA     <FACM
        ANDA    #$7F
        TST     <FACSGN
        BPL     MMF1
        ORA     #$80
MMF1    STA     1,X
        LDD     <FACM+1
        STD     2,X
        LDA     <FACM+3
        STA     4,X
        PULS    D,PC
MMF2    CLR     1,X
        CLR     2,X
        CLR     3,X
        CLR     4,X
        PULS    D,PC

* MOVAF: ARG = FAC (rounded). MOVFA: FAC = ARG.
MOVAF   BSR     ROUND
        LDX     #FACEXP
        LDU     #ARGEXP
        BRA     MOVR
MOVFA   LDX     #ARGEXP
        LDU     #FACEXP
MOVR    LDB     #7
MOVR1   LDA     ,X+
        STA     ,U+
        DECB
        BNE     MOVR1
        RTS

* FZERO: FAC = 0
FZERO   CLR     <FACEXP
        CLR     <FACSGN
        CLR     <FACEXT
        RTS

* FNEG: FAC = -FAC
FNEG    TST     <FACEXP
        BEQ     FNEG1
        COM     <FACSGN
FNEG1   RTS

* FSUB: FAC = ARG - FAC
FSUB    BSR     FNEG
* FADD: FAC = ARG + FAC
FADD    BSR     ROUND
        TST     <ARGEXP
        LBEQ    FA9             ; + 0
        TST     <FACEXP
        BNE     FA1
        BRA     MOVFA           ; 0 + ARG
FA1     LDA     <FACEXP
        CMPA    <ARGEXP
        BHS     FA3
        LDB     #7              ; ARG has the larger exponent: swap them
        LDX     #FACEXP
FA2     LDA     ,X
        PSHS    A
        LDA     ARGEXP-FACEXP,X
        STA     ,X+
        PULS    A
        STA     ARGEXP-FACEXP-1,X
        DECB
        BNE     FA2
FA3     LDB     <FACEXP
        SUBB    <ARGEXP         ; how far ARG is shifted right
        CMPB    #40
        BLO     FA4
        CLR     <ARGM           ; too far: ARG adds nothing
        CLR     <ARGM+1
        CLR     <ARGM+2
        CLR     <ARGM+3
        CLR     <ARGEXT
        BRA     FA6
FA4     CMPB    #8              ; whole bytes first
        BLO     FA5
        LDA     <ARGM+3
        STA     <ARGEXT
        LDA     <ARGM+2
        STA     <ARGM+3
        LDA     <ARGM+1
        STA     <ARGM+2
        LDA     <ARGM
        STA     <ARGM+1
        CLR     <ARGM
        SUBB    #8
        BRA     FA4
FA5     TSTB
        BEQ     FA6
        LSR     <ARGM
        ROR     <ARGM+1
        ROR     <ARGM+2
        ROR     <ARGM+3
        ROR     <ARGEXT
        DECB
        BRA     FA5
FA6     LDA     <FACSGN
        CMPA    <ARGSGN
        BNE     FA7
* the same signs: add
        LDA     <FACEXT
        ADDA    <ARGEXT
        STA     <FACEXT
        LDD     <FACM+2
        ADCB    <ARGM+3
        ADCA    <ARGM+2
        STD     <FACM+2
        LDD     <FACM
        ADCB    <ARGM+1
        ADCA    <ARGM
        STD     <FACM
        BCC     FA9
        ROR     <FACM           ; the carry comes back in at the top
        ROR     <FACM+1
        ROR     <FACM+2
        ROR     <FACM+3
        ROR     <FACEXT
        INC     <FACEXP
        LBEQ    RNDOV
FA9     RTS
* different signs: subtract, and negate if it went below 0
FA7     LDA     <FACEXT
        SUBA    <ARGEXT
        STA     <FACEXT
        LDD     <FACM+2
        SBCB    <ARGM+3
        SBCA    <ARGM+2
        STD     <FACM+2
        LDD     <FACM
        SBCB    <ARGM+1
        SBCA    <ARGM
        STD     <FACM
        BCC     NORM
        COM     <FACSGN
        COM     <FACM
        COM     <FACM+1
        COM     <FACM+2
        COM     <FACM+3
        NEG     <FACEXT
        BNE     NORM
        LDD     <FACM+2         ; the +1 of the two's complement carries on up
        ADDD    #1
        STD     <FACM+2
        LDD     <FACM
        ADCB    #0
        ADCA    #0
        STD     <FACM
* NORM: normalise FAC's 40-bit mantissa (FACM and FACEXT) so its top bit is set; 0 if it is all 0 or the
* exponent goes below 1
NORM    LDA     <FACM
        ORA     <FACM+1
        ORA     <FACM+2
        ORA     <FACM+3
        ORA     <FACEXT
        BEQ     NORMZ
NORM1   TST     <FACM
        BNE     NORM2
        LDA     <FACEXP         ; a whole byte
        SUBA    #8
        BLS     NORMZ
        STA     <FACEXP
        LDA     <FACM+1
        STA     <FACM
        LDA     <FACM+2
        STA     <FACM+1
        LDA     <FACM+3
        STA     <FACM+2
        LDA     <FACEXT
        STA     <FACM+3
        CLR     <FACEXT
        BRA     NORM1
NORM2   TST     <FACM
        BMI     NORM3
        ASL     <FACEXT
        ROL     <FACM+3
        ROL     <FACM+2
        ROL     <FACM+1
        ROL     <FACM
        DEC     <FACEXP
        BNE     NORM2
NORMZ   JMP     FZERO
NORM3   RTS

* FMUL: FAC = ARG x FAC. The top 40 bits of the 64-bit product, normalised.
FMUL    JSR     ROUND
        TST     <FACEXP
        LBEQ    FMZ
        TST     <ARGEXP
        LBEQ    FMZ
        LDA     <FACSGN
        EORA    <ARGSGN
        STA     <FACSGN
        LDB     <FACEXP         ; the exponent, in 16 bits: FACEXP + ARGEXP - 128
        CLRA
        ADDB    <ARGEXP
        ADCA    #0
        SUBD    #128
        STD     <FPEXP
        LDX     #PROD
        LDB     #8
FM0     CLR     ,X+
        DECB
        BNE     FM0
        LDA     #3
        STA     <FPI
FM1     LDA     #3
        STA     <FPJ
FM2     LDX     #ARGM
        LDB     <FPI
        LDA     B,X
        LDX     #FACM
        LDB     <FPJ
        LDB     B,X
        MUL
        PSHS    D
        LDB     <FPI
        ADDB    <FPJ
        INCB
        LDX     #PROD
        ABX                     ; the partial product's low byte goes here
        PULS    D
        ADDB    ,X
        STB     ,X
        ADCA    ,-X
        STA     ,X
        BCC     FM4
FM3     LEAX    -1,X            ; the carry ripples up
        INC     ,X
        BEQ     FM3
FM4     DEC     <FPJ
        BPL     FM2
        DEC     <FPI
        BPL     FM1
        LDD     <PROD
        STD     <FACM
        LDD     <PROD+2
        STD     <FACM+2
        LDA     <PROD+4
        STA     <FACEXT
        TST     <FACM
        BMI     FM5
        ASL     <FACEXT         ; at most one place: the product of two mantissas is at least 1/4
        ROL     <FACM+3
        ROL     <FACM+2
        ROL     <FACM+1
        ROL     <FACM
        LDD     <FPEXP
        SUBD    #1
        STD     <FPEXP
* FPEXP to FACEXP: below 1 is 0, above 255 is ?OV ERROR
FM5     LDD     <FPEXP
        BLE     FMZ
        TSTA
        BNE     FMOV
        STB     <FACEXP
        RTS
FMZ     JMP     FZERO
FMOV    JMP     OVERR

* FDIV: FAC = ARG / FAC (?/0 ERROR for 0). 41 quotient bits by restoring division, normalised to 40.
FDIV    JSR     ROUND
        TST     <FACEXP
        BNE     FD1
        JMP     DZERR
FD1     TST     <ARGEXP
        BEQ     FMZ
        LDA     <FACSGN
        EORA    <ARGSGN
        STA     <FACSGN
        LDB     <ARGEXP         ; ARGEXP - FACEXP + 128
        CLRA
        ADDD    #128
        SUBB    <FACEXP
        SBCA    #0
        STD     <FPEXP
        CLR     <DVR            ; the remainder: 0 and ARG's mantissa (33 bits are enough)
        LDD     <ARGM
        STD     <DVR+1
        LDD     <ARGM+2
        STD     <DVR+3
        LDX     #PROD           ; the quotient: 6 bytes
        LDB     #6
FD2     CLR     ,X+
        DECB
        BNE     FD2
        LDA     #41
        STA     <FPI
FD3     ASL     <PROD+5         ; quotient << 1
        ROL     <PROD+4
        ROL     <PROD+3
        ROL     <PROD+2
        ROL     <PROD+1
        ROL     <PROD
        LDD     <DVR+3          ; remainder - divisor, kept only if it does not go below 0
        SUBD    <FACM+2
        PSHS    D
        LDD     <DVR+1
        SBCB    <FACM+1
        SBCA    <FACM
        PSHS    D
        LDA     <DVR
        SBCA    #0
        BLO     FD4
        STA     <DVR
        PULS    D
        STD     <DVR+1
        PULS    D
        STD     <DVR+3
        INC     <PROD+5
        BRA     FD5
FD4     LEAS    4,S
FD5     ASL     <DVR+4          ; remainder << 1
        ROL     <DVR+3
        ROL     <DVR+2
        ROL     <DVR+1
        ROL     <DVR
        DEC     <FPI
        BNE     FD3
* 41 bits in PROD (bit 40 is PROD bit 0): 2^40 or more is shifted right once, exponent + 1
        LDA     <PROD
        LSRA
        BCC     FD6
        LSR     <PROD
        ROR     <PROD+1
        ROR     <PROD+2
        ROR     <PROD+3
        ROR     <PROD+4
        ROR     <PROD+5
        LDD     <FPEXP
        ADDD    #1
        STD     <FPEXP
FD6     LDD     <PROD+1
        STD     <FACM
        LDD     <PROD+3
        STD     <FACM+2
        LDA     <PROD+5
        STA     <FACEXT
        LBRA    FM5

* FCMP: compare ARG with FAC (FAC rounded first). A = $FF if ARG < FAC, 0 if equal, 1 if ARG > FAC; the flags
* as after TSTA.
FCMP    JSR     ROUND
        LDA     <ARGEXP
        BNE     FC1
        LDA     <FACEXP         ; ARG is 0: the answer is the opposite of FAC's sign
        BEQ     FCEQ
        LDA     <FACSGN
        BMI     FCGT
        BRA     FCLT
FC1     LDA     <FACEXP
        BEQ     FCSA            ; FAC is 0: the answer is ARG's sign
        LDA     <ARGSGN
        CMPA    <FACSGN
        BNE     FCSA
        LDA     <ARGEXP         ; the same sign: compare the magnitudes
        CMPA    <FACEXP
        BNE     FC2
        LDD     <ARGM
        CMPD    <FACM
        BNE     FC2
        LDD     <ARGM+2
        CMPD    <FACM+2
        BEQ     FCEQ
FC2     BLO     FCSMAL
        LDA     <ARGSGN         ; |ARG| > |FAC|
        BMI     FCLT
        BRA     FCGT
FCSMAL  LDA     <ARGSGN
        BMI     FCGT
        BRA     FCLT
FCSA    LDA     <ARGSGN
        BMI     FCLT
FCGT    LDA     #1
        RTS
FCLT    LDA     #$FF
        RTS
FCEQ    CLRA
        RTS
