* ---------------- floating point ----------------
* The Microsoft Binary Format [MBF]: 5 bytes, an exponent byte (excess 128; 0 means the number is 0) and a 32-bit
* mantissa, most significant byte first, whose top bit (always 1) is stored as the sign.
* Two unpacked accumulators in the direct page, FAC and ARG: the exponent, the mantissa with its top bit
* explicit, a guard byte below it (EXT), and the sign ($00 or $FF). Binary operations take the left operand in
* ARG (always loaded from a packed number, so its guard byte is 0) and the right one in FAC, and leave the result
* in FAC with 8 guard bits. Each operation first rounds FAC (ROUND: up when the guard byte is $80 or more).
* tests/basic/fpmodel.js is the bit-exact model these routines are tested against.

* MOVFM: FAC = the packed number at X. MOVAM: ARG = it. Keep X.
MOVFM   PSHS    D
        LDD     ,X
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
        PULS    D,PC
MOVAM   PSHS    D               ; (the same for ARG)
        LDD     ,X
        STA     <ARGEXP
        SEX
        STA     <ARGSGN
        ORB     #$80
        STB     <ARGM
        LDD     2,X
        STD     <ARGM+1
        LDA     4,X
        STA     <ARGM+3
        CLR     <ARGEXT
        PULS    D,PC

* ROUND: FAC rounded to 32 bits (?OV ERROR if that carries out of the largest exponent). Keeps X, Y, U.
ROUND   LDA     <FACEXT         ; (a guard byte of 0: nothing to round or clear)
        BEQ     RND1
        TST     <FACEXP
        BEQ     RND2
        TSTA
        BPL     RND2
        CLR     <FACEXT
        BSR     INCFM
        BCC     RND1
        ROR     <FACM           ; it carried out: $80000000 and the next exponent
        INC     <FACEXP
        BEQ     RNDOV
RND1    RTS
RND2    CLR     <FACEXT
        RTS
RNDOV   JMP     OVERR
* INCFM: FACM + 1 (32 bits); C set if it carried out. Uses D.
INCFM   LDD     <FACM+2
        ADDD    #1
        STD     <FACM+2
        LDD     <FACM
        ADCB    #0
        ADCA    #0
        STD     <FACM
        RTS

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
MMF2    CLRB                    ; (A is 0)
        STD     1,X
        STD     3,X
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
FADDX   JSR     MOVAM           ; (FADDX, FSUBX: [X] + FAC, [X] - FAC; mathfn.inc)
        BRA     FADD
FSUBX   JSR     MOVAM
FSUB    BSR     FNEG
* FADD: FAC = ARG + FAC
FADD    JSR     ROUND
        TST     <ARGEXP
        BEQ     FA9             ; + 0
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
        BHS     FA9             ; too far: ARG adds nothing, and FAC (rounded, normal) is the sum
        LDX     #ARGM
        JSR     SHFTR
        LDA     <FACSGN
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
        JSR     INCFM           ; the +1 of the two's complement carries on up
