* ---------------- GET and PUT ----------------
* docs/clean-room-basic-p2.md section 8. The rectangle is taken in the mode's own pixels (corners in 256 x 192
* coordinates, halved where the mode halves them), exact to the pixel. Its bits (1 or 2 a pixel), row by row and
* each row from a new byte, are packed into the numeric array's elements as plain bytes, from the first element's
* first byte on [OWN, interim: decision 6 matches the original's layout once the black-box run shows it; only
* GPBUF's start, the row length GPRB and BITCPY's order of bits decide it]. GET's G is accepted and changes nothing:
* without it the rectangle is not made coarser [OWN; BB: the coarse rule is to come from the black-box pictures].
* An array too small for the rectangle: ?FC ERROR; one not DIMmed is made with 11 elements, as any array [BB].
* PUT's actions [UM]: PSET copies, PRESET copies inverted, AND and OR combine with the screen, NOT inverts the
* screen; PSET when none is given [UM; BB]; any other word: ?SN ERROR. The rectangles of GET and PUT are each the
* corners given: PUT does not take its size from the array.
* Work: TMPPTR the next row's place in the array, BINVAL the bits a row, TMPCNT BITCPY's two masks.
DMASK   EQU     TMPCNT
SMASK   EQU     TMPCNT+1
GPBUF   EQU     TMPPTR

* PUT's actions: each a truth table, bit (2 x the array's bit + the screen's bit) the new bit
GPACT   FCB     T_PSET,%1100,T_PRESET,%0011,T_AND,%1000,T_OR,%1110,T_NOT,%0101,0

* GET (x1,y1)-(x2,y2),A[,G]; PUT (x1,y1)-(x2,y2),A[,action] [UM]
GETST   LDB     #$FF
        FCB     $21             ; (BRN: skips the CLRB)
PUTST   CLRB
        STB     <GPDIR
        LDU     #GXY
        JSR     GETXY
        JSR     RPAREN
        LEAS    -4,S
        LEAU    ,S
        JSR     ENDPT
        JSR     COMMA
        JSR     VNAME
        JSR     CHKNUM
        JSR     GPARY
        PSHS    X               ; 0,S the array, 2,S x2, 4,S y2
        LDB     #%1100          ; (GET copies the screen as PSET does)
        JSR     <ZCHKCOM
        BNE     GQ4
        JSR     <ZCHRGET
        TST     <GPDIR
        BEQ     GQ1
        CMPA    #'G'
        BEQ     GQ3
GPSN    JMP     SNERR
GQ1     LDX     #GPACT
GQ2     CMPA    ,X++
        BEQ     GQ2A
        TST     ,X
        BNE     GQ2
        BRA     GPSN
GQ2A    LDB     -1,X
GQ3     JSR     <ZCHRGET
GQ4     STB     <GPLUT
* the columns: the bits a row and the bytes they take
        LDU     <GMENT
        LDA     GXY+1
        LDB     3,S
        JSR     SORT
        STA     GXY+1
        PSHS    D
        LDA     2,U
        LSRA                    ; C: x is halved
        BCC     GQ5
        LSR     ,S
        LSR     1,S
GQ5     PULS    D
        PSHS    A
        SUBB    ,S+
        CLRA
        ADDD    #1              ; the pixels a row
        PSHS    D
        LDA     3,U
        ASLA                    ; N: four colours
        PULS    D
        BPL     GQ6
        ASLB
        ROLA
GQ6     STD     <BINVAL
        ADDD    #7
        LSRA
        RORB
        LSRA
        RORB
        LSRA
        RORB
        STB     <GPRB
* the rows: how many, and the step between them in 256 x 192 coordinates
        LDA     GXY+3
        LDB     5,S
        JSR     SORT
        STA     GXY+3
        PSHS    D
        LDB     #1
        LDA     2,U
        BITA    #2              ; y is halved
        BEQ     GQ7
        ASLB
        LSR     ,S
        LSR     1,S
GQ7     STB     <GPSTEP
        PULS    D
        PSHS    A
        SUBB    ,S+
        INCB
        STB     <GPROWS
        TFR     B,A
* the array must hold rows x bytes a row
        LDB     <GPRB
        MUL
        PSHS    D
        LDX     2,S
        LDB     4,X             ; its dimensions
        ASLB
        ADDB    #5              ; its header's length
        PSHS    B
        LDD     2,X
        SUBB    ,S
        SBCA    #0              ; the elements' bytes
        CMPD    1,S
        BLO     GPFC
        PULS    B
        ABX
        STX     <GPBUF
        PULS    Y
        TST     <GPDIR
        BEQ     GQ8
GQ6A    CLR     ,X+             ; GET: the bits after a row's last pixel are 0 [OWN]
        LEAY    -1,Y
        BNE     GQ6A
* each row: GET from the screen to the array, PUT from the array to the screen
GQ8     LDA     GXY+1
        LDB     GXY+3
        JSR     GPIXAD
        TFR     A,B
        LSRB
        PSHS    A
        ANDB    ,S
        EORB    ,S+             ; the pixel's first bit
        LDA     #$80
        LDU     <GPBUF
        TST     <GPDIR
        BNE     GQ9
        EXG     X,U
        EXG     A,B
GQ9     STD     <DMASK          ; (and SMASK)
        LDY     <BINVAL
        BSR     BITCPY
        LDB     <GPRB
        LDX     <GPBUF
        ABX
        STX     <GPBUF
        LDA     GXY+3
        ADDA    <GPSTEP
        STA     GXY+3
        DEC     <GPROWS
        BNE     GQ8
        LEAS    6,S
        RTS
GPFC    JMP     FCERR

* BITCPY: Y bits from X (from bit SMASK on) to U (from bit DMASK on), each new bit GPLUT's for the two old ones
BITCPY  CLRB
        LDA     ,X
        ANDA    <SMASK
        BEQ     BC1
        LDB     #2
BC1     LDA     ,U
        ANDA    <DMASK
        BEQ     BC2
        INCB
BC2     LDA     <GPLUT
BC3     DECB
        BMI     BC4
        LSRA
        BRA     BC3
BC4     LDB     <DMASK
        LSRA
        BCS     BC5
        COMB
        ANDB    ,U
        FCB     $8C             ; (CMPX #: skips the ORB)
BC5     ORB     ,U
        STB     ,U
        LSR     <SMASK
        BNE     BC6
        ROR     <SMASK
        LEAX    1,X
BC6     LSR     <DMASK
        BNE     BC7
        ROR     <DMASK
        LEAU    1,U
BC7     LEAY    -1,Y
        BNE     BITCPY
        RTS

* GPARY: X = the numeric array VARNAM (its name, size, dimensions...), made with 11 elements if there is none
GPARY   LDX     <ARYTAB
GA1     CMPX    <ARYEND
        BHS     GA2
        LDD     ,X
        CMPD    <VARNAM
        BEQ     GA3
        LDD     2,X
        LEAX    D,X
        BRA     GA1
GA2     BSR     GA4
        BRA     GPARY
* GA4: make it as a reference A(0) would: ARYGET's frame (the name, VALTYP and DIMFLG 0, one subscript 0)
GA4     LDD     <VARNAM
        PSHS    D
        CLRA
        CLRB
        PSHS    D
        PSHS    D
        INCB
        JMP     AGLOOK
GA3     RTS
