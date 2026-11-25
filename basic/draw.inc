* ---------------- DRAW ----------------
* docs/clean-room-basic-p2.md section 6. DRAW s$ [UM] reads its commands with mini.inc and draws from the last point
* with LINETO (so moves off the picture are clipped point by point [OWN; BB]):
*   U D L R E F G H n   a move of n (1 when left out) units up, down, left, right, up-right, down-right, down-left,
*                       up-left; turned by the angle, n x scale / 4 points long (rounded down: ADJUST) [UM; OWN]
*   M x,y               to x,y; M +x,-y (either sign on either part) relative, scaled as a move, not turned [OWN; BB]
*   B, N                prefixes: the next move does not draw; the next move draws, then the point goes back [UM]
*   C n                 the colour, 0-8: it becomes the foreground colour, so it lasts [UM; OWN BB]
*   A n                 the angle, 0-3 quarter turns clockwise; S n the scale, 1-62 quarters [UM]; both last from one
*                       DRAW to the next (4 and 0 at cold start) [UM; BB]
* Anything else, or a value out of range: ?FC ERROR [BB].
DRLET   FCC     "UERFDGLH"      ; the directions, an eighth of a turn apart clockwise
DRVEC   FCB     0,-1,1,-1,1,0,1,1,0,1,-1,1,-1,0,-1,-1      ; their steps in x and y

DRAW    JSR     MSSTR
        LDB     FGCOL
        BSR     DRCOL
        CLR     <DRFLG
DR0     BSR     MSCMD
        BCS     DS9
        BSR     DRONE
        BRA     DR0

* DRCOL: colour B is the foreground and the colour drawn
DRCOL   STB     FGCOL
        JSR     COLVAL
        STB     <GCOLB
        RTS

* DRSCAL: DRLEN = B x the scale / 4, rounded down (ADJUST)
DRSCAL  LDA     <DRSCL
        MUL
        LSRA
        RORB
        LSRA
        RORB
        STD     <DRLEN
        RTS

* DRSGN: D = DRLEN x B (B is -1, 0 or 1)
DRSGN   CLRA
        TSTB
        BEQ     DS9
        PSHS    B
        LDD     <DRLEN
        TST     ,S+
        BPL     DS9
        JMP     NEGD
DS9     RTS

* DRNUM: a number 0 to A (0 when left out) into B, else ?FC ERROR
DRNUM   PSHS    A
        JSR     MSNUM
        CMPB    ,S+
        BHI     DRFC
        RTS
DRFC    JMP     FCERR

* DRONE: the command A
DRONE   LDX     #DRLET
        CLRB
DR1     CMPA    ,X+
        BEQ     DRMOV
        INCB
        CMPB    #8
        BNE     DR1
        CMPA    #'M'
        BEQ     DRM
        LDB     #1
        CMPA    #'B'
        BEQ     DRF
        LDB     #2
        CMPA    #'N'
        BEQ     DRF
        CMPA    #'C'
        BEQ     DRC
        CMPA    #'A'
        BEQ     DRA
        CMPA    #'S'
        BNE     DRFC
        LDA     #62
        BSR     DRNUM
        TSTB
        BEQ     DRFC
        STB     <DRSCL
        RTS
DRA     LDA     #3
        BSR     DRNUM
        STB     <DRANG
        RTS
DRC     LDA     #8
        BSR     DRNUM
        BRA     DRCOL
DRF     ORB     <DRFLG
        STB     <DRFLG
        RTS

* M x,y
DRM     LDU     #LASTX
        BSR     DRMC
        PSHS    D
        JSR     MSGET
        BCS     DRFC
        CMPA    #','
        BNE     DRFC
        LDU     #LASTY
        BSR     DRMC
        TFR     D,Y
        PULS    X
        BRA     DMOVE
* DRMC: one part of M: D = the coordinate, absolute or (with a sign) relative to the word at U
DRMC    JSR     MSGET
        BCS     DRFC
        LDB     #1
        CMPA    #'+'
        BEQ     DC1
        NEGB
        CMPA    #'-'
        BEQ     DC1
        JSR     MSBACK
        JMP     MSNUM
DC1     PSHS    B,U
        JSR     MSNUM
        JSR     DRSCAL
        PULS    B,U
        JSR     DRSGN
        ADDD    ,U
        RTS

* a direction B (0-7): turned by the angle, then n units of it
DRMOV   ADDB    <DRANG
        ADDB    <DRANG
        ANDB    #7
        ASLB
        LDX     #DRVEC
        ABX
        LDD     ,X
        PSHS    D               ; the steps in x and y
        JSR     MSNUM
        BCC     DV1
        LDB     #1
DV1     JSR     DRSCAL
        PULS    B
        JSR     DRSGN
        ADDD    LASTX
        PSHS    D
        LDB     2,S
        JSR     DRSGN
        ADDD    LASTY
        TFR     D,Y
        PULS    X
        LEAS    1,S
* DMOVE: to (X, Y): a line, or with B only the point moves; with N the point comes back after
DMOVE   LDU     LASTX
        LDD     LASTY
        PSHS    D,U
        LDA     <DRFLG
        LSRA
        BCS     DM1
        JSR     LINETO
DM1     STX     LASTX
        STY     LASTY
        LDA     <DRFLG
        CLR     <DRFLG
        BITA    #2
        PULS    D,U
        LBEQ    DS9
        STD     LASTY
        STU     LASTX
        RTS