* (FADD's subtraction above falls through into NORM: nothing may be placed between them)
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

* SHFTR: the five bytes at X (a mantissa and its guard byte) shifted right B places (B below 48): whole bytes
* first. Keeps X.
SHFTR     CMPB    #8
        BLO     SHFT2
        LDA     3,X
        STA     4,X
        LDA     2,X
        STA     3,X
        LDA     1,X
        STA     2,X
        LDA     ,X
        STA     1,X
        CLR     ,X
        SUBB    #8
        BRA     SHFTR
SHFT1    LSR     ,X
        ROR     1,X
        ROR     2,X
        ROR     3,X
        ROR     4,X
        DECB
SHFT2    TSTB
        BNE     SHFT1
        RTS

* FMUL: FAC = ARG x FAC. The top 40 bits of the 64-bit product, normalised.
FMULX   JSR     MOVAM           ; (FMULX: [X] x FAC)
FMUL    JSR     ROUND
        TST     <FACEXP
        BEQ     FMZ
        TST     <ARGEXP
        BEQ     FMZ
        LDA     <FACSGN
        EORA    <ARGSGN
        STA     <FACSGN
        LDB     <FACEXP         ; the exponent, in 16 bits: FACEXP + ARGEXP - 128
        CLRA
        ADDB    <ARGEXP
        ADCA    #0
        SUBD    #128
        STD     <FPEXP
        BSR     MULMAN
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
* MULMAN: PROD (64 bits) = FACM x ARGM, the two mantissas as whole numbers (FMUL's product; RND's, whose seed and
* multiplier are no normal mantissas: a 0 byte of ARGM only skips its row). Uses D, X, Y, U and FPI.
MULMAN  LDX     #PROD
        LDB     #8
FM0     CLR     ,X+
        DECB
        BNE     FM0
        LDU     #ARGM+4         ; ARG's bytes from the last, FPI counting them (4 to 1)
        LDA     #4
        STA     <FPI
FM1     LDA     ,-U             ; a 0 byte adds nothing: its row is skipped
        BEQ     FM4A
        LDY     #FACM+4
        LDX     #PROD+3
        LDB     <FPI
        ABX                     ; the low byte of this row's first partial product
FM2     LDA     ,U
        LDB     ,-Y
        MUL
        ADDD    -1,X
        STD     -1,X
        BCC     FM4
        PSHS    X
        LEAX    -1,X
FM3     INC     ,-X             ; the carry ripples up
        BEQ     FM3
        PULS    X
FM4     LEAX    -1,X
        CMPY    #FACM
        BNE     FM2
FM4A    DEC     <FPI
        BNE     FM1
        RTS

* FDIV: FAC = ARG / FAC (?/0 ERROR for 0). 41 quotient bits by restoring division, normalised to 40.
FDIVX   JSR     MOVAM           ; (FDIVX: [X] / FAC)
FDIV    JSR     ROUND
        TST     <FACEXP
        LBEQ    DZERR
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
* the quotient's 41 bits go into PROD a byte at a time (1 bit into PROD, then 8 into each byte after it), each
* rotated in from the carry: 1 where the divisor goes into the remainder (then subtracted), else 0. The remainder
* is below twice the divisor: DVR holds only its bit 32.
        LDX     #PROD
        CLR     ,X
        LDA     #1
FD2     STA     <FPI            ; the bits for this byte
FD3     TST     <DVR
        BNE     FD4             ; bit 32 set: the divisor goes
        LDD     <DVR+1
        CMPD    <FACM
        BHI     FD4
        BLO     FD5
        LDD     <DVR+3
        CMPD    <FACM+2
        BLO     FD5
FD4     LDD     <DVR+3          ; remainder - divisor
        SUBD    <FACM+2
        STD     <DVR+3
        LDD     <DVR+1
        SBCB    <FACM+1
        SBCA    <FACM
        STD     <DVR+1
        CLR     <DVR
        COMA                    ; (C set: a 1)
        BRA     FDQ
FD5     ANDCC   #$FE            ; (a 0)
FDQ     ROL     ,X
        ASL     <DVR+4          ; remainder << 1
        ROL     <DVR+3
        ROL     <DVR+2
        ROL     <DVR+1
        ROL     <DVR
        DEC     <FPI
        BNE     FD3
        LEAX    1,X
        LDA     #8
        CMPX    #PROD+6
        BNE     FD2
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
* (B holds a sign: negative gives $FF, the less-than answer. Uses X.)
FCMP    JSR     ROUND
        LDB     <ARGSGN
        LDA     <ARGEXP
        BNE     FC1
        LDA     <FACEXP         ; ARG is 0: the answer is the opposite of FAC's sign
        BEQ     FCEQ            ; (both 0: A is 0)
        LDB     <FACSGN
        BRA     FCINV
FC1     LDA     <FACEXP
        BEQ     FCSA            ; FAC is 0: the answer is ARG's sign
        CMPB    <FACSGN
        BNE     FCSA            ; different signs: ARG's too
        LDA     <ARGEXP         ; the same sign: compare the magnitudes
        CMPA    <FACEXP
        BNE     FC2
        LDX     <ARGM
        CMPX    <FACM
        BNE     FC2
        LDX     <ARGM+2
        CMPX    <FACM+2
        BEQ     FCEQ0
FC2     BHI     FCSA            ; |ARG| > |FAC|: ARG's sign; below it, the opposite
FCINV   COMB
FCSA    TSTB
        BMI     FCLT
        LDA     #1
        RTS
FCLT    LDA     #$FF
        RTS
FCEQ0   CLRA
FCEQ    RTS
