* ---------------- PRINT ----------------
* PRINT items separated by ; (nothing between) or , (the next 16-column zone, or the next line from the second
* zone) [UM]; TAB(n) moves to column n if the cursor is left of it. A number prints with a space or - before it
* and a space after it. Without ; or , at the end, the line ends.
* PRINT #-1, ...: the same to the cassette data file open for output (cassette.inc), ?NO ERROR when none is open
* [BB bb4 cas-files]. There a number has no space after it, and ; and , each end the record with a carriage return:
* "HELLO";42 writes HELLO, CR, " 42", CR [BB bb4 cas-files: the data block's hash; what ; and , write when nothing
* follows them, and TAB( there, are OWN].
PRINT   BEQ     PRCR
        CMPA    #'#'
        BNE     PR0
        LDB     #$FE            ; (open for output)
        JSR     CDEV
        INCA                    ; ($FF: the output to the tape until the statement ends)
        STA     <DEVNUM
        JSR     COMMA
        BSR     PRINT
        CLR     <DEVNUM
        RTS
PR0     CMPA    #'@'            ; PRINT @n, ...: from screen position n (0-511) [UM], USING too
        BNE     PRU
        JSR     <ZCHRGET
        JSR     EVADR
        CMPD    #511
        LBHI    FCERR
        ADDD    #SCREEN
        STD     <CURPOS
        JSR     <ZCHKCOM
        BNE     PRNXT
        JSR     <ZCHRGET
        BEQ     PRCR
PRU     CMPA    #T_USING
        LBEQ    PRUSNG
PR1     CMPA    #';'
        BEQ     PRSEMI
        CMPA    #','
        BEQ     PRCOM
        CMPA    #T_TAB
        BEQ     PRTAB
        JSR     EVAL
        TST     <VALTYP
        BNE     PRSTR
        JSR     FOUT
        JSR     <ZPRTSTR
        BSR     TAPEQ
        BEQ     PRNXT           ; (no space after it on the tape)
        JSR     SPACE
        BRA     PRNXT
PRSTR   JSR     FRESTR
        BSR     PRTN
PRNXT   JSR     <ZCHRGOT
        BNE     PR1
PRCR    JMP     CRLF
PRSEMI  BSR     TAPCR
        JSR     <ZCHRGET
        BNE     PR1
        RTS
PRCOM   BSR     TAPCR
        BEQ     PRC3            ; (on the tape a carriage return only)
        LDB     <CURPOS+1
        ANDB    #31
        CMPB    #16
        BHS     PRC2
PRC1    JSR     SPACE
        LDB     <CURPOS+1
        BITB    #15             ; (column 16 is the first with these 0 after a space)
        BNE     PRC1
        BRA     PRC3
PRC2    JSR     CRLF
PRC3    JSR     <ZCHRGET
        BNE     PR1
        RTS
PRTAB   JSR     <ZCHRGET          ; (TAB( is one token: the argument follows)
        JSR     <ZGETBYT
        JSR     RPKEEP
        LDA     <CURPOS+1       ; spaces: n - the column, when that is above 0
        ANDA    #31
        PSHS    A
        SUBB    ,S+
        BLS     PRNXT
PRT1    JSR     SPACE
        DECB
        BNE     PRT1
        BRA     PRNXT
* TAPEQ: Z set when the output goes to the tape. TAPCR: then a carriage return too (Z stays set).
TAPCR   BSR     TAPEQ
        BNE     TQ1
        JSR     CRLF
TAPEQ   LDB     <DEVNUM
        INCB
TQ1     RTS
* PRTN: print B characters from X
PRTN    TSTB
        BEQ     PRTN2
PRTN1   LDA     ,X+
        JSR     <ZCHROUT
        DECB
        BNE     PRTN1
PRTN2   RTS
