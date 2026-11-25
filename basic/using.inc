* ---------------- PRINT USING ----------------
* PRINT USING format$; items [UM]. In the format: # a digit; . the point; , (before the point) commas every three
* digits; ** at the start fills with *; $$ puts a $ before the number; + at the start or end prints the sign
* there; - at the end prints a - for a negative number; ^^^^ after the digits is E notation. ! prints a string's
* first character; % spaces % a field of that many characters plus 2. Anything else prints as it is. A number
* too wide for its field prints whole after a %. The format is used again from its start for more items.
* [OWN, provisional until the black-box run: a 0 before the point when there is room for one; the sign of a
* number with no + or - in its field takes a digit's place; E notation keeps as many digits before the point as
* the field has #s.]

* the format character at USPOS (Z set past its end); keeps X
USCHR   PSHS    X
        LDX     <USDSC
        LDB     <USPOS
        CMPB    ,X
        BHS     UC1
        LDX     2,X
        LDA     B,X
        ANDCC   #$FB
        PULS    X,PC
UC1     CLRA
        ORCC    #4
        PULS    X,PC
* the format character after it, without moving (A; Z set past the end)
USNEXT  INC     <USPOS
        JSR     USCHR
        DEC     <USPOS
        TSTA
        RTS

PRUSNG  JSR     CHRGET          ; (on USING)
        JSR     EVSTR
        LDX     <STRPTR         ; the format stays a temporary until the end (read through its descriptor)
        STX     <USDSC
        TST     ,X
        LBEQ    FCERR
        LDB     #';'
        JSR     SYNCHR
        CLR     <USPOS
        CLR     <USANY
* one item: literal characters up to a field, then the field
US1     JSR     USCHR
        BNE     US2
        TST     <USANY          ; the end of the format: again from its start (?FC ERROR if it has no field)
        LBEQ    FCERR
        CLR     <USPOS
        BRA     US1
US2     JSR     USFLD
        BCC     US3
        JSR     CHROUT          ; a literal
        INC     <USPOS
        BRA     US1
US3     INC     <USANY
        JSR     EVAL
        TST     <USKIND
        BNE     USS             ; a string field
        JSR     CHKNUM
        JSR     USNUM
        BRA     US5
USS     JSR     CHKSTR
        JSR     USSTR
US5     JSR     CHRGOT          ; ; or , : another item, or the end with no new line
        BEQ     US7
        CMPA    #';'
        BEQ     US6
        CMPA    #','
        BNE     US1
US6     JSR     CHRGET
        BNE     US1
        BRA     US9
US7     JSR     USCHR           ; the end: the literals up to the next field, then a new line
        BEQ     US8
        JSR     USFLD
        BCC     US8
        JSR     CHROUT
        INC     <USPOS
        BRA     US7
US8     JSR     CRLF
US9     LDX     <USDSC
        JMP     FRETMP

* USFLD: does a field start at USPOS? C clear if so (USKIND: 0 a number, 1 !, 2 %...%), A = the character;
* C set for a literal
USFLD   JSR     USCHR
        CLR     <USKIND
        CMPA    #'#'
        BEQ     UFY
        CMPA    #'+'
        BEQ     UFY
        CMPA    #'.'
        BNE     UF1
        JSR     USNEXT          ; . starts a number only before a #
        CMPA    #'#'
        BEQ     UFY0
        BRA     UFN0
UF1     CMPA    #'*'
        BEQ     UF2
        CMPA    #'$'
        BNE     UF3
UF2     PSHS    A               ; ** and $$ start a number
        JSR     USNEXT
        CMPA    ,S+
        BEQ     UFY0
        BRA     UFN0
UF3     INC     <USKIND
        CMPA    #'!'
        BEQ     UFY
        INC     <USKIND
        CMPA    #'%'
        BEQ     UFY
UFN0    JSR     USCHR
        ORCC    #1
        RTS
UFY0    JSR     USCHR
UFY     ANDCC   #$FE
        RTS

* USSTR: the string field: ! its first character, %..% that many characters, padded with spaces
USSTR   JSR     FRESTR
        PSHS    B,X
        LDA     <USKIND
        CMPA    #1
        BNE     USS1
        INC     <USPOS
        LDB     #1              ; !
        BRA     USS3
USS1    CLRB                    ; % ... %: the width
USS2    INCB
        INC     <USPOS
        PSHS    B
        JSR     USCHR
        PULS    B
        BEQ     USS3            ; (no closing %: to the end)
        CMPA    #'%'
        BNE     USS2
        INCB
        INC     <USPOS
USS3    PULS    A,X             ; A: the string's length, B: the field's
        PSHS    B
        CMPA    ,S
        BLS     USS4
        LDA     ,S              ; cut to the field
USS4    PSHS    A
        TFR     A,B
        JSR     PRTN
        PULS    A
        PULS    B
        PSHS    A
        SUBB    ,S+
        BEQ     USS6
USS5    JSR     SPACE
        DECB
        BNE     USS5
USS6    RTS

* USNUM: the numeric field at USPOS and the number in FAC
USNUM   CLR     <USNB
        CLR     <USNA
        CLR     <USFLG          ; bits: 1 a point, 2 commas, 4 *, 8 $, 16 + first, 32 + last, 64 - last, 128 ^^^^
        JSR     USCHR
        CMPA    #'+'
        BNE     USN1
        LDA     #16
        STA     <USFLG
        INC     <USPOS
USN1     JSR     USCHR
        CMPA    #'*'
        BNE     USN2
        LDA     #4              ; ** (and **$)
        JSR     USFSET
        LDA     #2
        STA     <USNB
        INC     <USPOS
        INC     <USPOS
        JSR     USCHR
        CMPA    #'$'
        BNE     USN3
        LDA     #8
        JSR     USFSET
        INC     <USNB
        INC     <USPOS
        BRA     USN3
USN2     CMPA    #'$'
        BNE     USN3
        LDA     #8              ; $$
        JSR     USFSET
        LDA     #2
        STA     <USNB
        INC     <USPOS
        INC     <USPOS
USN3     JSR     USCHR           ; # and , before the point
        CMPA    #'#'
        BEQ     USN4
        CMPA    #','
        BNE     USN5
        LDA     #2
        JSR     USFSET
USN4     INC     <USNB
        INC     <USPOS
        BRA     USN3
USN5     CMPA    #'.'
        BNE     USN7
        LDA     #1
        JSR     USFSET
        INC     <USPOS
USN6     JSR     USCHR           ; # after it
        CMPA    #'#'
        BNE     USN7
        INC     <USNA
        INC     <USPOS
        BRA     USN6
USN7     LDB     #4              ; ^^^^
        PSHS    B
        LDB     <USPOS
        PSHS    B
UN7A    JSR     USCHR
        CMPA    #'^'
        BNE     UN7B
        INC     <USPOS
        DEC     1,S
        BNE     UN7A
        LDA     #128
        JSR     USFSET
        LEAS    2,S
        BRA     USN8
UN7B    PULS    B               ; not four: they are literals
        STB     <USPOS
        LEAS    1,S
USN8     JSR     USCHR           ; a + or - at the end
        CMPA    #'+'
        BNE     USN9
        LDA     <USFLG
        BITA    #16
        BNE     USN10
        LDA     #32
        BRA     UN9A
USN9     CMPA    #'-'
        BNE     USN10
        LDA     #64
UN9A    JSR     USFSET
        INC     <USPOS
USN10    JMP     USFMT
USFSET  ORA     <USFLG
        STA     <USFLG
        RTS

* USFMT: the number into FBUFFR, then printed in the field
USFMT   CLR     <USNEG
        TST     <FACSGN
        BPL     UM1
        COM     <USNEG
        CLR     <FACSGN
UM1     LDA     <USFLG
        BMI     UMEXP
        LDB     <USNA           ; round to the decimals: |x| x 10^na + .5, whole
        CMPB    #17
        LBHI    FCERR
        JSR     FMULP
        LDX     #FPHALF
        JSR     MOVAM
        JSR     FADD
        JSR     FTRUNC
        LDA     <FACEXP
        CMPA    #160
        BHI     UMOV
        JSR     QINT
        JSR     U32DEC          ; X = the digits, B = how many
        LBRA    UMBODY
UMOV    JSR     FOUT            ; too large for 32 bits: % and the number as PRINT has it
        LDA     #'%'
        JSR     CHROUT
        JMP     PRTSTR
* E notation: as many digits before the point as the field has #s
UMEXP   LDA     <USNB           ; at most nine digits: more is ?FC ERROR
        ADDA    <USNA
        CMPA    #9
        LBHI    FCERR
        JSR     FOUT            ; nine digits in FPDIG, the exponent of the first in FPE10
        LDA     <USNB
        ADDA    <USNA
        BNE     UME1
        INCA
UME1    CMPA    #9
        BLS     UME2
        LDA     #9
UME2    STA     <USK            ; the digits kept, rounded from nine
        LDX     #FPDIG
        LDB     <USK
        CMPB    #9
        BHS     UME5            ; all nine kept
        LDA     B,X
        CMPA    #'5'
        BLO     UME5
UME3    DECB                    ; round up: carry along
        BMI     UME4
        LDA     B,X
        INCA
        STA     B,X
        CMPA    #'9'
        BLS     UME5
        LDA     #'0'
        STA     B,X
        BRA     UME3
UME4    LDA     #'1'            ; it carried out: 1000... and one place more
        STA     ,X
        LDD     <FPE10
        ADDD    #1
        STD     <FPE10
UME5    LDD     <FPE10          ; the exponent shown: E - (digits before the point - 1)
        TST     <FACEXP
        BNE     UME6
        LDD     #0
        STD     <FPE10
        LDA     #'0'            ; (0: zeros)
        LDB     #9
UME5A   STA     ,X+
        DECB
        BNE     UME5A
        LDD     #0
UME6    LDB     <USNB
        BEQ     UME7
        DECB
UME7    NEGB
        SEX
        ADDD    <FPE10
        STD     <USEXP
        LDX     #FBUFFR+20      ; build: digits, point, E+nn
        LDU     #FPDIG
        LDB     <USNB
        BEQ     UME9
UME8    LDA     ,U+
        STA     ,X+
        DECB
        BNE     UME8
UME9    LDA     <USFLG
        BITA    #1
        BEQ     UME11
        LDA     #'.'
        STA     ,X+
        LDB     <USNA
        BEQ     UME11
UME10   LDA     ,U+
        STA     ,X+
        DECB
        BNE     UME10
UME11   LDA     #'E'
        STA     ,X+
        LDA     #'+'
        LDB     <USEXP+1
        TST     <USEXP
        BPL     UME12
        LDA     #'-'
        NEGB
UME12   STA     ,X+
        LDA     #'0'-1
UME13   INCA
        SUBB    #10
        BHS     UME13
        ADDB    #'0'+10
        STA     ,X+
        STB     ,X+
        TFR     X,D
        SUBD    #FBUFFR+20
        LDX     #FBUFFR+20
        LDA     <USFLG
        ANDA    #$FD            ; (no commas in E notation)
        STA     <USFLG
        BRA     UMOUT2
* the body from the digits (X, B): the integer part, commas, the point and the decimals
UMBODY  LDU     #FBUFFR+20
        PSHS    B
        SUBB    <USNA           ; integer digits
        BHI     UMB1
        CLRB                    ; none: a 0 if there is room for one
        LDA     <USNB
        BEQ     UMB2
        LDA     #'0'
        STA     ,U+
        BRA     UMB2
UMB1    STB     <USK
UMB1A   LDA     ,X+
        STA     ,U+
        DEC     <USK
        BEQ     UMB2
        LDA     <USFLG          ; a comma where three digits remain to the point
        BITA    #2
        BEQ     UMB1A
        LDA     <USK
UMB1B   SUBA    #3
        BHI     UMB1B
        BNE     UMB1A
        LDA     #','
        STA     ,U+
        BRA     UMB1A
UMB2    LDA     <USFLG
        BITA    #1
        BEQ     UMB5
        LDA     #'.'
        STA     ,U+
        LDB     <USNA           ; the decimals: leading zeros when the digits were fewer
        BEQ     UMB5
        LDA     ,S
        CMPA    <USNA
        BHS     UMB4
        PSHS    B
        SUBB    1,S
        LDA     #'0'
UMB3    STA     ,U+
        DECB
        BNE     UMB3
        PULS    B
        LDB     ,S
UMB4    TSTB
        BEQ     UMB5
        CMPB    <USNA
        BLS     UMB4A
        LDB     <USNA
UMB4A   LDA     ,X+
        STA     ,U+
        DECB
        BNE     UMB4A
UMB5    LEAS    1,S
        TFR     U,D
        SUBD    #FBUFFR+20
        LDX     #FBUFFR+20
* UMOUT2: the body (X, B characters) printed in the field with its sign, $ and fill
UMOUT2  STB     <USK
        LDA     <USNB           ; the field's width
        ADDA    <USNA
        LDB     <USFLG
        BITB    #1
        BEQ     UMO1
        INCA
UMO1    BITB    #16+32+64
        BEQ     UMO2
        INCA
UMO2    BITB    #128
        BEQ     UMO3
        ADDA    #4
UMO3    STA     <USW
        LDA     <USK            ; the body's width: and the sign, the $
        BITB    #8
        BEQ     UMO4
        INCA
UMO4    BITB    #16+32+64
        BNE     UMO5
        TST     <USNEG          ; no + or -: a - takes a digit's place
        BEQ     UMO5
        INCA
UMO5    BITB    #64             ; - last for a positive number is a space
        BEQ     UMO5A
        INCA
UMO5A   BITB    #16+32          ; (+ is counted once)
        BEQ     UMO6
        INCA
UMO6    CMPA    <USW
        BLS     UMO7
        PSHS    A
        LDA     #'%'            ; too wide
        JSR     CHROUT
        PULS    A
        STA     <USW
UMO7    NEGA
        ADDA    <USW            ; the fill
        BEQ     UMO9
        PSHS    A
UMO8    LDA     #' '
        BITB    #4
        BEQ     UMO8A
        LDA     #'*'
UMO8A   JSR     CHROUT
        DEC     ,S
        BNE     UMO8
        LEAS    1,S
UMO9    BITB    #16             ; + first
        BEQ     UMO10
        JSR     USSIGN
UMO10   BITB    #16+32+64
        BNE     UMO11
        TST     <USNEG
        BEQ     UMO11
        LDA     #'-'
        JSR     CHROUT
UMO11   BITB    #8
        BEQ     UMO12
        LDA     #'$'
        JSR     CHROUT
UMO12   PSHS    B
        LDB     <USK
        JSR     PRTN
        PULS    B
        BITB    #32             ; + last
        BEQ     UMO13
        JSR     USSIGN
UMO13   BITB    #64             ; - last
        BEQ     UMO14
        LDA     #' '
        TST     <USNEG
        BEQ     UMO13A
        LDA     #'-'
UMO13A  JSR     CHROUT
UMO14   RTS
USSIGN  LDA     #'+'
        TST     <USNEG
        BEQ     USG1
        LDA     #'-'
USG1    JMP     CHROUT

* U32DEC: FACM (32 bits) in decimal: X = the digits (no leading zeros, at least one), B = how many
U32DEC  LDX     #FBUFFR+19      ; the digits, from the last backwards
        CLR     <USK
UD1     LDB     #32             ; FACM / 10: the remainder is the digit
        CLRA
UD2     ASL     <FACM+3
        ROL     <FACM+2
        ROL     <FACM+1
        ROL     <FACM
        ROLA
        CMPA    #10
        BLO     UD3
        SUBA    #10
        INC     <FACM+3
UD3     DECB
        BNE     UD2
        ADDA    #'0'
        STA     ,-X
        INC     <USK
        LDD     <FACM
        BNE     UD1
        LDD     <FACM+2
        BNE     UD1
        LDB     <USK
        RTS
