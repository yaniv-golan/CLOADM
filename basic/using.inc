* ---------------- PRINT USING ----------------
* PRINT USING format$; items [UM]. In the format: # a digit; . the point; , (before the point) commas every three
* digits; ** at the start fills with *; $$ puts a $ before the number; + at the start or end prints the sign
* there; - at the end prints a - for a negative number; ^^^^ after the digits is E notation. ! prints a string's
* first character; % spaces % a field of that many characters plus 2. Anything else prints as it is. A number
* too wide for its field prints whole after a %. The format is used again from its start for more items.
* [OWN, provisional until the black-box run: a 0 before the point when there is room for one; the sign of a
* number with no + or - in its field takes a digit's place.]

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
UC1     CLRA                    ; (Z set)
        PULS    X,PC
PRUSNG  JSR     <ZCHRGET          ; (on USING)
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
US1     BSR     USCHR
        BNE     US2
        TST     <USANY          ; the end of the format: again from its start (?FC ERROR if it has no field)
        LBEQ    FCERR
        CLR     <USPOS
        BRA     US1
US2     BSR     USFLD
        BCC     US3
        JSR     <ZCHROUT          ; a literal
        INC     <USPOS
        BRA     US1
US3     INC     <USANY
        JSR     EVAL
        TST     <USKIND
        BNE     USS             ; a string field
        JSR     <ZCHKNUM
        JSR     USNUM
        BRA     US5
USS     JSR     CHKSTR
        BSR     USSTR
US5     JSR     <ZCHRGOT          ; ; or , : another item, or the end with no new line
        BEQ     US7
        CMPA    #';'
        BEQ     US6
        CMPA    #','
        BNE     US1
US6     JSR     <ZCHRGET
        BNE     US1
        BRA     US9
US7     BSR     USCHR           ; the end: the literals up to the next field, then a new line
        BEQ     US8
        BSR     USFLD
        BCC     US8
        JSR     <ZCHROUT
        INC     <USPOS
        BRA     US7
US8     JSR     CRLF
US9     LDX     <USDSC
        JMP     FRETMP

* USFLD: does a field start at USPOS? C clear if so (USKIND: 0 a number, 1 !, 2 %...%), A = the character;
* C set for a literal
USFLD   CLR     <USKIND         ; both callers have just read A with USCHR
        CMPA    #'#'
        BEQ     UFYES
        CMPA    #'+'
        BEQ     UFYES
        CMPA    #'.'
        BEQ     UFDOT
        CMPA    #'*'
        BEQ     UFPAIR
        CMPA    #'$'
        BEQ     UFPAIR
        INC     <USKIND
        CMPA    #'!'
        BEQ     UFYES
        INC     <USKIND
        CMPA    #'%'
        BEQ     UFYES
        ORCC    #1
UFYES   RTS                     ; an equal comparison already cleared carry
UFDOT   LDB     #'#'             ; . must precede #, whereas * and $ must repeat
        BRA     UFLOOK
UFPAIR  TFR     A,B
UFLOOK  PSHS    D
        INC     <USPOS
        JSR     <ZUSCHR
        DEC     <USPOS
        CMPA    1,S
        BEQ     UFEXIT
        ORCC    #1
UFEXIT  PULS    D,PC            ; restore the character without changing carry

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
        JSR     <ZUSCHR
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
USNUM   CLRA
        CLRB
        STD     <USNB           ; adjacent counts before and after the point
        STA     <USFLG          ; 1 point, 2 commas, 4 stars, 8 dollar, 16/32/64 sign, 128 exponent
        LDX     <USDSC
        LDU     2,X             ; format bytes; B is the original 8-bit descriptor index
        LDB     <USPOS
        BSR     UNCHAR
        CMPA    #'+'
        BNE     UNPREFIX
        LDA     #16
        STA     <USFLG
        BSR     UNNEXT
UNPREFIX CMPA   #'*'
        BNE     UNDOLL
        LDA     #4
        BSR     UNPAIR
        CMPA    #'$'
        BNE     UNINT
        LDA     #8
        BSR     UNFLAG
        BRA     UNPLACE
UNPAIR  BSR     UNFLAG
        INC     <USNB
        INC     <USNB
        INCB
UNNEXT  INCB
UNCHAR  CMPB    ,X              ; same signed B,U addressing as USCHR's B,X
        BHS     UNEND
        LDA     B,U
        RTS
UNEND   CLRA
        RTS
UNFLAG  ORA     <USFLG
        STA     <USFLG
        RTS

UNDOLL  CMPA    #'$'
        BNE     UNINT
        LDA     #8
        BSR     UNPAIR
UNINT   CMPA    #'#'
        BEQ     UNPLACE
        CMPA    #','
        BNE     UNPOINT
        LDA     #2
        BSR     UNFLAG
UNPLACE INC     <USNB
        BSR     UNNEXT
        BRA     UNINT
UNPOINT CMPA    #'.'
        BNE     UNEXP
        LDA     #1
        BSR     UNFLAG
UNFRAC  BSR     UNNEXT
        CMPA    #'#'
        BNE     UNEXP
        INC     <USNA
        BRA     UNFRAC
UNEXP   CMPA    #'^'
        BNE     UNSIGN
        PSHS    B               ; all four carets, or consume none
        LDY     #4
UNCARET CMPA    #'^'
        BNE     UNBACK
        BSR     UNNEXT
        LEAY    -1,Y
        BNE     UNCARET
        LEAS    1,S
        PSHS    A
        LDA     #128
        BSR     UNFLAG
        PULS    A
        BRA     UNSIGN
UNBACK  PULS    B
        BRA     UNDONE          ; the current character is a caret
UNSIGN  CMPA    #'-'
        BEQ     UNMINUS
        CMPA    #'+'
        BNE     UNDONE
        LDA     <USFLG
        BITA    #16
        BNE     UNDONE
        LDA     #32
        BRA     UNTRAIL
UNMINUS LDA     #64
UNTRAIL BSR     UNFLAG
        INCB
UNDONE  STB     <USPOS
        BRA     USFMT
* USFMT: the number into FBUFFR, then printed in the field
USFMT   CLR     <USNEG
        TST     <FACSGN
        BPL     UM1
        COM     <USNEG
        CLR     <FACSGN
UM1     LDA     <USFLG
        BMI     UMEXP
        LDB     #9              ; 1E9 and up: % and the number as PRINT has it, its sign dropped, whatever the
        JSR     FCMPP           ; field ("##";1E9 is "% 1E+09", "##.##";1E20 "% 1E+20", "#####.##";-7.4E19
        LBLE    UMOV2           ; "% 7.4E+19") [BB bb10 using-exp-edge, num-print-big]
        LDB     <USNA           ; round to the decimals: |x| x 10^na + .5, whole
        CMPB    #17
        LBHI    FCERR
        JSR     FMULP
        LDX     #FPHALF
        JSR     FADDX
        JSR     FTRUNC
        LDA     <FACEXP
        CMPA    #160
        BHI     UMOV
        JSR     QINT
        JSR     U32DEC          ; X = the digits, B = how many
        LBRA    UMBODY
* Too large for 32 bits once scaled (the number below 1E9): FOUT's nine digits and zeros after them, in the field
* as any other (too wide for it: after a %), so "#####.#####" prints 100000.5 as "%100000.50000" and 99999.5 as
* "99999.50000" [BB bb9 print-using-odd]. From 2^66 on (more than 20 digits): % and the scaled number as PRINT
* has it, its sign dropped [OWN].
UMOV    CMPA    #128+66
        BHI     UMOV2
        INC     <FONINE
        JSR     FOUT            ; nine digits in FPDIG, the exponent of the first in FPE10 (9 to 19)
        CLR     <FONINE
        LDX     #FBUFFR
        LDU     #FPDIG
        LDB     #9
        JSR     CPYUX
        LDB     <FPE10+1        ; the zeros: FPE10 - 8 of them
        SUBB    #8
        LDA     #'0'
UMOV1   STA     ,X+
        DECB
        BNE     UMOV1
        LDB     <FPE10+1
        INCB
        LDX     #FBUFFR
        LBRA    UMBODY
UMOV2   JSR     FOUT
        LDA     #'%'
        JSR     <ZCHROUT
        JMP     <ZPRTSTR
* E notation: with no + or - in the field, its first place is the sign's, so "##.##^^^^" prints 12345 as
* " 1.23E+04" [BB bb1 print-using]. When that place is the last before the point it shows 0 for a positive number
* ("#.##^^^^": 0.12E+04, -.12E+04); with no # before the point it is the first after it, always 0, and a - does
* not fit (".##^^^^": .01E+05, %-.01E+05) [BB bb2 print-using-exp]
UMEXP   CLRB
        LDA     <USFLG
        BITA    #16+32+64
        BNE     UMX1
        DEC     <USNB           ; (given back before the field is printed; -1 with no # before the point)
        INCB
UMX1    PSHS    B
        LDA     <USNB           ; at most ten places: more is ?FC ERROR [OWN: the real overruns a buffer]
        ADDA    <USNA
        CMPA    #10
        LBHI    FCERR
        INC     <FONINE
        JSR     FOUT            ; nine digits in FPDIG, the exponent of the first in FPE10
        CLR     <FONINE
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
UME4    LDA     #'1'            ; it carried out: 1000... and the 1 in a place more before the point, the
        STA     ,X              ; exponent kept. With a sign's place the 1 takes it: ".##^^^^" prints 999999999
        JSR     E10INC          ; as ".10E+10", "#.##^^^^" as "1.00E+09" [BB bb9 print-using-odd]; with a sign
        DEC     ,S              ; of the field's own the place is one the field does not have (-1 given back
        INC     <USNB           ; below), so it prints after a %: "+.##^^^^" gives "%+1.00E+09" [BB bb10
*                                 using-exp-edge]
        LDB     <USK
        LDA     #'0'
        STA     B,X
UME5    LDD     <FPE10          ; the exponent shown: E - (digits before the point - 1)
        TST     <FACEXP
        BNE     UME6
        CLRA
        CLRB
        STD     <FPE10
        LDA     #'0'            ; (0: zeros)
        LDB     #9
UME5A   STA     ,X+
        DECB
        BNE     UME5A
        CLRA
        CLRB
UME6    LDB     <USNB
        DECB
        NEGB
        SEX
        ADDD    <FPE10
        STD     <USEXP
        LDX     #FBUFFR+20      ; build: digits, point, E+nn
        LDU     #FPDIG
        LDB     <USNB
        BMI     UME9            ; the sign's place after the point
        BNE     UME8
        LDA     ,S              ; the sign's place last before the point: 0 for a positive number (1 + 0)
        ADDA    <USNEG
        DECA
        BNE     UME8
        LDA     #'0'
        STA     ,X+
UME8    JSR     CPYUX
        LDA     <USFLG
        BITA    #1
        BEQ     UME11
        LDA     #'.'
        STA     ,X+
        LDB     <USNA
UME10   JSR     CPYUX
UME11   CMPU    #FPDIG+9        ; a tenth place before the point shows nothing: the body is one shorter and lies
        BLS     UME11A          ; a place further right, the exponent still counted for ten ("###########^^^^"
        LDA     <USFLG          ; prints 1 as "  100000000E-09", ten times too small) [BB bb2 print-using-exp];
        BITA    #1              ; after the point it is a 0 ("#######.####^^^^" prints 12345 as
        BEQ     UME11B          ; " 123450.0000E-01") [BB bb3 print-using-exp]
        TST     <USNA           ; (no place after the point: as with none)
        BEQ     UME11B
        LDA     #'0'
        STA     -1,X
        BRA     UME11A
