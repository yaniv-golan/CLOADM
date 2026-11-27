* ---------------- EDIT ----------------
* EDIT n [BB bb10 stmt-edit]: the line is printed as LIST shows it, then again as it is edited: its number and a
* space, then keys. A count (digits) then space moves that many characters on, showing them; nD deletes n (nothing
* shown for them); H deletes the rest of the line and inserts; X shows the rest and inserts; L shows the rest and
* starts the line again; ENTER shows the rest and stores the line as if typed (no OK; in a program too, which ends
* there). EDIT of a line that is not there, and EDIT with no number (line 0), are ?UL ERROR. Other keys do nothing;
* in insertion a printable key goes in and ENTER ends, any other key does nothing [OWN].
* The line is spelt out into LINBUF by LSTLIN itself, its output sent there through the two-byte call (ZCHROUT)
* for that one call, so LIST is not slowed [OWN]; at most LINMAX characters with the number.
EDIT    JSR     <ZLINGET        ; (0 with no number)
        JSR     FNDLIN
        LBCC    ULERR
        JSR     LSTLIN          ; the first copy (LSTLIN keeps X)
        LDD     #LINBUF
        STD     <TMPPTR
        LDD     #EDPUT
        STD     <ZCHROUT+1
        JSR     LSTLIN          ; (the cursor is at a line's start: no carriage return comes)
        LDD     #CHROUT
        STD     <ZCHROUT+1
        CLR     [TMPPTR]
EDAGN   LDX     #LINBUF         ; the number and its space again
EDNUM   LDA     ,X+
        JSR     <ZCHROUT
        CMPA    #' '
        BNE     EDNUM
EDC0    CLRB                    ; no count yet (KEYWT keeps B)
EDC1    JSR     KEYWT
        CMPA    #'0'
        BLO     EDC2
        CMPA    #'9'
        BHI     EDC2
        SUBA    #'0'            ; count x 10 + the digit
        PSHS    A
        LDA     #10
        MUL
        ADDB    ,S+
        BRA     EDC1
EDC2    TSTB                    ; the count: 1 when none was typed
        BNE     EDC3
        INCB
EDC3    CMPA    #13
        BEQ     EDENT
        CMPA    #' '
        BEQ     EDSPC
        CMPA    #'D'
        BEQ     EDDEL
        CMPA    #'H'
        BEQ     EDHAK
        CMPA    #'X'
        BEQ     EDXT
        CMPA    #'L'
        BNE     EDC0
        BSR     EDREST          ; L: the rest shown, and the line again from its start
        JSR     CRLF
        BRA     EDAGN
EDSPC   BSR     EDSHOW          ; space: on n characters
        BRA     EDC0
EDDEL   TST     ,X              ; nD: n characters gone
        BEQ     EDC0
        TFR     X,U
EDD1    LDA     1,U
        STA     ,U+
        BNE     EDD1
        DECB
        BNE     EDDEL
        BRA     EDC0
EDHAK   CLR     ,X              ; H: the rest gone
        FCB     $8C             ; (CMPX #: skips the BSR)
EDXT    BSR     EDREST          ; X: to the end
* insertion: a printable key goes in at X
EDINS   JSR     KEYWT
        CMPA    #13
        BEQ     EDENT
        CMPA    #' '
        BLO     EDINS
        TFR     X,U             ; the end of the line
EDI1    TST     ,U+
        BNE     EDI1
        CMPU    #LINBUF+LINMAX+1
        BHS     EDINS           ; full
        STX     <TMPPTR
EDI2    LDB     ,-U             ; the rest moved up one, from its 0 down
        STB     1,U
        CMPU    <TMPPTR
        BNE     EDI2
        STA     ,X+
        JSR     <ZCHROUT
        BRA     EDINS
* ENTER: the rest shown, and the line goes in as a typed one does (MAIN)
EDENT   BSR     EDREST
        JSR     CRLF
        JMP     MAINLN
* EDREST: the rest of the line from X shown, X ending on its 0; EDSHOW: B characters of it at most
EDREST  LDB     #$FF            ; (more than a line holds)
EDSHOW  LDA     ,X
        BEQ     EDSH1
        JSR     <ZCHROUT
        LEAX    1,X
        DECB
        BNE     EDSHOW
EDSH1   RTS
* EDPUT: LSTLIN's characters into the line at TMPPTR. Keeps every register.
EDPUT   PSHS    X
        LDX     <TMPPTR
        CMPX    #LINBUF+LINMAX
        BHS     EDP1
        STA     ,X+
        STX     <TMPPTR
EDP1    PULS    X,PC
