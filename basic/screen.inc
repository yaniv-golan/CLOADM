* ---------------- the text screen ----------------
* 32 x 16 at $0400 [HW]. VDG codes: $40-$7F normal, $00-$3F inverse; so ASCII $20-$3F shows as $60-$7F,
* $40-$5F as itself, and lower case ($60-$7F) as the inverse upper-case letter [HW, UM].

* CHROUT: print the character in A. Keeps every register. Anything printed shows the text screen again [BB bb2
* gfx-text-return: a picture goes at PRINT and INPUT, not in an INKEY$ loop] (and so at the OK prompt and an error).
CHROUT  PSHS    D,X
        LDB     <DEVNUM         ; $FF: to the tape instead (CSAVE ,A: cassette.inc)
        INCB
        LBEQ    CHRTAP
        JSR     TXTSCR
        LDA     ,S
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
CHRPUT  STA     ,X+             ; (output leaves the cursor's countdown alone [BB reconcile])
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

* CLS: clear the screen and home the cursor; CLSC: the same, filled with D's bytes
CLSC    PSHS    D,X
        BRA     CLSF
CLS     PSHS    D,X
        LDD     #$6060
CLSF    LDX     #SCREEN
        STX     <CURPOS
CLS1    STD     ,X++
        CMPX    #SCREND
        BLO     CLS1
        PULS    D,X,PC

* CRLF: a carriage return
CRLF    PSHS    A
        LDA     #13
CRLF1   JSR     <ZCHROUT
        PULS    A,PC

* NEWLIN: a carriage return unless the cursor is at the start of a line
NEWLIN  PSHS    A
        LDA     <CURPOS+1
        ANDA    #31
        PULS    A               ; (the flags stay)
        BNE     CRLF
        RTS

* PRTSTR: print the 0-terminated string at X; X ends past the 0
PRTSTR  LDA     ,X+
        BEQ     PRTSD
        JSR     <ZCHROUT
        BRA     PRTSTR
PRTSD   RTS
* PRMSG: print the 0-terminated text that follows the call; the code after the text goes on. Uses A, X.
PRMSG   PULS    X
        BSR     PRTSTR
        JMP     ,X

* SPACE: print a space
SPACE   PSHS    A
        LDA     #32
        BRA     CRLF1

* LINPRT: print D as an unsigned decimal number, no spaces. Keeps every register.
LINPRT  PSHS    D,X,U
        BSR     LINSTR
        JSR     PRTN
        PULS    D,X,U,PC
* LINSTR: D as unsigned decimal digits (no leading zeros): X = them (in FBUFFR, the last at FBUFFR+18), B = how
* many. Uses FACM (a line number is only printed between statements) and U32DEC's work.
LINSTR  STD     <FACM+2
        CLRA
        CLRB
        STD     <FACM
        JMP     U32DEC
