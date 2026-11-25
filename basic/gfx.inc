* ---------------- graphics: pages, modes and points ----------------
* docs/clean-room-basic-p2.md sections 3 and 5. A page is 1.5K; page p (1-8) starts at $0600 + (p-1) x $600 [OWN];
* the pages PCLEAR reserves end where the program starts, so the last reserved page ends at TXTTAB-1 and a mode's
* pages fit when their end's high byte is at most TXTTAB's [OWN]. Coordinates are 0-255 by 0-191 in every mode [UM].
* GMENT points at the current mode's GMTAB entry, GBEG is its start page's address; GCOLB is the colour byte every
* plot writes (the colour in every pixel of a byte); GCSS is 4 x the colour set (0 or 4).

* GMTAB: four bytes a mode [HW: mc6847.js GMODES, sam6883.js]: the VDG bits / 2 (A/G, GM2-0; CSS goes in between),
* the pages' length in 256-byte units x 8 + the SAM's V, the bytes a row ($10 or $20) + 2 if y is halved + 1 if x is
* halved, and the first pixel's mask ($80 two colours, $C0 four)
GMTAB   FCB     $58,6*8+3,$13,$80       ; PMODE 0: 128 x 96, 2 colours, 1 page (RG2)
        FCB     $60,12*8+4,$23,$C0      ; PMODE 1: 128 x 96, 4 colours, 2 pages (CG3)
        FCB     $68,12*8+5,$11,$80      ; PMODE 2: 128 x 192, 2 colours, 2 pages (RG3)
        FCB     $70,24*8+6,$21,$C0      ; PMODE 3: 128 x 192, 4 colours, 4 pages (CG6)
        FCB     $78,24*8+6,$20,$80      ; PMODE 4: 256 x 192, 2 colours, 4 pages (RG6)

* GINIT: the cold start's graphics [UM: PCLEAR 4, done by PROGST; OWN: PMODE 2,1, the last point 128,96]
GINIT   LDD     #128
        STD     LASTX
        LDB     #96
        STD     LASTY
        LDX     #GMTAB+8
        LDA     #6
        BSR     SETPM
* PMDEF: the default colours of the mode and set [OWN; BB]: two colours, foreground the set's (1 or 5) and
* background black; four colours, the set's last and first (4 and 1, or 8 and 5)
PMDEF   LDA     GCSS
        INCA
        LDX     <GMENT
        LDB     3,X
        ASLB
        BPL     PD1             ; two colours
        TFR     A,B
        ADDA    #3
        FCB     $21             ; (BRN: skips the CLRB)
PD1     CLRB
        STD     FGCOL           ; FGCOL, then BGCOL
        RTS

