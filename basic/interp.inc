* ---------------- the main loop and the statement runner ----------------

* READY: print OK and take lines
READY   LDS     <STRBOT
        JSR     RSTTMP
        LDD     #$FFFF
        STD     <CURLIN
        JSR     NEWLIN
        LDX     #OKMSG
        JSR     PRTSTR
* MAIN: one typed line: a numbered line goes into the program, anything else runs at once
MAIN    LDS     <STRBOT
        CLR     <JMPFLG
        LDD     #$FFFF
        STD     <CURLIN
        JSR     LINEIN
        BCS     MAIN            ; BREAK: the line is dropped
        JSR     CRUNCH          ; LINBUF -> CRNBUF; B = its length with the 0
        LDX     #CRNBUF-1
        STX     <TXTPTR
        JSR     CHRGET
        BEQ     MAIN            ; an empty line
        BCC     DIRECT
        JSR     LINGET          ; a line number: BINVAL
        JSR     EDLINE          ; store, replace or delete the line
        BRA     MAIN
DIRECT  LDA     #1
        STA     <DIRFLG
        LDX     <TXTPTR
        LEAX    -1,X
        STX     <TXTPTR
        BRA     NEWST1
OKMSG   FCC     "OK"
        FCB     13,0

* NEWSTT: the next statement. Statements are called from here and return here (RTS) with the text pointer
* on the character after them; the stack below this point holds only FOR and GOSUB frames. A statement that
* jumps (GOTO and the others) points the text pointer at the byte before a line's text and sets JMPFLG.
NEWSTT  LDX     <TXTPTR
        LDA     ,X
        BEQ     NEWEOL
        CMPA    #':'
        BEQ     NEWST1
        JMP     SNERR           ; something after a complete statement
NEWEOL  LDD     <CURLIN
        CMPD    #$FFFF
        BEQ     DIREND          ; the end of a direct line
        LDD     1,X             ; the next line's link: 0 is the end of the program
        BEQ     PRGEND
        LDD     3,X
        STD     <CURLIN
        LEAX    4,X
        STX     <TXTPTR
        BSR     TRCLIN
NEWST1  JSR     BRKCHK
NEWST2  JSR     CHRGET
        BSR     EXECST
        TST     <JMPFLG
        BEQ     NEWSTT
NEWJMP  CLR     <JMPFLG
        BSR     TRCLIN
        BRA     NEWST1
DIREND  CLR     <DIRFLG
        JMP     READY
PRGEND  JMP     ENDRUN
* TRON: each line's number in brackets as it starts [UM]
TRCLIN  TST     <TRCFLG
        BEQ     TRC1
        LDA     #'['
        JSR     CHROUT
        LDD     <CURLIN
        JSR     LINPRT
        LDA     #']'
        JSR     CHROUT
TRC1    RTS

