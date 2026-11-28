* ---------------- LINE: lines, boxes and filled boxes ----------------
* docs/clean-room-basic-p2.md section 5. One line routine (LINETO) draws for LINE, DRAW and CIRCLE, in the mode's
* own pixels; one span filler (HSPAN) fills for BF and PAINT. The algorithms are general published ones, their
* details aligned with the original's black-box pictures (bb2 gfx-line, gfx-circle, gfx-clip).

* GPRANGE: map both endpoints into mode pixels before sorting (C set: divide by two).
GPRANGE BCC     SORT
        LSRA
        LSRB
* SORT: A = the smaller of A and B, B the larger
SORT    PSHS    B
        CMPA    ,S+
        BLS     SO1
        EXG     A,B
SO1     RTS

* ENDPT: '-' and a point (x,y) into the 4 bytes at U, and the ')'
ENDPT   LDB     #T_MINUS
        JSR     SYNCHR
        JSR     GETXY
        JMP     <ZRPAREN

* HSPAN: fill from the pixel of mask A in the byte at X to the pixel of mask B in the byte at U (not before it) in
* GCOLB: the end bytes through masks, whole bytes between (keeps Y)
HSPAN   PSHS    B,U
        NEGB                    ; the right end's pixel and those to its left
        ORB     ,S
        STB     ,S
        PSHS    A
        DECA                    ; the left end's pixel and those to its right
        ORA     ,S+
HS1     CMPX    1,S
        BNE     HS2
        ANDA    ,S
HS2     JSR     PLOTM
        CMPX    1,S
        BEQ     HS3
        LEAX    1,X
        LDA     #$FF
        BRA     HS1
HS3     PULS    B,U,PC

* BF: every row from y1 to y2, from x1 to x2 [UM]
BFILL   JSR     <ZCHRGET
        LDB     <LASTY+1
        PSHS    B
        TFR     Y,D
        LDA     ,S+
        BSR     SORT
        STA     <TMPPTR+1       ; the row
        PSHS    B               ; the last row
        TFR     X,D
        LDA     <LASTX+1
        BSR     SORT
        PSHS    D               ; the left and right ends
        BSR     BF0
BF1     LDA     1,S
        LDB     <TMPPTR+1
        JSR     GPIXAD          ; the right end
        PSHS    A,X
        LDA     3,S
        LDB     <TMPPTR+1
        JSR     GPIXAD          ; the left end
        PULS    B,U
        BSR     HSPAN
        LDA     <TMPPTR+1
        INC     <TMPPTR+1
        CMPA    2,S
        BNE     BF1
        LEAS    3,S
        RTS
BF0     STX     <LASTX
        STY     <LASTY
        RTS

* LINE [(x1,y1)]-(x2,y2),PSET|PRESET[,B|BF] [UM]: from the last point when the start is left out; PSET draws in
* the foreground colour, PRESET in the background. B draws the box with those corners, BF fills it. The corners
* are read as PSET's (clamped to the picture); PSET or PRESET left out, or another word, or anything but B or BF
* after its ',': ?SN ERROR [UM; BB bb2 gfx-errors]. The last point ends at (x2,y2) [OWN; BB].
GLINE   CMPA    #'('
        BNE     GL1
        JSR     LSTXY
        JSR     <ZRPAREN
GL1     LEAS    -4,S
        LEAU    ,S
        BSR     ENDPT
        JSR     <ZCOMMA
        LDB     <FGCOL
        CMPA    #T_PSET
        BEQ     GL2
        LDB     <BGCOL
        CMPA    #T_PRESET
        BNE     GLSN
GL2     JSR     COLVAL
        STB     <GCOLB
        JSR     <ZCHRGET
        PULS    X,Y             ; the end
        CMPA    #','
        BNE     LINETO
        JSR     <ZCHRGET
        CMPA    #'B'
        BNE     GLSN
        JSR     <ZCHRGET
        CMPA    #'F'
        BEQ     BFILL
* the box: (x1,y1) to (x2,y1), (x2,y2), (x1,y2) and back [OWN; BB the order, which no picture shows]
        LDD     <LASTY
        LDU     <LASTX
        PSHS    D,U,X,Y         ; 0,S y1, 2,S x2, 4,S y2, 6,S x1
        LDY     ,S
        BSR     LINETO          ; (x2,y1)
        LDX     2,S
        LDY     4,S
        BSR     LINETO          ; (x2,y2)
        LDX     6,S
        LDY     4,S
        BSR     LINETO          ; (x1,y2)
        LDX     6,S
        LDY     ,S
        BSR     LINETO          ; (x1,y1)
        LEAS    2,S
        PULS    X,Y,U
        BRA     BF0
