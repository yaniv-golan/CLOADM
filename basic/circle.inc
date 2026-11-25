* ---------------- CIRCLE ----------------
* docs/clean-room-basic-p2.md section 5 [OWN, a general published method]: a polygon of 64 chords drawn with the
* line routine, its corners at whole 1/64 turns. Corner j is x = cx + r cos(j/64 turn), y = cy + r h sin(j/64 turn)
* (y grows downwards, so the turn goes clockwise on the screen and a quarter is at the bottom [UM; BB]), each offset
* rounded to the nearest whole point (ADJUST). The sine of 0-15 sixty-fourths of a turn is SINTAB (8-bit fractions,
* tools/basic-consts.js); a quarter turn (16) is 1 exactly.
        INCLUDE "sine.inc"

* CIRCLE (x,y),r[,c[,h[,s,e]]] [UM]: radius r (0-255), colour c (the foreground by default), height/width ratio h
* (0-4, 1 by default), start and end s and e (0-1 of a turn, from the right; 0 and 1 by default), each taken to the
* nearest 1/64 turn (ADJUST); an end at or before the start goes on past 0, and the same start and end draw the whole
* circle [OWN; BB]. ?FC ERROR for a value out of its range [BB]. Corners off the picture are clipped as LINETO
* clips. The last point is left as it was [OWN; BB]. Work: TMPPTR r h, TMPPT2 r (as words), TMPCNT the chords
* left and the corner.
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
        CMPD    #$400
        BHI     CIFC
        PSHS    D
        LDB     #7              ; s x 128
        LDU     #0
        BSR     OPTFIX
        BSR     TURN
        PSHS    B
        LDB     #7              ; e x 128
        LDU     #128
        BSR     OPTFIX
        BSR     TURN
        SUBB    ,S              ; the chords: (e - s) mod 64, 0 meaning 64
        ANDB    #63
        BNE     CI2
        LDB     #64
CI2     PULS    A
        STB     <TMPCNT
        STA     <TMPCNT+1
        PULS    D               ; h
        LEAX    ,S
        BSR     MULF            ; r h
        STD     <TMPPTR
        PULS    B
        CLRA
        STD     <TMPPT2         ; r
        LDX     LASTX
        LDY     LASTY
        PSHS    X,Y
        LDA     <TMPCNT+1
        BSR     CPOINT
        STX     LASTX
        STY     LASTY
CI3     INC     <TMPCNT+1
        LDA     <TMPCNT+1
        BSR     CPOINT
        JSR     LINETO
        DEC     <TMPCNT
        BNE     CI3
        PULS    X,Y
        JMP     BF0
CIFC    JMP     FCERR

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

* TURN: D = a part of a turn x 128 (at most 128, ?FC ERROR) -> B = the nearest 1/64 turn (ADJUST)
TURN    CMPD    #128
        BHI     CIFC
        ADDD    #1
        LSRB
        RTS

* SCAL: D = D x the fraction at X / 256, rounded; X = SINTAB+16 is 1. MULF: the same for any fraction.
SCAL    CMPX    #SINTAB+16
        BEQ     MF1
MULF    PSHS    D
        LDA     1,S
        LDB     ,X
        MUL
        ADDD    #128
        STA     1,S
        LDA     ,S
        LDB     ,X
        MUL
        ADDB    1,S
        ADCA    #0
        LEAS    2,S
MF1     RTS

* CPOINT: corner A (in 1/64 turns, taken mod 64) -> X, Y
CPOINT  PSHS    A
        LDU     #TMPPT2
        ADDA    #16             ; the cosine: a quarter turn on
        BSR     SINOFF
        ADDD    GXY
        PSHS    D
        LDA     2,S
        LDU     #TMPPTR
        BSR     SINOFF
        ADDD    GXY+2
        TFR     D,Y
        PULS    X
        LEAS    1,S
        RTS

* SINOFF: D = the word at U x sin(A/64 turn), rounded to the nearest whole number (ADJUST)
SINOFF  PSHS    A
        ANDA    #15
        LDB     ,S
        BITB    #16
        BEQ     SN1
        NEGA                    ; the second and fourth quarters run backwards
        ADDA    #16
SN1     LDX     #SINTAB
        LEAX    A,X
        LDD     ,U
        BSR     SCAL
        PSHS    D
        LDA     2,S
        BITA    #32             ; the third and fourth quarters are negative
        PULS    D
        BEQ     SN2
        JSR     NEGD
SN2     LEAS    1,S
        RTS
