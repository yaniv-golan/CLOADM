* ---------------- the program in memory ----------------
* A line: link to the next line (2), line number (2), crunched text, 0. The program ends with a 0 link;
* VARTAB is just past it [MBF; docs/clean-room-basic.md section 3].

* FNDLIN: find line BINVAL. X = the line (or the first line after it, or the end link); C set if found.
* Uses D (= BINVAL).
FNDLIN  LDD     <BINVAL
        LDX     <TXTTAB
FL1     TST     ,X
        BEQ     FLNO            ; the end (a link's high byte is never 0)
        CMPD    2,X
        BEQ     FLYES
        BLO     FLNO
        LDX     ,X
        BRA     FL1
FLYES   ORCC    #1
        RTS
FLNO    ANDCC   #$FE
        RTS

* EDLINE: a typed line BINVAL with its text at TXTPTR (crunched, 0-terminated): store it, replace the line
* with that number, or delete it when the text is empty.
EDLINE  BSR     FNDLIN
        BCC     ED2
* delete the old line: move everything after it down
        PSHS    X
        LDU     ,X              ; the next line
        EXG     X,U
        BSR     MOVDN
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
        BSR     RELINK          ; (the deletion is kept)
        BSR     CLRVAR
        JMP     OMERR
* open a gap at X: copy from the top down
ED4     LDU     <VARTAB
        LEAY    ,U
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
EDDONE  BSR     RELNKX          ; (the lines before X have not moved: their links stand)
        BRA     CLRVAR

* MOVDN: the bytes from X up to VARTAB moved down to U on; VARTAB is then their new end
MVD1    LDA     ,X+
        STA     ,U+
MOVDN   CMPX    <VARTAB
        BLO     MVD1
        STU     <VARTAB
        RTS

* RELNKE: a program just loaded: it ends at the first line whose link is 0, the end marker, and anything loaded
* after that is not part of it (VARTAB moves down to just past the marker) [BB corpus: the original lists no line
* past it]; then RELINK
RELNKE  LDX     <TXTTAB
RE1     CMPX    <VARTAB
        BHS     RELINK          ; no end marker: the program is all that was loaded
        LDD     ,X
        BEQ     RE3
        LEAX    4,X
RE2     TST     ,X+
        BNE     RE2
        BRA     RE1
RE3     LEAX    2,X
        STX     <VARTAB
* RELINK: rewrite every line's link from the line's own length (RELNKX: from the line at X on)
RELINK  PSHS    D,X,U
        LDX     <TXTTAB
        BRA     RL0
RELNKX  PSHS    D,X,U
RL0     LDD     <VARTAB
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
RL3     CLRA
        CLRB
        STD     ,X
        PULS    D,X,U,PC

* NEWPRG: an empty program
NEWPRG  LDX     <TXTTAB
        CLR     ,X+
        CLR     ,X+
        STX     <VARTAB
* CLRVAR: no variables, all string space free, DATA from the start, CONT impossible, PLAY's defaults
CLRVAR  PSHS    D
        LDD     <VARTAB
        STD     <ARYTAB
        STD     <ARYEND
        LDD     <MEMTOP
        STD     <FRETOP
        JSR     RESTOR          ; DATA from the start
        CLRA
        CLRB
        STD     <OLDTXT
        LDD     <STRBOT         ; CONT impossible: no frames kept
        STD     <BASESP
        JSR     PLINIT          ; PLAY's defaults, then the temporary strings freed (play.inc)
        PULS    D,PC

* ---------------- LIST ----------------
* LIST, LIST n, LIST n-, LIST -n, LIST n-m [UM]
LIST    BSR     RANGE
LS4     LDD     ,X
        BEQ     LSDONE
        LDD     2,X
        CMPD    <TMPCNT
        BHI     LSDONE
        BSR     LSTLIN
        JSR     BRKTST
        BCS     LSBRK
        LDX     ,X
        BRA     LS4
LSDONE  RTS
LSBRK   JMP     READY
LSSN    JMP     <ZSNERR
* RANGE: n, n-, -n, n-m or nothing at the text pointer: from TMPPT2 to TMPCNT (0-65535 when not given)
RANGE   CLRA
        CLRB
        STD     <TMPPT2         ; from: 0
        COMA
        COMB
        STD     <TMPCNT         ; to: 65535
        JSR     <ZCHRGOT
        BEQ     RG3
        BCC     RG1
        JSR     <ZLINGET
        STD     <TMPPT2
        STD     <TMPCNT
        JSR     <ZCHRGOT
        CMPA    #T_MINUS
        BNE     RG3
RG1     CMPA    #T_MINUS
        BNE     LSSN
        JSR     <ZCHRGET
        BEQ     RG2             ; n-
        BCC     LSSN
        JSR     <ZLINGET
        STD     <TMPCNT
        BRA     RG3
RG2     LDD     #$FFFF
        STD     <TMPCNT
RG3     JSR     <ZCHRGOT
        BNE     LSSN
        LDD     <TMPPT2         ; and X: the first line of the range (FNDLIN)
        STD     <BINVAL
        JMP     FNDLIN

* DEL n, DEL n-m, DEL -m, DEL n-: the lines in the range go [UM]
DEL     BEQ     LSSN            ; (a range is needed)
        BSR     RANGE
        STX     <TMPPTR         ; the first to go
DL1     LDD     ,X
        BEQ     DL2
        LDD     2,X
        CMPD    <TMPCNT
        BHI     DL2
        LDX     ,X
        BRA     DL1
DL2     LDU     <TMPPTR         ; X: the first to stay; move the rest down over the gap
        JSR     MOVDN
        JSR     RELINK
        JMP     RNEND

* LSTLIN: print the line at X: its number, a space, the text with its keywords spelt out. At most 249 characters
* of the text are shown (a longer line comes only from a tape), and a line that ends at the right edge of the
* screen is followed by no carriage return of its own (no empty row) [BB corpus: the real records of 36 programs]
LSTLIN  PSHS    X
        LDD     2,X
        JSR     LINPRT
        JSR     SPACE
        CLR     <LSTCNT
        LEAX    4,X
LL1     LDA     ,X+
        BEQ     LL3
        BPL     LL2
        LDU     #KWSTMT
        CMPA    #$FF
        BNE     LL1A
        LDA     ,X+
        LDU     #KWFUNC
LL1A    BSR     PRTKW
        BRA     LL1
LL2     CMPA    #':'            ; the ':' stored before ELSE and ' is not shown
        BNE     LL2A
        LDB     ,X
        CMPB    #T_ELSE
        BEQ     LL1
        CMPB    #T_APOS
        BEQ     LL1
LL2A    BSR     LSTCH
        BRA     LL1
LL3     LDA     <DEVNUM         ; (to the tape, CSAVE ,A: every line ends with its carriage return, at the
        INCA                    ; original's pace, LSDLY [BB bb10 cas-ascii-save, cas-timing: the motor's stop
        BNE     LL3B            ; between the namefile and the text])
        LDX     #LSDLY
        JSR     DELAYX