* PMODE m[,p]: the mode (0-4) and start page (default the current one) for drawing [UM]; ?FC ERROR if the pages go
* past the reserved ones [BB]. It does not change what is shown (SCREEN does), and sets the default colours.
PMODE   JSR     GETBYT
        CMPB    #4
        BHI     GFC
        ASLB
        ASLB
        LDX     #GMTAB
        ABX
        PSHS    X
        JSR     <ZCHKCOM
        BNE     PM1
        JSR     COMBYT
        BSR     PGADR
        FCB     $8C             ; (CMPX #: skips the LDA)
PM1     LDA     <GBEG
        PULS    X
        BSR     SETPM
        BCC     PMDEF
GFC     JMP     FCERR

* SETPM: make X's mode, starting at the page whose address's high byte is A, the current one; C set (and nothing
* changed) if its pages go past the reserved ones
SETPM   PSHS    A
        LDB     1,X
        LSRB
        LSRB
        LSRB
        ADDB    ,S
        STB     ,S              ; the high byte of the pages' end
        LDB     <TXTTAB
        CMPB    ,S+
        BCS     SP1
        STX     <GMENT
        CLRB
        STD     <GBEG
SP1     RTS

* PGADR: page B (1 up to the reserved pages, else ?FC ERROR) -> A = its address's high byte
PGADR   DECB
        LDA     #6
        MUL
        TSTA
        BNE     GFC
        ADDB    #12             ; the page's end, + 6
        BCS     GFC
        CMPB    <TXTTAB
        BHI     GFC
        SUBB    #6
        TFR     B,A
        RTS

* PCOPY a TO b: copy page a to page b, each reserved [UM; BB]
PCOPY   JSR     GETBYT
        BSR     PGADR
        PSHS    A
        LDB     #T_TO
        JSR     SYNCHR
        JSR     GETBYT
        BSR     PGADR
        CLRB
        TFR     D,X
        PULS    A
        TFR     D,U             ; (B is 0)
        LDY     #$600
        BRA     BLKCPY

* PCLEAR n: reserve n pages (1-8) [UM]: the program moves to just after them, the variables are cleared as CLEAR
* clears them, and a program goes on from the next statement [OWN; BB]. ?OM ERROR if the program would not fit.
* If the current mode's pages are no longer all reserved, it becomes PMODE 0,1 [OWN; BB].
PCLEAR  JSR     GETBYT
        DECB
        CMPB    #7
        BHI     GFC
        LDA     #6
        MUL
        ADDB    #12             ; the new start: $0601 + n x $600
        TFR     B,A
        LDB     #1
        SUBD    <TXTTAB
        PSHS    D               ; how far it moves
        ADDD    <VARTAB
        ADDD    #128            ; room as CLEAR keeps it
        CMPD    <STRBOT
        LBHI    OMERR
        LDU     <TXTTAB
        LDD     <VARTAB
        SUBD    <TXTTAB
        TFR     D,Y             ; the program and its end link
        TFR     U,D
        ADDD    ,S
        TFR     D,X
        STX     <TXTTAB
        BSR     MOVBLK
        LDX     <TXTTAB
        CLR     -1,X            ; the 0 before the program
        LDD     <VARTAB
        ADDD    ,S
        STD     <VARTAB
        JSR     DIRCHK
        BEQ     PCL1
        LDD     <TXTPTR         ; in a program: the text pointer moves with it
        ADDD    ,S
        STD     <TXTPTR
PCL1    LEAS    2,S
        JSR     RELINK
        LDX     <GMENT
        LDA     <GBEG
PCL2    JSR     SETPM
        BCC     PCL3
        LDX     #GMTAB
        LDA     #6
        BRA     PCL2
PCL3    JMP     CL3             ; CLEAR's end: no variables, the stack emptied, the next statement

* MOVBLK: move Y bytes (1 or more) from U to X, either way round; BLKCPY: copy them forward
MOVBLK  PSHS    U
        CMPX    ,S++
        BLS     BLKCPY
        TFR     Y,D
        LEAU    D,U
        LEAX    D,X
MB1     LDA     ,-U
        STA     ,-X
        LEAY    -1,Y
        BNE     MB1
        RTS
BLKCPY  LDA     ,U+
        STA     ,X+
        LEAY    -1,Y
        BNE     BLKCPY
        RTS

* PCLS [c]: fill the current pages with colour c, the background by default [UM]: the first byte, then a forward
* copy of each byte to the next
PCLS    BEQ     PC0
        BSR     GETCL0
        BRA     PC1
PC0     LDB     BGCOL
PC1     BSR     COLVAL
        LDX     <GBEG
        STB     ,X
        LDU     <GMENT
        LDA     1,U
        LSRA
        LSRA
        LSRA
        CLRB                    ; D = the pages' length
        SUBD    #1
        TFR     D,Y
        LEAU    ,X
        LEAX    1,X
        BRA     BLKCPY

* COLOR f[,b]: the foreground and background colours, 0-8 [UM]
COLOR   BSR     GETCL0
        STB     FGCOL
        JSR     <ZCHKCOM
        BNE     CO1
        BSR     GETCOL
        STB     BGCOL
CO1     RTS

* GETCOL: a ',' and a colour 0-8 into B; GETCL0: a colour without the ',' (?FC ERROR above 8 [BB])
GETCOL  JSR     COMMA
GETCL0  JSR     GETBYT
        CMPB    #8
        BHI     GFC2
        RTS

* COLVAL: colour B -> B = that colour in every pixel of a byte of the current mode [OWN; BB]: two colours, 0 black
* and any other the foreground (all ones); four colours, the 2-bit value (c - 1) AND 3 four times
COLVAL  LDX     <GMENT
        LDA     3,X
        ASLA
        BMI     CV4
        TSTB
        BEQ     CV1
        LDB     #$FF
CV1     RTS
CV4     DECB
        ANDB    #3
        LDA     #$55
        MUL
        RTS

* PSET (x,y[,c]): the point in colour c, the foreground by default; PRESET (x,y): in the background [UM]
PSET    BSR     LSTXY
        LDB     FGCOL
        JSR     <ZCHKCOM
        BNE     PS1
        BSR     GETCOL
        BRA     PS1
PRESET  BSR     LSTXY
        LDB     BGCOL
PS1     BSR     RPKEEP
        BSR     COLVAL
        STB     <GCOLB
        LDA     LASTX+1
        LDB     LASTY+1
* PLOT: pixel (A = x 0-255, B = y 0-191) to the colour byte GCOLB: the one routine every drawing statement plots with
PLOT    BSR     GPIXAD
        LDB     <GCOLB
        EORB    ,X
        PSHS    B
        ANDA    ,S+
        EORA    ,X
        STA     ,X
        RTS

* GPIXAD: pixel (A = x, B = y) -> X = its byte, A = its mask [HW: 8 pixels a byte, or 4 of two bits, the leftmost
* in the top bits]. x and y are halved where the mode halves them; in four colours x' x 2 is the pixel's bit offset.
GPIXAD  PSHS    D               ; x, y
        LDX     <GMENT
        LDA     2,X
        LSRA
        BCC     GP1
        LSR     ,S
GP1     LSRA
        BCC     GP2
        LSR     1,S
GP2     LDA     3,X
        BITA    #$40
        BEQ     GP3
        ASL     ,S
GP3     PSHS    A               ; the first pixel's mask, the bit offset in the row, y'
        LDA     2,X
        ANDA    #$30
        LDB     2,S
        MUL
        ADDD    <GBEG
        TFR     D,X
        LDB     1,S
        LSRB
        LSRB
        LSRB
        ABX
        LDB     1,S
        ANDB    #7
        PULS    A
        BRA     GP5
GP4     LSRA
GP5     DECB
        BPL     GP4
        LEAS    2,S
        RTS

GFC2    JMP     FCERR

* RPKEEP: the ')' at the text pointer, keeping D (and X)
RPKEEP  PSHS    D
        JSR     RPAREN
        PULS    D,PC

* LSTXY: a point (x,y into the last point; GETXY: (x,y into the 4 bytes at U, each 16-bit: x 0-255, y 0-191
* (?FC ERROR) [UM; BB]), up to the ')' or the ',' after y. A = x, B = y.
LSTXY   LDU     #LASTX
GETXY   PSHS    U
        JSR     LPAREN
        JSR     GETBYT
        STD     [,S]
        JSR     COMBYT
        CMPB    #191
        BHI     GFC2
        PULS    U
        STD     2,U
        LDA     1,U
        RTS

* PPOINT (x,y): the colour of a point [UM]: in four colours 1-4 or 5-8 by the colour set; in two, 0 for black,
* else the set's colour (1 or 5) [OWN; BB]
PPOINT  LDU     #GXY
        BSR     GETXY
        BSR     RPKEEP
        BSR     GPIXAD
        TFR     A,B
        ANDB    ,X
PP1     BITA    #1
        BNE     PP2
        LSRA
        LSRB
        BRA     PP1
PP2     DECA                    ; 0 two colours, 2 four
        BEQ     PP3
        INCB
PP3     TSTB
        BEQ     PP4
        ADDB    GCSS
PP4     CLRA
        JMP     GIVNUM

* SCREEN t[,c]: text (0) or graphics (1) with colour set c (0 or 1, default 0) [UM; the default OWN, BB]
SCRNST  JSR     GETBYT
        CMPB    #1
        BHI     GFC2
        PSHS    B
        CLRB
        JSR     <ZCHKCOM
        BNE     SCR1
        JSR     COMBYT
        CMPB    #1
        BHI     GFC2
        ASLB
        ASLB
SCR1     STB     GCSS
        PULS    B
        TSTB
        BEQ     TXTSCR
* GSHOW: show the current mode and pages: PIA1 PB3-PB7 (CSS, GM0-2, A/G) by read-modify-write, keeping PB0-PB2
* (PB2 selects the ROM in 32K mode, PB1 is the single-bit sound) [HW], then the SAM's V and F
GSHOW   LDX     <GMENT
        LDA     ,X
        ORA     GCSS
        ASLA
        LDB     1,X
        ANDB    #7
        PSHS    B
        LDB     <GBEG
        BRA     SHOW
* TXTSCR: back to the text screen at $0400 (A/G low, CSS 0, V 0) [HW]; also at the OK prompt and after an error
* (decision 7)
TXTSCR  CLRA
        CLRB
        PSHS    B
        LDB     #SCREEN/256
SHOW    PSHS    A
        LDA     PIA1B
        ANDA    #7
        ORA     ,S+
        STA     PIA1B
* the SAM: V0-V2 then F0-F6 (the display's address / 512), each by its clear or set address from $FFC0 [HW]
        CLRA
        ASLB
        ROLA
        ASLB
        ROLA
        ORB     ,S+
        LDX     #$FFC0
SAM1     LSRA
        RORB
        BCC     SAM2
        LEAX    1,X
        STA     ,X+
        BRA     SAM3
SAM2     STA     ,X++
SAM3     CMPX    #$FFD4
        BLO     SAM1
        RTS