UME11B  LEAX    -1,X
UME11A  TFR     X,U
        LDD     <USEXP
        JSR     EXPOUT
        TFR     U,D
        SUBD    #FBUFFR+20
        LDX     #FBUFFR+20
        LDA     <USFLG
        ANDA    #$FD            ; (no commas in E notation)
        STA     <USFLG
        PULS    A               ; the sign's place back in the field
        ADDA    <USNB
        STA     <USNB
        BRA     UMOUT2
UME9    LDD     #$2E30          ; .0 and the other places
        STD     ,X++
        LDB     <USNA
        DECB
        BRA     UME10
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
UMB1    LDA     ,X+
        STA     ,U+
        DECB
        BEQ     UMB2
        LDA     <USFLG
        BITA    #2
        BEQ     UMB1
        TFR     B,A
UMB1B   SUBA    #3
        BHI     UMB1B
        BNE     UMB1
        LDA     #','
        STA     ,U+
        BRA     UMB1
UMB2    LDA     <USFLG
        BITA    #1
        BEQ     UMB5
        LDA     #'.'
        STA     ,U+
        LDB     <USNA           ; copy the digits present, with any missing leading zeros
        SUBB    ,S
        BLS     UMB4
        LDA     #'0'
UMB3    STA     ,U+
        DECB
        BNE     UMB3
        LDB     ,S
        BRA     UMB4A
