* ---------------- the main loop and the statement runner ----------------

* READY: print OK and take lines
READY   LDS     <BASESP         ; (above it: the FOR and GOSUB frames CONT needs, or nothing)
        JSR     TXTSCR          ; back to the text screen (an error comes here too)
        JSR     RSTTMP
        LDD     #$FFFF
        STD     <CURLIN
        JSR     NEWLIN
        LDX     #OKMSG
        JSR     <ZPRTSTR
* MAIN: one typed line: a numbered line goes into the program, anything else runs at once
MAIN    LDS     <BASESP
        CLR     <JMPFLG
        LDD     #$FFFF
        STD     <CURLIN
        JSR     LINEIN
        BCS     MAIN            ; BREAK: the line is dropped
        JSR     CRUNCH          ; LINBUF -> CRNBUF; B = its length with the 0
        LDX     #CRNBUF-1
        STX     <TXTPTR
        JSR     <ZCHRGET
        BEQ     MAIN            ; an empty line
        BCC     DIRECT
        JSR     <ZLINGET          ; a line number: BINVAL
        JSR     EDLINE          ; store, replace or delete the line
        BRA     MAIN
DIRECT  LDX     <TXTPTR
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
        CMPA    #T_ELSE         ; the end of a THEN part: the rest of the line is skipped
        BNE     NEWSN
        JSR     REM
        BRA     NEWSTT
NEWSN   JMP     SNERR           ; something after a complete statement
NEWEOL  JSR     DIRCHK
        BEQ     DIREND          ; the end of a direct line
        LDD     1,X             ; the next line's link: 0 is the end of the program
        BEQ     PRGEND
        LDD     3,X
        STD     <CURLIN
        LEAX    4,X
        STX     <TXTPTR
        BSR     TRCLIN
NEWST1  JSR     BRKCHK
NEWST2  JSR     RSTTMP
        STS     <FRMSP          ; the stack and the text where this statement starts (BREAK in INPUT)
        LDX     <TXTPTR
        STX     <STMTXT
        BSR     CHRGET
        BSR     EXECST
        TST     <JMPFLG
        BEQ     NEWSTT
NEWJMP  CLR     <JMPFLG
        BSR     TRCLIN
        BRA     NEWST1
DIREND  JMP     READY
PRGEND  JSR     END1            ; the end of the program is an END: CONT there ends again [BB bb1 flow-cont]
* TRON: each line's number in brackets as it starts [UM]
TRCLIN  TST     <TRCFLG
        BEQ     TRC1
        LDA     #'['
        JSR     <ZCHROUT
        LDD     <CURLIN
        JSR     LINPRT
        LDA     #']'
        JSR     <ZCHROUT
TRC1    RTS

