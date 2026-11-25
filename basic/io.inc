* ---------------- READ, DATA, RESTORE, INPUT, LINE INPUT ----------------

* GETITM: the next item of a list (DATA, or a typed INPUT line) for a variable of type VALTYP, the text pointer on
* the character before it. A number by FIN; a string in quotes, or up to the next ',' (and ':' when ITMCOL is
* set) or the end. The text pointer ends on the character after the item. C set if a number was badly formed.
GETITM  JSR     CHRGET
        TST     <VALTYP
        BNE     GI2
        JSR     FIN
        JSR     CHRGOT          ; a number must end the item
        BEQ     GIOK0
        CMPA    #','
        BEQ     GIOK
        ORCC    #1
        RTS
GIOK0   TST     <ITMCOL         ; (CHRGOT's Z is also set by ':' and ELSE: in a typed line those are text)
        BNE     GIOK
        TSTA
        BEQ     GIOK
        ORCC    #1
        RTS
GI2     LDX     <TXTPTR
        CMPA    #'"'
        BNE     GI4
        LEAX    1,X             ; in quotes
        PSHS    X
        CLRB
GI3     LDA     ,X
        BEQ     GI3A
        CMPA    #'"'
        BEQ     GI3B
        INCB
        LEAX    1,X
        BRA     GI3
GI3B    LEAX    1,X
GI3A    STX     <TXTPTR
        PULS    X
        JSR     MKTMP
        JSR     CHRGOT
        BRA     GIOK
GI4     PSHS    X               ; to the next ',' (or ':')
        CLRB
GI5     LDA     ,X
        BEQ     GI6
        CMPA    #','
        BEQ     GI6
        CMPA    #':'
        BNE     GI5A
        TST     <ITMCOL
        BNE     GI6
GI5A    INCB
        LEAX    1,X
        BRA     GI5
GI6     STX     <TXTPTR
        PULS    X
        JSR     MKTMP
GIOK    ANDCC   #$FE
        RTS

* READ variable, ...: each takes the next DATA item (?OD ERROR when there are no more)
READ    LDA     #1
        STA     <ITMCOL
RD1     LDA     #1
        STA     <VARCRE
        JSR     PTRGET
        CLR     <VARCRE
        PSHS    X
        LDD     <TXTPTR         ; the program's text pointer kept; the DATA pointer used instead
        PSHS    D
        LDX     <DATPTR
        LDA     ,X
        CMPA    #','
        BEQ     RD4
* the next DATA statement: from here to its token (a function's byte after $FF is skipped)
RD2     LDA     ,X+
        BNE     RD3
        LDD     ,X              ; the end of a line: the next one
        BNE     RD2A
        LDB     #ERR_OD
        JMP     ERROR
RD2A    LDD     2,X
        STD     <DATLIN
        LEAX    4,X
        BRA     RD2
RD3     CMPA    #$FF
        BNE     RD3A
        LEAX    1,X
        BRA     RD2
RD3A    CMPA    #'"'
        BNE     RD3C
RD3B    LDA     ,X+             ; a string: skipped
        BEQ     RD3D
        CMPA    #'"'
        BNE     RD3B
        BRA     RD2
RD3D    LEAX    -1,X
        BRA     RD2
RD3C    CMPA    #T_REM
        BEQ     RD3E
        CMPA    #T_APOS
        BNE     RD3F
RD3E    LDA     ,X+             ; a remark: to the end of the line
        BNE     RD3E
        LEAX    -1,X
        BRA     RD2
RD3F    CMPA    #T_DATA
        BNE     RD2
        LEAX    -1,X            ; on the DATA token: the item follows
RD4     STX     <TXTPTR
        JSR     GETITM
        BCC     RD5
        LDD     <DATLIN         ; a bad number in DATA: ?SN ERROR in the DATA's line
        STD     <CURLIN
        JMP     SNERR
RD5     LDD     <TXTPTR
        STD     <DATPTR
        PULS    D
        STD     <TXTPTR
        PULS    X
        JSR     ASSIGN
        JSR     CHRGOT
        CMPA    #','
        BNE     RD6
        JSR     CHRGET
        LBRA    RD1
RD6     RTS

* RESTORE [line]: READ starts again from the first DATA (of the program, or from that line on) [UM]
RESTOR  BEQ     RS9
        JSR     LINGET
        JSR     FNDLIN
        LBCC    ULERR
        LEAX    -1,X            ; (the 0 at the end of the line before)
        STX     <DATPTR
        RTS
RS9     LDD     <TXTTAB
        SUBD    #1
        STD     <DATPTR
        RTS

* INPUT ["prompt";] variable, ...: "? " (after the prompt), then a line typed; items separated by commas;
* "??" asks for more when the line ran out, ?REDO when a number was badly formed (the whole INPUT again),
* ?EXTRA IGNORED when there were too many [UM]. Only in a program (?ID ERROR). BREAK stops the program.
INPUT   LDB     #1
        BRA     INP0
LNINP   CLRB                    ; LINE INPUT: the whole line into one string
INP0    STB     <INPKND
        LDD     <CURLIN
        CMPD    #$FFFF
        LBEQ    IDERR
        CLR     <ITMCOL
        JSR     CHRGOT
        CMPA    #'"'
        BNE     INP1
        JSR     STRLIT          ; the prompt
        LDB     #';'
        JSR     SYNCHR0
        JSR     FRESTR
        JSR     PRTN
INP1    LDD     <TXTPTR         ; where the variables are listed
        STD     <INPVAR
        STD     <INPST
INP2    TST     <INPKND
        BEQ     INP2A
        LDX     #QMSG
        JSR     PRTSTR
INP2A   JSR     INLINE
        LDX     #LINBUF-1
        STX     <INPPTR
        LDD     <INPVAR
        STD     <TXTPTR
        TST     <INPKND
        BEQ     LNI1
* each variable takes the next item
INP3    LDA     #1
        STA     <VARCRE
        JSR     PTRGET
        CLR     <VARCRE
        PSHS    X
        LDD     <TXTPTR
        STD     <INPVAR
        LDX     <INPPTR
        STX     <TXTPTR
        CMPX    #LINBUF-1       ; the first item
        BEQ     INP3B
        LDA     ,X              ; the typed line ran out: ?? and another
        CMPA    #','
        BEQ     INP3B
INP3A   LDX     #QQMSG
        JSR     PRTSTR
        JSR     INLINE
        LDX     #LINBUF-1
        STX     <TXTPTR
INP3B   JSR     GETITM
        BCC     INP4
        LEAS    2,S             ; ?REDO: the whole INPUT again
        LDX     #REDOMS
        JSR     PRTSTR
        LDD     <INPST
        STD     <INPVAR
        BRA     INP2
INP4    LDD     <TXTPTR
        STD     <INPPTR
        LDD     <INPVAR
        STD     <TXTPTR
        PULS    X
        JSR     ASSIGN
        JSR     CHRGOT
        CMPA    #','
        BNE     INP5
        JSR     CHRGET
        BRA     INP3
INP5    LDX     <INPPTR         ; anything left over?
        LDA     ,X
        BEQ     INP6
        LDX     #EXTRMS
        JSR     PRTSTR
INP6    RTS
* LINE INPUT: the whole line, as typed
LNI1    LDA     #1
        STA     <VARCRE
        JSR     PTRGET
        CLR     <VARCRE
        JSR     CHKSTR
        PSHS    X
        LDX     #LINBUF
        CLRB
LNI2    TST     B,X
        BEQ     LNI3
        INCB
        BRA     LNI2
LNI3    JSR     MKTMP           ; (STRKEEP copies it: a typed line is not program text)
        PULS    X
        JMP     ASSIGN
* INLINE: a line typed for INPUT; BREAK stops the program
INLINE  JSR     LINEIN
        LBCS    STOPBK
        RTS
QMSG    FCN     "? "
QQMSG   FCN     "?? "
REDOMS  FCC     "?REDO"
        FCB     13,0
EXTRMS  FCC     "?EXTRA IGNORED"
        FCB     13,0

* LINE: LINE INPUT here; the graphics LINE comes in P2
LINE    CMPA    #T_INPUT
        LBNE    UNIMPL
        JSR     CHRGET
        JMP     LNINP
