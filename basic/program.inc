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
        JSR     CLRVAR
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
        LDD     <STRBOT         ; CONT impossible: no frames kept
        STD     <BASESP
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

* ---------------- RENUM ----------------
* RENUM [new [, old [, step]]]: the lines from old on (all, by default) are numbered from new (10) in steps of step
* (10), and every reference to them after GO TO, GO SUB, THEN, ELSE, RUN and RESTORE (and in ON's lists) follows
* [UM]. ?FC ERROR when the new numbers would run into the lines before old or past 63999, or the step is 0.
* A reference to a line that does not exist is left as it is [OWN].
RENUM   LDD     #10
        STD     <RNNEW
        STD     <RNINC
        LDD     #0
        STD     <RNOLD
        JSR     CHRGOT
        BEQ     RNA3
        BCC     RNA1
        JSR     LINGET
        STD     <RNNEW
RNA1    JSR     CHRGOT
        CMPA    #','
        BNE     RNA3
        JSR     CHRGET
        BCC     RNA2
        JSR     LINGET
        STD     <RNOLD
RNA2    JSR     CHRGOT
        CMPA    #','
        BNE     RNA3
        JSR     CHRGET
        JSR     LINGET
        STD     <RNINC
RNA3    JSR     CHRGOT
        LBNE    SNERR
        LDD     <RNINC
        LBEQ    FCERR
* the lines before old must stay below new; count the lines to renumber
        LDD     #0
        STD     <TMPCNT
        LDX     <TXTTAB
RNC1    LDD     ,X
        BEQ     RNC3
        LDD     2,X
        CMPD    <RNOLD
        BHS     RNC2
        CMPD    <RNNEW
        LBHS    FCERR
        BRA     RNC2A
RNC2    LDD     <TMPCNT
        ADDD    #1
        STD     <TMPCNT
RNC2A   LDX     ,X
        BRA     RNC1
RNC3    LDD     <TMPCNT
        LBEQ    RNEND           ; nothing to renumber
        SUBD    #1              ; the last new number: new + (count - 1) x step, up to 63999
        JSR     RNMUL
        ADDD    <RNNEW
        LBCS    FCERR
        CMPD    #63999
        LBHI    FCERR
* the references, by the old numbers (the lines keep them until the end)
        LDX     <TXTTAB
RNB1    LDD     ,X
        BEQ     RNB9
        LEAX    4,X
RNB2    LDA     ,X+
        BEQ     RNB1
        CMPA    #'"'
        BNE     RNB3
RNBQ    LDA     ,X+             ; a string
        BEQ     RNB1
        CMPA    #'"'
        BNE     RNBQ
        BRA     RNB2
RNB3    CMPA    #$FF            ; a function: its byte
        BNE     RNB4
        LEAX    1,X
        BRA     RNB2
RNB4    CMPA    #T_REM
        BEQ     RNBR
        CMPA    #T_APOS
        BNE     RNB5
RNBR    LDA     ,X+             ; a remark: the rest of the line
        BNE     RNBR
        BRA     RNB1
RNB5    CMPA    #T_DATA
        BNE     RNB6
RNBD    LDA     ,X              ; DATA: up to the next ':'
        BEQ     RNB2
        LEAX    1,X
        CMPA    #':'
        BNE     RNBD
        BRA     RNB2
RNB6    CMPA    #T_GO
        BNE     RNB7
        BSR     RNSPC
        LDA     ,X
        CMPA    #T_TO
        BEQ     RNB6A
        CMPA    #T_SUB
        BNE     RNB2
RNB6A   LEAX    1,X
RNBL    BSR     RNREF           ; a list: ON ... GO TO a, b, c
        BSR     RNSPC
        LDA     ,X
        CMPA    #','
        BNE     RNB2
        LEAX    1,X
        BRA     RNBL
RNB7    CMPA    #T_THEN
        BEQ     RNB8
        CMPA    #T_ELSE
        BEQ     RNB8
        CMPA    #T_RUN
        BEQ     RNB8
        CMPA    #T_RESTORE
        BNE     RNB2
RNB8    BSR     RNREF
        BRA     RNB2
* the new numbers
RNB9    LDX     <TXTTAB
        LDD     <RNNEW
        STD     <TMPPT2
RNN1    LDD     ,X
        BEQ     RNEND
        LDD     2,X
        CMPD    <RNOLD
        BLO     RNN2
        LDD     <TMPPT2
        STD     2,X
        ADDD    <RNINC
        STD     <TMPPT2
RNN2    LDX     ,X
        BRA     RNN1
RNEND   JSR     CLRVAR
        JMP     READY
* RNMUL: D = D x step
RNMUL   LDX     <RNINC
        PSHS    X
        JSR     MUL16
        LEAS    2,S
        RTS
* RNSPC: X past spaces
RNSPC   LDA     ,X
        CMPA    #' '
        BNE     RNS1
        LEAX    1,X
        BRA     RNSPC
RNS1    RTS
* RNREF: a line number at X (after spaces), if any, rewritten as its line's new number; X ends after it
RNREF   BSR     RNSPC
        PSHS    X               ; where the digits start
        LDD     #0
        STD     <BINVAL
RNR1    LDA     ,X
        SUBA    #'0'
        BLO     RNR2
        CMPA    #9
        BHI     RNR2
        LEAX    1,X
        PSHS    A
        LDD     <BINVAL         ; x 10 + the digit (a number too big for a line just finds none)
        LSLB
        ROLA
        PSHS    D
        LSLB
        ROLA
        LSLB
        ROLA
        ADDD    ,S++
        ADDB    ,S+
        ADCA    #0
        STD     <BINVAL
        BRA     RNR1
RNR2    TFR     X,D
        SUBD    ,S              ; the old digits' length
        STB     <RNLEN
        BEQ     RNRNO           ; no number here
        LDD     <BINVAL         ; its line's new number
        CMPD    <RNOLD
        BLO     RNRNO
        LDX     <TXTTAB
        LDU     #0              ; the index among the lines renumbered
RNR3    LDD     ,X
        BEQ     RNRNO           ; no such line: left as it is
        LDD     2,X
        CMPD    <RNOLD
        BLO     RNR4
        CMPD    <BINVAL
        BEQ     RNR5
        LEAU    1,U
RNR4    LDX     ,X
        BRA     RNR3
RNRNO   PULS    D               ; (X is past the digits again below)
        TFR     D,X
        LDB     <RNLEN
        ABX
        RTS
RNR5    TFR     U,D
        BSR     RNMUL
        ADDD    <RNNEW
        JSR     LINSTR          ; X: the new digits, B: how many
        PSHS    B
        SUBB    <RNLEN          ; the change in length
        BEQ     RNR8
        SEX
        PSHS    D
        ADDD    <VARTAB         ; room for it
        JSR     ROOMCK
        PULS    D
        PSHS    D
        LDY     3,S             ; the digits' start
        LDB     <RNLEN
        LEAY    B,Y             ; the text after the old digits
        PULS    D
        TSTA
        BMI     RNR7
        LDU     <VARTAB         ; longer: move the rest up, from the top down
        PSHS    Y
        LEAY    D,U
        STY     <VARTAB
RNR6    CMPU    ,S
        BLS     RNR6A
        LDA     ,-U
        STA     ,-Y
        BRA     RNR6
RNR6A   LEAS    2,S
        BRA     RNR8
RNR7    LEAU    D,Y             ; shorter: move the rest down
RNR7A   CMPY    <VARTAB
        BHS     RNR7B
        LDA     ,Y+
        STA     ,U+
        BRA     RNR7A
RNR7B   STU     <VARTAB
RNR8    PULS    B
        LDU     ,S++            ; the digits' start: the new digits go there
        LDX     #LNSBUF
RNR9    LDA     ,X+
        STA     ,U+
        DECB
        BNE     RNR9
        TFR     U,X
        JMP     RELINK          ; (the links again: the text moved)
