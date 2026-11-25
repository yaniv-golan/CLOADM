* ---------------- the input line editor ----------------
* LINEIN: read a line into LINBUF, echoed on the screen [UM]: left arrow erases a character, SHIFT-left
* arrow the whole line, CLEAR clears the screen, BREAK abandons the line, ENTER ends it.
* Returns X = LINBUF, B = the length, the line 0-terminated; carry set if BREAK was pressed.
LINEIN  ANDCC   #$EF            ; the cursor blinks on the field interrupt
        LDX     #LINBUF
LI1     JSR     KEYWT
        CMPA    #13
        BEQ     LIEND
        CMPA    #3
        BEQ     LIBRK
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
        JSR     CHROUT
        BRA     LI1
LIBS    CMPX    #LINBUF
        BEQ     LI1
        LEAX    -1,X
        JSR     CHROUT
        BRA     LI1
LIKILL  CMPX    #LINBUF
        BEQ     LI1
        LEAX    -1,X
        LDA     #8
        JSR     CHROUT
        BRA     LIKILL
LICLR   JSR     CLS
        LDX     #LINBUF
        BRA     LI1
LIEND   CLR     ,X
        JSR     CRLF
        TFR     X,D
        SUBD    #LINBUF
        LDX     #LINBUF
        ANDCC   #$FE
        RTS
LIBRK   CLR     ,X
        JSR     CRLF
        LDX     #LINBUF
        CLRB
        ORCC    #1
        RTS