GLSN    JMP     <ZSNERR

* LINETO: a line from the last point to (X, Y), 16-bit signed, in the colour byte GCOLB; the last point ends at
* (X, Y). Both ends are first clamped to the picture (x 0-255, y 0-191), so a line to a point off the picture runs
* along its edge and the last point ends on it [BB bb2 gfx-clip: circles past each edge draw along it, DRAW "F30"
* from 240,180 ends at 255,191]. The line is drawn in the mode's own pixels [BB bb2 gfx-line, gfx-defaults: in
* PMODE 0-3 the ends are halved as the mode halves each axis, and the steps are whole pixels of the mode]: a halved
* axis runs on even values in steps of 2, from its ends with their low bits cleared. Bresenham's integer algorithm:
* step along the major axis (x when the deltas are equal); the error term starts at half the major delta, less one
* half when the major axis runs forwards (so a point exactly half way between two rows or columns goes to the one
* further along, as if the line were always drawn towards the major axis's larger end [BB bb2 gfx-line pmode3-lines
* and the chords of gfx-circle]), loses the minor delta at each step, and when it goes negative gets the major delta
* back and the minor axis steps. Both ends are drawn.
LINETO  PSHS    X,Y             ; the clamped end is restored to LASTX/LASTY after drawing
        LDX     <GMENT
        LDA     2,X
        PSHS    A               ; mode bits, consumed x first, then y
        LEAS    -8,S            ; two records: byte delta, signed byte step, pointer to coordinate's low byte
        LEAY    ,S
        LEAX    9,S             ; destination x (then y)
        LDU     #LASTX          ; starting x (then y)
        LDB     #255
        BSR     LNAXIS
        LDB     #191
        BSR     LNAXIS
        LEAU    ,S
        LEAY    4,S
        LDA     ,Y              ; Y major, U minor; x wins ties
        CMPA    ,U
        BHI     LT1
        EXG     U,Y
        LDA     ,Y
LT1     PSHS    A               ; steps remaining
        TST     1,Y
        BMI     LT1A
        DECA
LT1A    LSRA
        PSHS    A               ; unsigned error, below the major delta when a step remains
LT2     LDA     <LASTX+1
        LDB     <LASTY+1
        JSR     PLOT
        TST     1,S
        BEQ     LT4
        DEC     1,S
        LDA     ,S
        SUBA    ,U
        BCC     LT3
        ADDA    ,Y              ; borrow: wrap back into [0, major)
        LDB     [2,U]
        ADDB    1,U
        STB     [2,U]
LT3     STA     ,S
        LDB     [2,Y]
        ADDB    1,Y
        STB     [2,Y]
        BRA     LT2
LT4     LEAS    11,S
        PULS    X,Y
        JMP     BF0

* LNAXIS: clamp start U and destination X to 0..B, then fill the record at Y.
* Advance the three pointers to their next entries. The saved destination stays
* in full coordinates even when the raster uses only even positions.
LNAXIS  BSR     LNCLIP
        EXG     X,U
        BSR     LNCLIP
        LEAX    1,X
        STX     2,Y
        LDA     1,U
        LDB     #1
        LSR     10,S            ; mode byte, above the two records and return address
        BCC     LA1
        ANDA    #$FE
        LSR     ,X
        ASL     ,X
        INCB
LA1     SUBA    ,X
        BCC     LA2
        NEGA
        NEGB
LA2     STB     1,Y
        BITB    #1              ; an even step in either direction is a halved axis
        BNE     LA3
        LSRA
LA3     STA     ,Y
        LEAY    4,Y
        LEAX    1,X
        LEAU    2,U
        EXG     X,U
        RTS

* Clip the signed coordinate at X to the inclusive byte bound B.
LNCLIP  LDA     ,X
        BMI     LCZERO
        BNE     LCMAX
        CMPB    1,X
        BHS     LCDONE
LCMAX   STB     1,X
        CLR     ,X
LCDONE  RTS
LCZERO  CLR     ,X
        CLR     1,X
        RTS
* NEGD: D = -D
NEGD    COMA
        COMB
        ADDD    #1
        RTS