* EXECST: run the statement starting with A (CHRGET's flags)
EXECST  BEQ     EXRTS           ; an empty statement
        TSTA
        BPL     EXLET           ; a variable: LET
        CMPA    #$FF
        BEQ     EXFUNC
        CMPA    #T_SLAST        ; the words that are not statements (TO, THEN, the operators): ?SN ERROR
        BHI     EXSN
        TFR     A,B
        ASLB                    ; (the token's bit 7 goes: twice its place in the table)
        LDX     #STMTDS
        ABX
        LDX     ,X
        BSR     CHRGET          ; past the token
        JMP     ,X
EXLET   JMP     LET
EXFUNC  BSR     CHRGET          ; a function name as a statement: TIMER = n
        CMPA    #T_TIMERF
        BNE     EXSN
        BSR     CHRGET
        JMP     TIMERS
EXSN    JMP     SNERR
EXRTS   RTS

* the statements and functions that come later in this phase, or in P2
UNIMPL  JMP     FCERR

* CHRGET: the next character after spaces. A = it; Z set at the end of a statement (0 or ':');
* C set for a digit. Keeps every other register.
CHRGET  INC     <TXTPTR+1
        BNE     CG1
        INC     <TXTPTR
CG1     LDA     [TXTPTR]
        CMPA    #' '
        BEQ     CHRGET
        BRA     CGFLAG
* CHRGOT: the character at the text pointer again, with the same flags
CHRGOT  LDA     [TXTPTR]
CGFLAG  CMPA    #T_ELSE         ; ELSE ends a statement too
        BEQ     CG2
        CMPA    #':'
        BHS     CG2             ; ':' and above: no digit; Z set for ':'
        SUBA    #'0'
        SUBA    #-'0'           ; C set for '0'-'9', Z set for 0; A unchanged
CG2     RTS

* CHKCOM: CHRGOT, and Z set for a ','
CHKCOM  BSR     CHRGOT
        CMPA    #','
        RTS
* ENDCHK: the statement must end here (?SN ERROR)
ENDCHK  BSR     CHRGOT
        BNE     SYNERR
        RTS
* SYNCHR: the character at the text pointer must be B; take it and the next one. SYNEQ: it must be =
SYNEQ   LDB     #T_EQ
SYNCHR  CMPB    [TXTPTR]
        BNE     SYNERR
        BRA     CHRGET
SYNERR  JMP     SNERR
* DIRCHK: D = the line running; Z set in direct mode
DIRCHK  LDD     <CURLIN
        CMPD    #$FFFF
        RTS

* LINGET: a line number at the text pointer into BINVAL (and D); ?SN ERROR at 64000 and over [UM].
* Leaves the text pointer on the first character after it, with CHRGOT's flags.
LINGET  CLR     <BINVAL
        CLR     <BINVAL+1
        BSR     CHRGOT
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
        BSR     CHRGET
        BRA     LG1
LG2     LDD     <BINVAL
        RTS
LGERR   JMP     SNERR

* ---------------- END, STOP, CONT, REM, TRON, TROFF ----------------
* CONTMD: 0 = CONT goes on after the statement at OLDTXT (STOP, END); 1 = OLDTXT is just before a statement
* (BREAK). BASESP keeps the stack as it was, so the FOR and GOSUB frames are there for CONT.
END     BNE     SYNERR
END1    CLR     <CONTMD
        BSR     DIRCHK
        BEQ     ENDRUN
        LDD     <TXTPTR
        STD     <OLDTXT
        LDD     <CURLIN
        STD     <OLDLIN
        LEAX    2,S             ; (under NEWSTT's return address: the frames)
        STX     <BASESP
ENDRUN  JMP     READY

STOP    BNE     SYNERR
        CLR     <CONTMD
        LEAX    2,S
        BRA     STOP0X
STOPIN  LDD     <STMTXT         ; BREAK while INPUT waits: CONT runs the INPUT again
        STD     <TXTPTR
        LDX     <FRMSP
        BRA     STOPB1
STOPBK  LEAX    2,S             ; BREAK, from BRKCHK at NEWST1
STOPB1  LDA     #1
        STA     <CONTMD
STOP0X  STX     <BASESP
STOP0   BSR     DIRCHK
        BEQ     STOP1
        STD     <OLDLIN
        LDD     <TXTPTR
        STD     <OLDTXT
STOP1   LDX     #BRKMSG
        JSR     <ZPRTSTR
        BSR     DIRCHK
        BEQ     STOP2
        JSR     PRTIN
STOP2   JSR     CRLF
        JMP     READY
BRKMSG  FCB     13              ; one CR whatever the column: an empty line at the start of a line, else it ends
*                                 the line [BB bb1 flow-cont, bb2 flow-stop-col]
        FCN     "BREAK"

CONT    LBNE    SNERR
        LDD     <OLDTXT
        BNE     CONT1
        JMP     CNERR
CONT1   STD     <TXTPTR
        LDD     <OLDLIN
        STD     <CURLIN
        LDS     <BASESP
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
        JMP     <ZCHRGOT

* ---------------- GOTO, GOSUB, RETURN ----------------
* GO TO n / GO SUB n
GO      CMPA    #T_TO
        BEQ     GOTO
        CMPA    #T_SUB
        BEQ     GOSUB
        JMP     SNERR
GOTO    JSR     <ZCHRGET
GOTO1   BCC     GOSN
        JSR     <ZLINGET
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
GOSUB   JSR     <ZCHRGET
        BCC     GOSN
        JSR     <ZLINGET
        PULS    U               ; NEWSTT's return address
        BSR     CHKSTK
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
        JSR     <ZLINGET          ; RUN n
        JSR     CLRVAR
        LDS     <STRBOT
        BSR     JUMPTO
        JMP     NEWJMP
RUN1    JSR     CLRVAR
        LDS     <STRBOT
        LDX     <TXTTAB
        LEAX    -1,X            ; the 0 before the program: NEWSTT takes the first line
        STX     <TXTPTR
        CLRA
        CLRB
        STD     <CURLIN
        JMP     NEWSTT
RUNSN   JMP     SNERR

NEW     BNE     RUNSN
        JSR     NEWPRG
        JMP     READY

* CLS [c]: the screen cleared, or filled with colour c's block: 0 black, 1-8 green ... orange [UM]; a block is the
* semigraphics-4 character with all four elements lit, its colour in bits 4-6 [HW: the MC6847 data sheet]. A colour
* 9-255 is no error: one line of text, then an empty line [BB bb2, screen-cls-range: the original's shape]; ours
* prints our own banner there, never the original's text (a deliberate difference). Past 255, ?FC ERROR (GETBYT).
CLSST   JSR     <ZCHRGOT
        BEQ     CLSS1
        JSR     GETBYT
        CMPB    #8
        BHI     CLSBIG
        LDA     #$80            ; 0: black, no element lit
        DECB
        BMI     CLSS0
        LDA     #16
        MUL
        ORB     #$8F
        TFR     B,A
CLSS0   TFR     A,B
        JSR     CLSC
        JMP     <ZCHRGOT
CLSS1   JSR     CLS
        JMP     <ZCHRGOT
CLSBIG  LDX     #BANNER
        JSR     PRTSTR
        JSR     CRLF
        JMP     <ZCHRGOT

