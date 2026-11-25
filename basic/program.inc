* ---------------- the program in memory ----------------
* A line: link to the next line (2), line number (2), crunched text, 0. The program ends with a 0 link;
* VARTAB is just past it [MBF; docs/clean-room-basic.md section 3].

* FNDLIN: find line BINVAL. X = the line (or the first line after it, or the end link); C set if found.
* Keeps D.
FNDLIN  PSHS    D
        LDX     <TXTTAB
FL1     LDD     ,X
        BEQ     FLNO            ; the end
        LDD     2,X
        CMPD    <BINVAL
        BEQ     FLYES
        BHI     FLNO
        LDX     ,X
        BRA     FL1
FLYES   ORCC    #1
        PULS    D,PC
FLNO    ANDCC   #$FE
        PULS    D,PC

* EDLINE: a typed line BINVAL with its text at TXTPTR (crunched, 0-terminated): store it, replace the line
* with that number, or delete it when the text is empty.
EDLINE  JSR     FNDLIN
        BCC     ED2
* delete the old line: move everything after it down
        PSHS    X
        LDU     ,X              ; the next line
ED1     LDA     ,U+
        STA     ,X+
        CMPU    <VARTAB
        BLO     ED1
        STX     <VARTAB
        PULS    X
ED2     LDY     <TXTPTR
        LDA     ,Y
        BEQ     EDDONE          ; nothing to insert
* the new line's size: 4 + the text and its 0
        LDD     #4
ED3     ADDD    #1
        TST     ,Y+
        BNE     ED3
        STD     <TMPCNT
        ADDD    <VARTAB
        ADDD    #64
        PSHS    D
        TFR     S,D
        CMPD    ,S++
        BHI     ED4
        JSR     RELINK          ; (the deletion is kept)
        JMP     OMERR
* open a gap at X: copy from the top down
ED4     LDU     <VARTAB
        LDY     <VARTAB
        PSHS    X
        LDD     <TMPCNT
        LEAY    D,Y
        STY     <VARTAB
ED5     CMPU    ,S
        BLS     ED6
        LDA     ,-U
        STA     ,-Y
        BRA     ED5
ED6     PULS    X
        LDD     <BINVAL
        STD     2,X
        LEAU    4,X
        LDY     <TXTPTR
ED7     LDA     ,Y+
        STA     ,U+
        BNE     ED7
EDDONE  JSR     RELINK
        JMP     CLRVAR

* RELINK: rewrite every line's link from the line's own length
RELINK  PSHS    D,X,U
        LDX     <TXTTAB
        LDD     <VARTAB
        SUBD    #2
        STD     <TMPPTR         ; the end link
RL1     CMPX    <TMPPTR
        BHS     RL3
        LEAU    4,X
RL2     TST     ,U+
        BNE     RL2
        STU     ,X
        TFR     U,X
        BRA     RL1
RL3     LDD     #0
        STD     ,X
        PULS    D,X,U,PC

* NEWPRG: an empty program
NEWPRG  LDX     <TXTTAB
        CLR     ,X+
        CLR     ,X+
        STX     <VARTAB
* CLRVAR: no variables, all string space free, DATA from the start, CONT impossible
CLRVAR  PSHS    D
        LDD     <VARTAB
        STD     <ARYTAB
        STD     <ARYEND
        LDD     <MEMTOP
        STD     <FRETOP
        LDD     <TXTTAB
        SUBD    #1
        STD     <DATPTR
        LDD     #0
        STD     <OLDTXT
        JSR     RSTTMP
        PULS    D,PC

* ---------------- LIST ----------------
* LIST, LIST n, LIST n-, LIST -n, LIST n-m [UM]
LIST    BSR     RANGE
        LDD     <TMPPT2
        STD     <BINVAL
        JSR     FNDLIN
LS4     LDD     ,X
        BEQ     LSDONE
        LDD     2,X
        CMPD    <TMPCNT
        BHI     LSDONE
        JSR     LSTLIN
        JSR     BRKTST
        BCS     LSBRK
        LDX     ,X
        BRA     LS4
LSDONE  RTS
LSBRK   JMP     READY
LSSN    JMP     SNERR
* RANGE: n, n-, -n, n-m or nothing at the text pointer: from TMPPT2 to TMPCNT (0-65535 when not given)
RANGE   LDX     #0
        STX     <TMPPT2         ; from
        LDX     #$FFFF
        STX     <TMPCNT         ; to
        JSR     CHRGOT
        BEQ     RG3
        BCC     RG1
        JSR     LINGET
        STD     <TMPPT2
        STD     <TMPCNT
        JSR     CHRGOT
        CMPA    #T_MINUS
        BNE     RG3
RG1     CMPA    #T_MINUS
        BNE     LSSN
        JSR     CHRGET
        BEQ     RG2             ; n-
        BCC     LSSN
        JSR     LINGET
        STD     <TMPCNT
        BRA     RG3
RG2     LDD     #$FFFF
        STD     <TMPCNT
RG3     JSR     CHRGOT
        BNE     LSSN
        RTS

* DEL n, DEL n-m, DEL -m, DEL n-: the lines in the range go [UM]
DEL     BEQ     LSSN            ; (a range is needed)
        BSR     RANGE
        LDD     <TMPPT2
        STD     <BINVAL
        JSR     FNDLIN
        STX     <TMPPTR         ; the first to go
DL1     LDD     ,X
        BEQ     DL2
        LDD     2,X
        CMPD    <TMPCNT
        BHI     DL2
        LDX     ,X
        BRA     DL1
DL2     LDU     <TMPPTR         ; X: the first to stay; move the rest down over the gap
DL3     CMPX    <VARTAB
        BHS     DL4
        LDA     ,X+
        STA     ,U+
        BRA     DL3
DL4     STU     <VARTAB
        JSR     RELINK
        JSR     CLRVAR
        JMP     READY

* LSTLIN: print the line at X: its number, a space, the text with its keywords spelt out
LSTLIN  PSHS    X
        LDD     2,X
        JSR     LINPRT
        JSR     SPACE
        LEAX    4,X
LL1     LDA     ,X+
        BEQ     LL3
        BPL     LL2
        LDU     #KWSTMT
        CMPA    #$FF
        BNE     LL1A
        LDA     ,X+
        LDU     #KWFUNC
LL1A    JSR     PRTKW
        BRA     LL1
LL2     JSR     CHROUT
        BRA     LL1
LL3     JSR     CRLF
        PULS    X,PC

* PRTKW: print the keyword of token A from the table at U (each entry: the word, its last letter with
* bit 7 set, then its token)
PRTKW   PSHS    X
PK1     TST     ,U
        BEQ     PKNONE
        TFR     U,X
PK2     TST     ,U+
        BPL     PK2
        CMPA    ,U+
        BNE     PK1
PK3     LDA     ,X+
        PSHS    A
        ANDA    #$7F
        JSR     CHROUT
        TST     ,S+
        BPL     PK3
        PULS    X,PC
PKNONE  LDA     #'!'            ; a token with no keyword (cannot be typed)
        JSR     CHROUT
        PULS    X,PC