* EXECST: run the statement starting with A (CHRGET's flags)
EXECST  BEQ     EXRTS           ; an empty statement
        TSTA
        BPL     EXLET           ; a variable: LET
        CMPA    #T_LAST
        BHI     EXSN
        SUBA    #$80
        LDX     #STMTDS
        LSLA
        BCC     EX1
        LEAX    256,X           ; (tokens $C0 and up)
EX1     LDX     A,X
        JSR     CHRGET          ; past the token
        JMP     ,X
EXLET   JMP     LET
EXSN    JMP     SNERR
EXRTS   RTS

* the statements and functions that come later in this phase, or in P2
UNIMPL  JMP     FCERR

* CHRGET: the next character after spaces. A = it; Z set at the end of a statement (0 or ':');
* C set for a digit. Keeps every other register.
CHRGET  PSHS    X
        LDX     <TXTPTR
CG1     LEAX    1,X
        LDA     ,X
        CMPA    #' '
        BEQ     CG1
        STX     <TXTPTR
        PULS    X
        BRA     CGFLAG
* CHRGOT: the character at the text pointer again, with the same flags
CHRGOT  PSHS    X
        LDX     <TXTPTR
        LDA     ,X
        PULS    X
CGFLAG  CMPA    #':'
        BHS     CG2             ; ':' and above: no digit; Z set for ':'
        SUBA    #'0'
        SUBA    #-'0'           ; C set for '0'-'9', Z set for 0; A unchanged
CG2     RTS

* SYNCHR: the character at the text pointer must be B; take it and the next one
SYNCHR  CMPB    [TXTPTR]
        BNE     SYNERR
        JMP     CHRGET
SYNERR  JMP     SNERR

* LINGET: a line number at the text pointer into BINVAL (and D); ?SN ERROR at 64000 and over [UM].
* Leaves the text pointer on the first character after it, with CHRGOT's flags.
LINGET  CLR     <BINVAL
        CLR     <BINVAL+1
        JSR     CHRGOT
LG1     BCC     LG2
        SUBA    #'0'
        PSHS    A
        LDD     <BINVAL
        CMPD    #6399           ; another digit would reach 64000 or more
        BHI     LGERR
        ASLB                    ; x 10
        ROLA
        ASLB
        ROLA
        ADDD    <BINVAL
        ASLB
        ROLA
        ADDB    ,S+
        ADCA    #0
        STD     <BINVAL
        JSR     CHRGET
        BRA     LG1
LG2     LDD     <BINVAL
        RTS
LGERR   JMP     SNERR

* ---------------- END, STOP, CONT, REM, TRON, TROFF ----------------
* CONTMD: 0 = CONT goes on after the statement at OLDTXT (STOP, END); 1 = OLDTXT is just before a statement
* (BREAK between statements)
END     BNE     SYNERR
        CLR     <CONTMD
        LDD     <CURLIN
        CMPD    #$FFFF
        BEQ     ENDRUN
        LDD     <TXTPTR
        STD     <OLDTXT
        LDD     <CURLIN
        STD     <OLDLIN
ENDRUN  CLR     <DIRFLG
        JMP     READY

STOP    BNE     SYNERR
        CLR     <CONTMD
        BRA     STOP0
STOPBK  LDA     #1              ; BREAK, from BRKCHK at NEWST1
        STA     <CONTMD
STOP0   LDD     <CURLIN
        CMPD    #$FFFF
        BEQ     STOP1
        STD     <OLDLIN
        LDD     <TXTPTR
        STD     <OLDTXT
STOP1   JSR     NEWLIN
        LDX     #BRKMSG
        JSR     PRTSTR
        LDD     <CURLIN
        CMPD    #$FFFF
        BEQ     STOP2
        JSR     PRTIN
STOP2   JSR     CRLF
        JMP     READY
BRKMSG  FCN     "BREAK"

CONT    LBNE    SNERR
        LDD     <OLDTXT
        BNE     CONT1
        JMP     CNERR
CONT1   STD     <TXTPTR
        LDD     <OLDLIN
        STD     <CURLIN
        LDS     <STRBOT
        TST     <CONTMD
        BEQ     CONT2
        JMP     NEWST2
CONT2   JMP     NEWSTT

* REM and ': the rest of the line is a remark
REM     LDX     <TXTPTR
REM1    LDA     ,X
        BEQ     REM2
        LEAX    1,X
        BRA     REM1
REM2    STX     <TXTPTR
        RTS

* DATA when run: skipped to the end of the statement (READ finds it) [UM]
DATAST  LDX     <TXTPTR
DS1     LDA     ,X
        BEQ     DS3
        CMPA    #':'
        BEQ     DS3
        CMPA    #'"'
        BNE     DS2
DS1Q    LEAX    1,X
        LDA     ,X
        BEQ     DS3
        CMPA    #'"'
        BNE     DS1Q
DS2     LEAX    1,X
        BRA     DS1
DS3     STX     <TXTPTR
        RTS

TRON    LDA     #$FF
        BRA     TROF1
TROFF   CLRA
TROF1   STA     <TRCFLG
        JMP     CHRGOT

* ---------------- GOTO, GOSUB, RETURN ----------------
* GO TO n / GO SUB n
GO      CMPA    #T_TO
        BEQ     GOTO
        CMPA    #T_SUB
        BEQ     GOSUB
        JMP     SNERR
GOTO    JSR     CHRGET
GOTO1   BCC     GOSN
        JSR     LINGET
* JUMPTO: go to line BINVAL (?UL ERROR if there is none)
JUMPTO  JSR     FNDLIN          ; X = the line, C set if found
        BCS     JMP1
        JMP     ULERR
JMP1    LEAX    3,X             ; the byte before the line's text
        STX     <TXTPTR
        LDD     <BINVAL
        STD     <CURLIN
        LDA     #1
        STA     <JMPFLG
        RTS
GOSN    JMP     SNERR

* a GOSUB frame on the stack: marker, CURLIN, TXTPTR (on the character after the line number) [OWN]
GOSUB   JSR     CHRGET
        BCC     GOSN
        JSR     LINGET
        PULS    U               ; NEWSTT's return address
        JSR     CHKSTK
        LDX     <TXTPTR
        PSHS    X
        LDD     <CURLIN
        PSHS    D
        LDA     #T_GO
        PSHS    A
        PSHS    U
        BRA     JUMPTO

RETURN  BNE     GOSN
        PULS    U
RET1    CMPS    <STRBOT
        BHS     RGERR
        LDA     ,S
        CMPA    #T_GO
        BEQ     RET2
        LEAS    FORSIZ,S        ; a FOR frame inside the subroutine: dropped
        BRA     RET1
RET2    LDD     1,S
        STD     <CURLIN
        LDX     3,S
        STX     <TXTPTR
        LEAS    5,S
        PSHS    U
        RTS
RGERR   LDB     #ERR_RG
        JMP     ERROR

* CHKSTK: room for another frame (and expression work) between the arrays and the stack, or ?OM ERROR
CHKSTK  PSHS    D
        TFR     S,D
        SUBD    #64
        CMPD    <ARYEND
        BLO     CHKOM
        PULS    D,PC
CHKOM   JMP     OMERR

FORSIZ  EQU     17

* ---------------- RUN, NEW, CLS ----------------
RUN     BEQ     RUN1
        BCC     RUNSN
        JSR     CLRVAR          ; RUN n
        LDS     <STRBOT
        JSR     GOTO1
        JMP     NEWJMP
RUN1    JSR     CLRVAR
        LDS     <STRBOT
        LDX     <TXTTAB
        LEAX    -1,X            ; the 0 before the program: NEWSTT takes the first line
        STX     <TXTPTR
        LDD     #0
        STD     <CURLIN
        JMP     NEWSTT
RUNSN   JMP     SNERR

NEW     BNE     RUNSN
        JSR     NEWPRG
        JMP     READY

CLSST   JSR     CLS
        JMP     CHRGOT

* LET: a variable is assigned (M4)
LET     JMP     SNERR
* RSTTMP: free the string temporaries (M5)
RSTTMP  RTS