LL3A    JSR     CRLF
LL4     PULS    X,PC
LL3B    JSR     COLMN           ; (the printer's column on the printer: LLIST)
        BEQ     LL4
        BRA     LL3A
* LSTCH: A to the screen, unless 249 characters of the line are out already. Keeps X, U.
LSTCH   LDB     <LSTCNT
        CMPB    #249
        BHS     LSTC1
        INCB
        STB     <LSTCNT
        JMP     <ZCHROUT
LSTC1   RTS

* PRTKW: print the keyword of token A from the table at U (the words in token order from $80, each one's last
* letter with bit 7 set). Keeps X.
PRTKW   SUBA    #$80
PK1     TST     ,U
        BEQ     PKNONE
        DECA
        BMI     PK3
PK2     TST     ,U+
        BPL     PK2
        BRA     PK1
PK3     LDA     ,U+
        PSHS    A
        ANDA    #$7F
        BSR     LSTCH
        TST     ,S+
        BPL     PK3
        RTS
PKNONE  LDA     #'!'            ; a token with no keyword (cannot be typed)
        BRA     LSTCH

* ---------------- RENUM ----------------
* RENUM [new [, old [, step]]]: the lines from old on (all, by default) are numbered from new (10) in steps of step
* (10), and every reference to them after GO TO, GO SUB, THEN and ELSE (and in ON's lists) follows [UM]; a number
* after RUN or RESTORE is left as it is [BB bb2 renum]. ?FC ERROR when the new numbers would run into the lines
* before old or past 63999, or the step is 0.
* A reference to a line that does not exist is left as it is [OWN].
RENUM   LDD     #10
        STD     <RNNEW
        STD     <RNINC
        CLRA
        CLRB
        STD     <RNOLD
        JSR     <ZCHRGOT
        BEQ     RNA3
        BCC     RNA1
        JSR     <ZLINGET
        STD     <RNNEW
RNA1    JSR     <ZCHKCOM
        BNE     RNA3
        JSR     <ZCHRGET
        BCC     RNA2
        JSR     <ZLINGET
        STD     <RNOLD
RNA2    JSR     <ZCHKCOM
        BNE     RNA3
        JSR     <ZCHRGET
        JSR     <ZLINGET
        STD     <RNINC
RNA3    JSR     ENDCHK
        LDD     <RNINC
        LBEQ    FCERR
* the lines before old must stay below new; count the lines to renumber
        CLRA
        CLRB
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
        BEQ     RNEND           ; nothing to renumber
        SUBD    #1              ; the last new number: new + (count - 1) x step, up to 63999
        BSR     RNMUL
        ADDD    <RNNEW
        LBCS    FCERR
        CMPD    #63999
        LBHI    FCERR
* the references, by the old numbers (the lines keep them until the end)
        LDX     <TXTTAB
RNB1    LDD     ,X
        BEQ     RNB9
        LEAX    4,X
RNB2    JSR     NXTOK
        BEQ     RNB1
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
        CLRA
        CLRB
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
        TFR     Y,X
        JSR     MOVDN
RNR8    PULS    B
        LDU     ,S++            ; the digits' start: the new digits go there
        LDX     #FBUFFR+19      ; (the digits end at FBUFFR+18: LINSTR)
        NEGB
        LEAX    B,X
        NEGB
        JSR     CPYXU
        TFR     U,X
        JMP     RELINK          ; (the links again: the text moved)
