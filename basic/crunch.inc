* ---------------- crunching: keywords to tokens ----------------
* CRUNCH: LINBUF (0-terminated) to CRNBUF, keywords replaced by their tokens (functions as $FF and the
* token). Strings in quotes, REM and ' remarks and DATA up to the next ':' are copied as typed; '?' is
* PRINT [UM]. The longest keyword that matches wins. The result ends with three 0 bytes.
CRUNCH  PSHS    X,Y,U
        LDX     #LINBUF
        LDU     #CRNBUF
        CLR     <INQUOT
CR1     LDA     ,X
        LBEQ    CRDONE
        CMPA    #'"'
        BEQ     CRQUOT
        TST     <INQUOT
        BEQ     CR2
        CMPA    #':'            ; DATA: as typed up to a ':'
        BNE     CRCOPY
        CLR     <INQUOT
        BRA     CRCOPY
CR2     CMPA    #'&'            ; &H and &O numbers: their digits and letters as typed
        BNE     CR2A
        STA     ,U+
        LEAX    1,X
CRH1    LDA     ,X
        CMPA    #'0'
        BLO     CR1
        CMPA    #'9'
        BLS     CRH2
        CMPA    #'A'
        BLO     CR1
        CMPA    #'Z'
        BHI     CR1
CRH2    STA     ,U+
        LEAX    1,X
        BRA     CRH1
CR2A    CMPA    #'?'
        BNE     CR3
        LDA     #T_PRINT
        STA     ,U+
        LEAX    1,X
        BRA     CR1
CR3     CMPA    #' '
        BEQ     CRCOPY
        JSR     KWMAT
        BCS     CRTOK
        LDA     ,X
        BRA     CRCOPY
CRTOK   TST     <KWFN
        BEQ     CR4
        LDB     #$FF
        STB     ,U+
CR4     STA     ,U+
        LDB     <KWLEN
        ABX
        TST     <KWFN
        BNE     CR1
        CMPA    #T_REM
        BEQ     CRREST
        CMPA    #T_APOS
        BEQ     CRREST
        CMPA    #T_DATA
        BNE     CR1
        INC     <INQUOT
        BRA     CR1
CRCOPY  STA     ,U+
        LEAX    1,X
        BRA     CR1
CRQUOT  STA     ,U+             ; a string: copied with its quotes
        LEAX    1,X
CRQ1    LDA     ,X
        BEQ     CRDONE
        STA     ,U+
        LEAX    1,X
        CMPA    #'"'
        BNE     CRQ1
        LBRA    CR1
CRREST  LDA     ,X+
        STA     ,U+
        BNE     CRREST
        LEAU    -1,U
CRDONE  CLR     ,U+
        CLR     ,U+
        CLR     ,U+
        PULS    X,Y,U,PC

* KWMAT: the longest keyword at X. C set if one matches: A = its token, KWFN nonzero for a function,
* KWLEN its length. Keeps X, U.
KWMAT   PSHS    X,U
        CLR     <KWLEN
        CLR     <KWFN
        LDU     #KWSTMT
        CLRB
        BSR     KWSCAN
        LDU     #KWFUNC
        LDB     #1
        BSR     KWSCAN
        LDA     <KWTOK
        TST     <KWLEN
        BEQ     KWNO
        ORCC    #1
        PULS    X,U,PC
KWNO    ANDCC   #$FE
        PULS    X,U,PC
* KWSCAN: try every entry of the table at U against the text at 2,S's X (B: 1 for the function table)
KWSCAN  STB     <KWTMP
KS1     LDA     ,U
        BEQ     KSDONE
        LDX     2,S             ; the text (KWMAT's saved X)
KS2     LDA     ,U+
        PSHS    A
        ANDA    #$7F
        CMPA    ,X+
        BNE     KSMISS
        TST     ,S+
        BPL     KS2
* a whole keyword matched: longer than the best so far?
        TFR     X,D
        SUBD    2,S
        CMPB    <KWLEN
        BLS     KSNEXT
        STB     <KWLEN
        LDA     ,U
        STA     <KWTOK
        LDA     <KWTMP
        STA     <KWFN
KSNEXT  LEAU    1,U             ; past the token
        BRA     KS1
KSMISS  TST     ,S+
        BMI     KSNEXT          ; that was the last letter
KSM1    TST     ,U+
        BPL     KSM1
        BRA     KSNEXT
KSDONE  RTS
