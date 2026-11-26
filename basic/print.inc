* ---------------- PRINT ----------------
* PRINT items separated by ; (nothing between) or , (the next 16-column zone, or the next line from the second
* zone) [UM]; TAB(n) moves to column n if the cursor is left of it. A number prints with a space or - before it
* and a space after it. Without ; or , at the end, the line ends.
PRINT   BEQ     PRCR
        CMPA    #'@'            ; PRINT @n, ...: from screen position n (0-511) [UM], USING too
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
        JSR     SPACE
        BRA     PRNXT
PRSTR   JSR     FRESTR
        BSR     PRTN
PRNXT   JSR     <ZCHRGOT
        BNE     PR1
PRCR    JMP     CRLF
PRSEMI  JSR     <ZCHRGET
        BNE     PR1
        RTS
PRCOM   LDB     <CURPOS+1
        ANDB    #31
        CMPB    #16
        BHS     PRC2
PRC1    JSR     SPACE
        LDB     <CURPOS+1
        ANDB    #31
        CMPB    #16
        BLO     PRC1
        BRA     PRC3
PRC2    JSR     CRLF
PRC3    JSR     <ZCHRGET
        BNE     PR1
        RTS
PRTAB   JSR     <ZCHRGET          ; (TAB( is one token: the argument follows)
        JSR     <ZGETBYT
        PSHS    B
        JSR     <ZRPAREN
        PULS    B
        LDA     <CURPOS+1       ; spaces: n - the column, when that is above 0
        ANDA    #31
        PSHS    A
        SUBB    ,S+
        BLS     PRNXT
PRT1    JSR     SPACE
        DECB
        BNE     PRT1
        BRA     PRNXT
* PRTN: print B characters from X
PRTN    TSTB
        BEQ     PRTN2
PRTN1   LDA     ,X+
        JSR     <ZCHROUT
        DECB
        BNE     PRTN1
PRTN2   RTS
