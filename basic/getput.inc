* ---------------- GET and PUT ----------------
* docs/clean-room-basic-p2.md section 8. The rectangle is taken in the mode's own pixels (corners in 256 x 192
* coordinates, clamped to the picture and halved where the mode halves them). Its bits (1 or 2 a pixel), row by row
* with no bits left over at a row's end, are packed into the numeric array's elements as plain bytes, from the first
* element's first byte on [BB bb2 gfx-getarray put-numbers, gfx-getput pmode4-coarse]; the bits after the last
* pixel's are left as they were [OWN]. GET with G is exact to the pixel; without it, the rectangle is widened to
* the whole bytes its ends are in [BB bb2 gfx-getput]. After GET, an element of the array is ?BS ERROR [BB bb2
* gfx-getarray: PRINT A(0) after GET]: GET sets bit 7 of the array's count of dimensions, which the element lookup
* then never matches, and the header's length is taken from the other 7 bits [OWN]. An array too small for the
* rectangle: ?FC ERROR [OWN, by whole bytes a row]; one not DIMmed: ?FC ERROR [BB bb2 gfx-errors].
* PUT's actions [UM]: PSET copies, PRESET copies inverted, AND and OR combine with the screen, NOT inverts the
* screen; PSET when none is given [UM; BB bb2 gfx-getput]; any other word: ?SN ERROR. The rectangles of GET and PUT
* are each the corners given: PUT does not take its size from the array.
* Work: TMPPTR the array's next byte (GPRB its next bit), BINVAL the bits a row, TMPCNT BITCPY's two masks.
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
        JSR     <ZRPAREN
        LEAS    -4,S
        LEAU    ,S
        JSR     ENDPT
        JSR     COMMA
        JSR     VNAME
        JSR     <ZCHKNUM
        JSR     GPARY
        PSHS    X               ; 0,S the array, 2,S x2, 4,S y2
        LDB     #%11100         ; (GET copies the screen as PSET does; bit 4: GET without G, PUT with no action)
        JSR     <ZCHKCOM
        BNE     GQ4
        JSR     <ZCHRGET
        TST     <GPDIR
        BEQ     GQ1
        LDB     #%1100
        CMPA    #'G'
        BEQ     GQ3
GPSN    JMP     <ZSNERR
GQ1     LDX     #GPACT
GQ2     CMPA    ,X++
        BEQ     GQ2A
        TST     ,X
        BNE     GQ2
        BRA     GPSN
GQ2A    LDB     -1,X
GQ3     JSR     <ZCHRGET
GQ4     STB     <GPLUT
* the columns, in the mode's own pixels; GET without G takes whole bytes: its rectangle widened to the bytes its ends
* are in [BB bb2 gfx-getput pmode4-coarse: GET(19,17)-(28,30) without G holds x 16-31]
        LDU     <GMENT
        LDA     <GXY+1
        LDB     3,S
        JSR     SORT
        PSHS    D
        LDA     2,U
        LSRA                    ; C: x is halved
        BCC     GQ5
        LSR     ,S
        LSR     1,S
GQ5     LDA     <GPLUT
        ANDA    <GPDIR
        BITA    #$10
        BEQ     GQ5B            ; not GET without G
        LDA     #7              ; the pixels a byte - 1
        LDB     3,U
        ASLB
        BPL     GQ5A
        LDA     #3
GQ5A    TFR     A,B
        ORB     1,S
        STB     1,S
        COMA
        ANDA    ,S
        STA     ,S
GQ5B    PULS    D
        STA     <GXY+1
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
* the rows, in the mode's own pixels
        LDA     <GXY+3
        LDB     5,S
        JSR     SORT
        PSHS    D
        LDA     2,U
        BITA    #2              ; y is halved
        BEQ     GQ7
        LSR     ,S
        LSR     1,S
GQ7     PULS    D
        STA     <GXY+3
        PSHS    A
        SUBB    ,S+
        INCB
        STB     <GPROWS
        TFR     B,A
* the array must hold rows x bytes a row [OWN]
        LDB     <GPRB
        MUL
        PSHS    D
        LDX     2,S
        LDB     4,X             ; its dimensions (bit 7: GET has used it)
        ASLB
        ADDB    #5              ; its header's length
        PSHS    B
        LDD     2,X
        SUBB    ,S
        SBCA    #0              ; the elements' bytes
        CMPD    1,S
        BLO     GPFC
        TST     <GPDIR
        BEQ     GQ7A
        LDA     4,X             ; GET: an element of the array is ?BS ERROR from now on [BB bb2 gfx-getarray]
        ORA     #$80
        STA     4,X
GQ7A    PULS    B
        ABX
        STX     <GPBUF
        LDA     #$80
        STA     <GPRB           ; the array's next bit
        LEAS    2,S
* each row: GET from the screen to the array, PUT from the array to the screen; the array's bits run on from one
* row to the next, with no bits left over at a row's end [BB bb2 gfx-getput pmode4-coarse, the PUT of a 10-pixel
* wide rectangle]
GQ8     LDA     <GXY+1
        LDB     <GXY+3
        JSR     GPIXM
        TFR     A,B
        LSRB
        PSHS    A
        ANDB    ,S
        EORB    ,S+             ; the pixel's first bit
        LDA     <GPRB
        LDU     <GPBUF
        TST     <GPDIR
        BNE     GQ9
        EXG     X,U
        EXG     A,B
GQ9     STD     <DMASK          ; (and SMASK)
        LDY     <BINVAL
        BSR     BITCPY
        LDA     <SMASK          ; PUT: the array is the source
        TST     <GPDIR
        BEQ     GQ9A
        EXG     X,U             ; GET: the array is the destination
        LDA     <DMASK
GQ9A    STX     <GPBUF
        STA     <GPRB
        INC     <GXY+3
        DEC     <GPROWS
        BNE     GQ8
        LEAS    6,S
        RTS
GPFC    JMP     <ZFCERR

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

* GPARY: X = the numeric array VARNAM (its name, size, dimensions...); ?FC ERROR if there is none [BB bb2
* gfx-errors: GET into an array not DIMmed]
GPARY   LDX     <ARYTAB
GA1     CMPX    <ARYEND
        BHS     GPFC
        LDD     ,X
        CMPD    <VARNAM
        BEQ     GA3
        LDD     2,X
        LEAX    D,X
        BRA     GA1
GA3     RTS
