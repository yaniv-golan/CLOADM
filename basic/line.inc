* ---------------- LINE: lines, boxes and filled boxes ----------------
* docs/clean-room-basic-p2.md section 5. One line routine (LINETO) draws for LINE, DRAW and CIRCLE, in the mode's
* own pixels; one span filler (HSPAN) fills for BF and PAINT. The algorithms are general published ones, their
* details aligned with the original's black-box pictures (bb2 gfx-line, gfx-circle, gfx-clip).

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
        JMP     RPAREN

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
        LDB     LASTY+1
        PSHS    B
        TFR     Y,D
        LDA     ,S+
        BSR     SORT
        STA     <TMPPTR+1       ; the row
        PSHS    B               ; the last row
        TFR     X,D
        LDA     LASTX+1
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
BF0     STX     LASTX
        STY     LASTY
        RTS

* LINE [(x1,y1)]-(x2,y2),PSET|PRESET[,B|BF] [UM]: from the last point when the start is left out; PSET draws in
* the foreground colour, PRESET in the background. B draws the box with those corners, BF fills it. The corners
* are read as PSET's (clamped to the picture); PSET or PRESET left out, or another word, or anything but B or BF
* after its ',': ?SN ERROR [UM; BB bb2 gfx-errors]. The last point ends at (x2,y2) [OWN; BB].
GLINE   CMPA    #'('
        BNE     GL1
        JSR     LSTXY
        JSR     RPAREN
GL1     LEAS    -4,S
        LEAU    ,S
        BSR     ENDPT
        JSR     COMMA
        LDB     FGCOL
        CMPA    #T_PSET
        BEQ     GL2
        LDB     BGCOL
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
        LDD     LASTY
        LDU     LASTX
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
GLSN    JMP     SNERR

* CLMPU: the signed word at U clamped to 0-X (keeps X)
CLMPU   LDD     ,U
        BPL     CU1
        CLRA
        CLRB
CU1     PSHS    X
        CMPD    ,S++
        BLE     CU2
        TFR     X,D
CU2     STD     ,U
        RTS

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
LINETO  PSHS    X,Y             ; (12,S and 14,S once the frame is made)
        LDX     #255
        LEAU    ,S
        BSR     CLMPU
        LDU     #LASTX
        BSR     CLMPU
        LDX     #191
        LEAU    2,S
        BSR     CLMPU
        LDU     #LASTY
        BSR     CLMPU
        LDX     <GMENT
        LDB     2,X             ; bit 0: x is halved, bit 1: y is halved
        LEAS    -12,S           ; two axes, 6 bytes each: |delta|, the step, the coordinate's address
        PSHS    B
        LEAY    1,S
        LDU     #LASTX
        LDD     13,S
        BSR     LNAXIS
        LEAY    7,S
        LDU     #LASTY
        LDD     15,S
        BSR     LNAXIS
        LEAS    1,S
        LEAU    ,S              ; U: the minor axis, Y: the major one
        LDD     ,Y
        CMPD    ,U
        BHI     LT1
        EXG     U,Y
        LDD     ,Y
LT1     PSHS    D               ; the steps still to take
        TST     2,Y
        BMI     LT1A            ; the major axis runs downwards
        SUBD    #1
LT1A    LSRA                    ; the error term
        RORB
        PSHS    D
LT2     LDA     LASTX+1
        LDB     LASTY+1
        JSR     PLOT            ; (keeps Y and U)
        LDD     2,S
        SUBD    #1
        BCS     LT4
        STD     2,S
        LDD     ,S
        SUBD    ,U
        STD     ,S
        BPL     LT3
        ADDD    ,Y
        STD     ,S
        LDD     [4,U]
        ADDD    2,U
        STD     [4,U]
LT3     LDD     [4,Y]
        ADDD    2,Y
        STD     [4,Y]
        BRA     LT2
LT4     LEAS    16,S
        PULS    X,Y
        JMP     BF0

* LNAXIS: the axis entry at Y for the end D of the coordinate at U, the axis halved if bit 0 of the byte above the
* return address is set (which it shifts out)
LNAXIS  STU     4,Y
        LDX     #1
        LSR     2,S
        PSHS    CC
        BCC     LA1
        ANDB    #$FE            ; both ends on even values
        PSHS    B
        LDB     1,U
        ANDB    #$FE
        STB     1,U
        PULS    B
LA1     SUBD    ,U
        BPL     LA2
        LEAX    -2,X
        BSR     NEGD
LA2     STX     2,Y
        PULS    CC
        BCC     LA3
        LSRA                    ; the delta in the mode's pixels, the step 2
        RORB
        ASL     3,Y
        ROL     2,Y
LA3     STD     ,Y
        RTS
* NEGD: D = -D
NEGD    COMA
        COMB
        ADDD    #1
        RTS
