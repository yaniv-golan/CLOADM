* ---------------- the text screen ----------------
* 32 x 16 at $0400 [HW]. VDG codes: $40-$7F normal, $00-$3F inverse; so ASCII $20-$3F shows as $60-$7F,
* $40-$5F as itself, and lower case ($60-$7F) as the inverse upper-case letter [HW, UM].

* CHROUT: print the character in A. Keeps every register.
CHROUT  TST     <CASOUT         ; CSAVE ,A: to the tape instead (cassette.inc)
        LBNE    CHRTAP
        PSHS    D,X
        LDX     <CURPOS
        CMPA    #13
        BEQ     CHRCR
        CMPA    #8
        BEQ     CHRBS
        CMPA    #32
        BLO     CHRDON          ; other control characters print nothing
        CMPA    #$80
        BHS     CHRPUT          ; semigraphics blocks as they are
        CMPA    #$60
        BLO     CHRUP
        SUBA    #$60            ; lower case: inverse
        BRA     CHRPUT
CHRUP   CMPA    #$40
        BHS     CHRPUT
        ADDA    #$40
CHRPUT  STA     ,X+
CHRCHK  CMPX    #SCREND
        BLO     CHRDON
        BSR     SCROLL
CHRDON  STX     <CURPOS
        PULS    D,X,PC
* carriage return: blank the rest of the line and go to the start of the next
CHRCR   TFR     X,D
        ADDD    #32
        ANDB    #$E0
        PSHS    D
        LDA     #$60
CHRCR1  STA     ,X+
        CMPX    ,S
        BLO     CHRCR1
        LEAS    2,S
        BRA     CHRCHK
* backspace: one cell back, blanked (never above the screen's start)
CHRBS   CMPX    #SCREEN
        BEQ     CHRDON
        LDA     #$60
        STA     ,-X
        BRA     CHRDON

* SCROLL: move the screen up a line, blank the bottom line, and move X up a line
SCROLL  PSHS    D,U
        LDU     #SCREEN
SCRL1   LDD     32,U
        STD     ,U++
        CMPU    #SCREND-32
        BLO     SCRL1
        LDD     #$6060
SCRL2   STD     ,U++
        CMPU    #SCREND
        BLO     SCRL2
        LEAX    -32,X
        PULS    D,U,PC

* CLS: clear the screen and home the cursor
CLS     PSHS    D,X
        LDX     #SCREEN
        STX     <CURPOS
        LDD     #$6060
CLS1    STD     ,X++
        CMPX    #SCREND
        BLO     CLS1
        PULS    D,X,PC

* CRLF: a carriage return
CRLF    PSHS    A
        LDA     #13
        JSR     CHROUT
        PULS    A,PC

* NEWLIN: a carriage return unless the cursor is at the start of a line
NEWLIN  PSHS    D
        LDD     <CURPOS
        ANDB    #31
        PULS    D
        BEQ     NEWLN1
        BRA     CRLF
NEWLN1  RTS

* PRTSTR: print the 0-terminated string at X; X ends past the 0
PRTSTR  LDA     ,X+
        BEQ     PRTSD
        JSR     CHROUT
        BRA     PRTSTR
PRTSD   RTS

* SPACE: print a space
SPACE   PSHS    A
        LDA     #32
        JSR     CHROUT
        PULS    A,PC

* LINPRT: print D as an unsigned decimal number, no spaces. Keeps every register.
LINPRT  PSHS    D,X
        BSR     LINSTR
        JSR     PRTN
        PULS    D,X,PC
* LINSTR: D as unsigned decimal digits (no leading zeros) at LNSBUF: X = them, B = how many
LINSTR  PSHS    Y
        LDY     #LNSBUF
        LDX     #DECTAB
LNP1    CLR     ,-S             ; this place's digit
LNP2    SUBD    ,X
        BLO     LNP3
        INC     ,S
        BRA     LNP2
LNP3    ADDD    ,X++
        PSHS    D
        LDA     2,S
        BNE     LNP4
        CMPY    #LNSBUF         ; leading zeros are skipped
        BNE     LNP4
        CMPX    #DECTAB+10      ; the units digit is always written
        BNE     LNP5
LNP4    ADDA    #'0'
        STA     ,Y+
LNP5    PULS    D
        LEAS    1,S
        CMPX    #DECTAB+10
        BLO     LNP1
        TFR     Y,D
        SUBD    #LNSBUF
        LDX     #LNSBUF
        PULS    Y,PC
DECTAB  FDB     10000,1000,100,10,1