UMB4    LDB     <USNA
UMB4A   TSTB
        BEQ     UMB5
        JSR     CPYXU
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
        JSR     <ZCHROUT
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
UMO8A   JSR     <ZCHROUT
        DEC     ,S
        BNE     UMO8
        LEAS    1,S
UMO9    BITB    #16             ; + first
        BEQ     UMO10
        BSR     USSIGN
UMO10   BITB    #16+32+64
        BNE     UMO11
        TST     <USNEG
        BEQ     UMO11
        LDA     #'-'
        JSR     <ZCHROUT
UMO11   BITB    #8
        BEQ     UMO12
        LDA     #'$'
        JSR     <ZCHROUT
UMO12   PSHS    B
        LDB     <USK
        JSR     PRTN
        PULS    B
        BITB    #32             ; + last
        BEQ     UMO13
        BSR     USSIGN
UMO13   BITB    #64             ; - last: a space for a positive value
        BEQ     UMO14
        LDA     #' '
        BRA     USGSIGN
UMO14   RTS
USSIGN  LDA     #'+'
USGSIGN TST     <USNEG
        BEQ     USG1
        LDA     #'-'
USG1    JMP     <ZCHROUT

* U32DEC: FACM (32 bits) in decimal: X = the digits (no leading zeros, at least one; the last at FBUFFR+18),
* B = how many. Each digit is the remainder of FACM / 10, a byte of FACM at a time. Uses U and FPND (the count).
* U32DU: the same with the digits ending just below U (FOUT's nine, into FPDIG).
U32DEC  LDU     #FBUFFR+19      ; the digits, from the last backwards
U32DU   CLR     <FPND
UD1     LDX     #FACM-1
UD0     LEAX    1,X             ; the leading bytes that are 0 are skipped (the last is always divided)
        CMPX    #FACM+3
        BEQ     UD1A
        TST     ,X
        BEQ     UD0
UD1A    CLRA                    ; the remainder
UD2     LDB     #8
UD3     ASL     ,X
        ROLA
        CMPA    #10
        BLO     UD4
        SUBA    #10
        INC     ,X
UD4     DECB
        BNE     UD3
        LEAX    1,X
        CMPX    #FACM+4
        BNE     UD2
        ADDA    #'0'
        STA     ,-U
        INC     <FPND
        LDD     <FACM
        BNE     UD1
        LDD     <FACM+2
        BNE     UD1
        LDB     <FPND
        TFR     U,X
        RTS
