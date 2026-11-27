* ---------------- the input line editor ----------------
* LINEIN: read a line into LINBUF, echoed on the screen [UM]: left arrow erases a character, SHIFT-left
* arrow the whole line, CLEAR clears the screen, BREAK abandons the line, ENTER ends it.
* Returns X = LINBUF, B = the length, the line 0-terminated; carry set if BREAK was pressed.
LINEIN  ANDCC   #$EF            ; interrupts on: TIMER counts while a line is typed
        LDX     #LINBUF
LI1     JSR     KEYWT
        CMPA    #13
        BEQ     LIEND
        CMPA    #3
        BEQ     LIEND
        CMPA    #8
        BEQ     LIBS
        CMPA    #$15
        BEQ     LIKILL
        CMPA    #12
        BEQ     LICLR
        CMPA    #32
        BLO     LI1             ; down, right: nothing
        CMPX    #LINBUF+LINMAX
        BHS     LI1             ; full
        STA     ,X+
        JSR     <ZCHROUT
        BRA     LI1
LIBS    CMPX    #LINBUF
        BEQ     LI1
        LEAX    -1,X
        JSR     <ZCHROUT
        BRA     LI1
LIKILL  CMPX    #LINBUF
        BEQ     LI1
        LEAX    -1,X
        LDA     #8
        JSR     <ZCHROUT
        BRA     LIKILL
LICLR   JSR     CLS
        LDX     #LINBUF
        BRA     LI1
* the line ends: ENTER (C clear) or BREAK (C set); D = its length, X = LINBUF
LIEND   PSHS    A
        CLR     ,X
        JSR     CRLF
        TFR     X,D
        SUBD    #LINBUF
        LDX     #LINBUF
        PULS    A
        CMPA    #13             ; (C set for BREAK, 3)
        RTS

