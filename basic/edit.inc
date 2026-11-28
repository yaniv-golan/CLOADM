* ---------------- EDIT ----------------
* EDIT n [BB bb10 stmt-edit; bb11 stmt-edit2, stmt-edit3; bb12 stmt-edit4, stmt-edit4c; bb13c stmt-edit5]: the line
* is printed as LIST shows it, then again as it is edited: its number and a space, then keys, each command after an
* optional count n (1 when none is typed). Space moves n characters on, showing them; nD deletes n (nothing shown
* for them); nC changes n, each key typed taking the place of one (shown); nS c moves on, showing, to the n-th c
* after the cursor, and nK c deletes up to it (with no such c: to the line's end, so K then deletes the rest);
* I inserts at the cursor; H deletes the rest of the line and inserts; X shows the rest and inserts; L shows the
* rest and starts the line again; A starts again from the line as stored; ENTER shows the rest and stores the line
* as if typed (no OK; in a program too, which ends there); E stores it without showing the rest; Q leaves it as it
* was (OK). In insertion a printable key goes in, LEFT takes out the character before the cursor, SHIFT and the up
* arrow go back to the commands, and ENTER ends as above. EDIT of a line that is not there, and EDIT with no number
* (line 0), are ?UL ERROR; anything after the number but the end of the statement is ?SN ERROR. BREAK and other
* keys do nothing [BB]; LEFT at the text's start, C at the line's end, and control keys in C and insertion do
* nothing, and a count is taken modulo 256 (258D deletes 2) [OWN].
* The line is spelt out into LINBUF by LSTLIN itself, its output sent there through the two-byte call (ZCHROUT)
* for that one call, so LIST is not slowed [OWN], and the first copy is printed from there; at most LINMAX
* characters with the number. TMPPT2 holds where its text starts (after the number and space). A command is found
* in EDTAB and called (B its count, X the cursor); it returns to take the next one, or leaves EDIT (ENTER, E, Q).
EDIT    JSR     <ZLINGET        ; (0 with no number)
        JSR     ENDCHK
        JSR     NEWLIN          ; on a line's start, so that LSTLIN ends the line it spells out with no carriage
EDIT1   JSR     FNDLIN          ; return (it ends one only off column 0) [OWN: after PRINT "XY"; the first copy
        LBCC    ULERR           ; starts on the next line]; A comes in at EDIT1 after its own carriage return
        LDD     #LINBUF
        STD     <TMPPTR
        LDD     #EDPUT
        STD     <ZCHROUT+1
        JSR     LSTLIN
        LDD     #CHROUT
        STD     <ZCHROUT+1
        CLR     [TMPPTR]
        LDX     #LINBUF         ; the first copy, and always its carriage return: a line of 32 characters
        JSR     PRTSTR          ; leaves an empty one under it [BB bb11 stmt-edit3]
        JSR     CRLF
        LBSR    EDNUM
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
EDC3    LDU     #EDTAB-2
EDC4    LEAU    2,U
        TST     ,U
        BEQ     EDC0            ; not a command: nothing
        CMPA    ,U
        BNE     EDC4
        LDA     1,U
        LDU     #EDBASE
        JSR     A,U
        BRA     EDC0
* the commands: the key, and where its routine is from EDBASE
EDTAB   FCB     13,EDENT-EDBASE,'E',EDEND-EDBASE,'Q',EDQUIT-EDBASE,'A',EDAGIN-EDBASE
        FCB     'L',EDLST-EDBASE,' ',EDSHOW-EDBASE,'D',EDDEL-EDBASE,'C',EDCHG-EDBASE
        FCB     'S',EDSRCH-EDBASE,'K',EDKILL-EDBASE,'I',EDINS-EDBASE,'H',EDHAK-EDBASE
        FCB     'X',EDXT-EDBASE,0
EDHAK   CLR     ,X              ; H: the rest gone
        FCB     $8C             ; (CMPX #: skips the BSR)
EDXT    BSR     EDREST          ; X: to the end
* insertion (I, H, X): a printable key goes in at X
EDINS   JSR     KEYWT
        CMPA    #13
        BEQ     EDENT
        CMPA    #$5F            ; SHIFT and the up arrow: the commands again
        BEQ     EDSH1
        CMPA    #8
        BEQ     EDBS
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
EDBS    CMPX    <TMPPT2         ; LEFT: the character before the cursor out (none at the text's start)
        BLS     EDINS
        JSR     <ZCHROUT        ; (back one on the screen)
        LEAX    -1,X
        BSR     EDDEL1
        BRA     EDINS
* ENTER: the rest shown, and the line goes in as a typed one does (MAIN)
EDENT   BSR     EDREST
EDEND   JSR     CRLF            ; (E: the rest not shown)
        JMP     MAINLN
EDQUIT  JMP     READY           ; Q: OK on a line of its own, the line as it was
EDAGIN  LEAS    2,S             ; A: all again, from the line as stored
        JSR     CRLF
        LBRA    EDIT1
EDLST   BSR     EDREST          ; L: the rest shown, and the line again from its start
        JSR     CRLF
* EDNUM: the number and its space shown again, X and TMPPT2 on the text after them
EDNUM   LDX     #LINBUF
EDN1    LDA     ,X+
        JSR     <ZCHROUT
        CMPA    #' '
        BNE     EDN1
        STX     <TMPPT2
        RTS
* EDREST: the rest of the line from X shown, X ending on its 0; EDSHOW (space): B characters of it at most
EDREST  LDB     #$FF            ; (more than a line holds)
EDSHOW  LDA     ,X
        BEQ     EDSH1
        JSR     <ZCHROUT
        LEAX    1,X
        DECB
        BNE     EDSHOW
EDSH1   RTS
EDBASE  EQU     *
EDDEL   TST     ,X              ; nD: n characters gone
        BEQ     EDSH1
        BSR     EDDEL1
        DECB
        BNE     EDDEL
        RTS
* EDDEL1: the character at X out of the line
EDDEL1  PSHS    X
EDD1    LDA     1,X
        STA     ,X+
        BNE     EDD1
        PULS    X,PC
EDCHG   TST     ,X              ; nC: n characters changed, as far as the line goes
        BEQ     EDSH1
EDCH1   JSR     KEYWT
        CMPA    #' '
        BLO     EDCH1
        STA     ,X+
        JSR     <ZCHROUT
        DECB
        BNE     EDCHG
        RTS
EDSRCH  BSR     EDFIND          ; nS c: on to the n-th c, the characters passed shown
        TFR     U,D
        PSHS    X
        SUBD    ,S++            ; (B: how many; none at the line's end, where EDSHOW shows nothing)
        BRA     EDSHOW
EDKILL  BSR     EDFIND          ; nK c: the characters up to the n-th c gone
        PSHS    X
EDK1    LDA     ,U+
        STA     ,X+
        BNE     EDK1
        PULS    X,PC
* EDFIND: a key (the character c), then U = the B-th c after X, or the line's 0 when there are fewer
EDFIND  JSR     KEYWT           ; (keeps B)
        TFR     X,U
EDF1    TST     ,U+
        BEQ     EDF2
        CMPA    ,U
        BNE     EDF1
        DECB
        BNE     EDF1
        RTS
EDF2    LEAU    -1,U
        RTS
