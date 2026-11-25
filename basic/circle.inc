* ---------------- CIRCLE ----------------
* docs/clean-room-basic-p2.md section 5. A polygon of 64 chords drawn with the line routine, its corners at whole
* 1/64 turns from the right, clockwise on the screen (y grows downwards), in the mode's own pixels [BB bb2
* gfx-circle: every picture of radii, ratios, arcs, PMODE 0 and PMODE 3 matches this rule pixel for pixel]: the
* centre and the radius are halved where the mode halves x (the centre's y where it halves y); corner j is
* x = r cos(j), y = (r sin(j)) h, each product rounded towards 0 (r sin(j) before it is multiplied by h), with h
* doubled when the mode halves x alone (its pixels are twice as wide as high). The sine of 0-15 sixty-fourths of a
* turn is SINTAB (16-bit fractions, rounded down, tools/basic-consts.js); a quarter turn (16) is 1 exactly.
        INCLUDE "sine.inc"
CONE    FDB     $0100           ; (1 in 8.8: the x offset's scale)

* CIRCLE (x,y),r[,c[,h[,s,e]]] [UM]: radius r (0-255), colour c (the foreground by default), height/width ratio h
* (1 by default; 8.8 fixed point, its fraction below 1/256 dropped, below 256), start and end s and e (0 and 1 by
* default, of a turn), each taken down to its 1/64 turn and that mod 64 [BB bb2 gfx-circle arcs, gfx-errors: .01
* draws the whole circle, h 5 and s 1.5 are no error]; an end at or before the start goes on past 0, and the same
* start and end draw the whole circle. Corners off the picture are clipped as LINETO clips. The last point is left
* as it was [OWN; BB]. Work: TMPPTR h x 256, TMPPT2 r, TMPCNT the chords left and the corner.
CIRCLE  LDU     #GXY
        JSR     GETXY
        JSR     RPAREN
        JSR     COMBYT          ; r
        PSHS    B
        LDB     FGCOL
        JSR     <ZCHKCOM
        BNE     CI1
        JSR     GETCOL
CI1     JSR     COLVAL
        STB     <GCOLB
        LDB     #8              ; h x 256
        LDU     #$100
        BSR     OPTFIX
        STD     <TMPPTR
        LDB     #6              ; s x 64
        LDU     #0
        BSR     OPTFIX
        PSHS    B
        LDB     #6              ; e x 64
        LDU     #64
        BSR     OPTFIX
        SUBB    ,S              ; the chords: (e - s) mod 64, 0 meaning 64
        ANDB    #63
        BNE     CI2
        LDB     #64
CI2     PULS    A
        STB     <TMPCNT
        STA     <TMPCNT+1
* in the mode's own pixels
        LDX     <GMENT
        LDA     2,X
        ANDA    #3
        LSRA                    ; C: x halved; A: 1 if y is halved too
        BCC     CI4
        LSR     ,S              ; r
        LSR     GXY+1           ; the centre's x
        TSTA
        BNE     CI3
        ASL     <TMPPTR+1       ; h x 2
        ROL     <TMPPTR
        BRA     CI4
CI3     LSR     GXY+3           ; the centre's y
CI4     PULS    B
        STB     <TMPPT2
        LDX     LASTX
        LDY     LASTY
        PSHS    X,Y
        LDA     <TMPCNT+1
        BSR     CPOINT
        STX     LASTX
        STY     LASTY
CI5     INC     <TMPCNT+1
        LDA     <TMPCNT+1
        BSR     CPOINT
        JSR     LINETO
        DEC     <TMPCNT
        BNE     CI5
        PULS    X,Y
        JMP     BF0

* OPTFIX: an optional ', number' (U when there is none) x 2^B, its fraction dropped: D (?FC ERROR if negative or
* 65536 or more)
OPTFIX  JSR     <ZCHKCOM
        BNE     OF2
        PSHS    B
        JSR     <ZCHRGET
        JSR     <ZEVNUM
        PULS    B
        LDA     <FACEXP
        BEQ     OF1
        PSHS    B
        ADDA    ,S+
        BCS     CIFC
        STA     <FACEXP
OF1     JMP     GETADR
OF2     TFR     U,D
        RTS
CIFC    JMP     FCERR

* MULW: D = B x the word at X / 256, rounded down
MULW    PSHS    B
        LDA     1,X
        MUL
        PSHS    A
        LDA     ,X
        LDB     1,S
        MUL
        ADDB    ,S+
        ADCA    #0
        LEAS    1,S
        RTS

* CPOINT: corner A (in 1/64 turns, taken mod 64) -> X, Y, in 256 x 192 coordinates (the mode's pixel doubled
* where the mode halves the axis, as LINETO takes them)
CPOINT  PSHS    A
        ADDA    #16             ; the cosine: a quarter turn on
        LDU     #CONE
        BSR     SINOFF
        ADDD    GXY
        PSHS    D
        LDA     2,S
        LDU     #TMPPTR
        BSR     SINOFF
        ADDD    GXY+2
        TFR     D,Y
        PULS    X
        LDU     <GMENT
        LDB     2,U
        STB     ,S
        LSR     ,S
        BCC     CP1
        TFR     X,D
        LEAX    D,X
CP1     LSR     ,S+
        BCC     CP2
        TFR     Y,D
        LEAY    D,Y
CP2     RTS

* SINOFF: D = r x sin(A/64 turn) rounded towards 0, times the 8.8 word at U rounded towards 0, signed
SINOFF  PSHS    A
        ANDA    #15
        LDB     ,S
        BITB    #16
        BEQ     SN1
        NEGA                    ; the second and fourth quarters run backwards
        ADDA    #16
SN1     LDB     <TMPPT2
        CMPA    #16
        BEQ     SN2             ; a quarter turn: r exactly
        LDX     #SINTAB
        ASLA
        LEAX    A,X
        BSR     MULW
        TFR     A,B
SN2     LEAX    ,U
        BSR     MULW
        PSHS    D
        LDA     2,S
        BITA    #32             ; the third and fourth quarters are negative
        PULS    D
        BEQ     SN3
        JSR     NEGD
SN3     LEAS    1,S
        RTS
