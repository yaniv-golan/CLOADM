* ---------------- strings ----------------
* A string descriptor: 5 bytes, the length, 0, the address (2), 0. Strings live in the string space, allocated
* downward from MEMTOP (FRETOP is the lowest in use), or in the program text (literals). A string value being
* worked on is a descriptor pointed at by STRPTR: a variable's, or one of the temporary descriptors at TMPDSC
* (used and freed like a stack; ?ST ERROR when they run out).

TMPDSC  EQU     $0130           ; 8 temporary descriptors
TMPEND  EQU     TMPDSC+8*5

* RSTTMP: no temporaries in use
RSTTMP  PSHS    X               ; (and PTRGET's modes: a new statement starts)
        LDX     #TMPDSC
        STX     <TEMPPT
        CLR     <DIMFLG
        CLR     <VARCRE
        PULS    X,PC

* MKTMP: a temporary descriptor for the B bytes at X: STRPTR points at it, VALTYP = $FF. Keeps X, B.
MKTMP   PSHS    U
        LDU     <TEMPPT
        CMPU    #TMPEND
        BHS     STERR
        STB     ,U
        CLR     1,U
        STX     2,U
        CLR     4,U
        STU     <STRPTR
        LEAU    5,U
        STU     <TEMPPT
        LDA     #$FF
        STA     <VALTYP
        PULS    U,PC
STERR   LDB     #ERR_ST
        JMP     ERROR

* FRETMP: the string of the descriptor at X: X = its address, B = its length. If the descriptor is the last
* temporary it is freed, and so is its string if it is the last one made.
FRETMP  PSHS    D,X
        LEAU    5,X
        CMPU    <TEMPPT
        BNE     FT1
        STX     <TEMPPT
        LDD     2,X
        CMPD    <FRETOP
        BNE     FT1
        LDB     ,X
        CLRA
        ADDD    <FRETOP
        STD     <FRETOP
FT1     PULS    D,X
        LDB     ,X
        LDX     2,X
        RTS
* FRESTR: the string value just evaluated (?TM ERROR if it is a number): X, B as FRETMP
FRESTR  JSR     CHKSTR
        LDX     <STRPTR
        BRA     FRETMP

* GETSPA: room for B bytes in the string space: X = their address (?OS ERROR if there is none). Keeps B.
GETSPA  PSHS    B
        CLRA
        PSHS    D               ; (A at 0,S is unused: D at ,S is the length)
        LDD     <FRETOP
        SUBD    ,S
        BLO     GS1
        CMPD    <STRBOT
        BLO     GS1
        STD     <FRETOP
        TFR     D,X
        LEAS    2,S
        PULS    B,PC
GS1     LEAS    2,S             ; (the garbage collector comes in M5)
        LDB     #ERR_OS
        JMP     ERROR

* STRKEEP: the descriptor a variable may hold for the string value just evaluated: the value's own when its
* string is a temporary result in the string space or a literal in a running program's text; otherwise a copy
* in the string space (DSCTMP). Frees the value's temporary. X = the descriptor.
STRKEEP LDX     <STRPTR
        CMPX    #TMPDSC
        BLO     SK2
        CMPX    #TMPEND
        BHS     SK2
        LEAU    5,X             ; a temporary: freed (its string is not)
        CMPU    <TEMPPT
        BNE     SK1
        STX     <TEMPPT
SK1     LDD     2,X
        CMPD    <FRETOP
        BLO     SK3
        CMPD    <MEMTOP
        BLO     SKKEEP          ; a result in the string space
SK3     BSR     INPROG
        BCS     SKKEEP
        BRA     SKCOPY
SK2     TST     ,X              ; a variable's string: the empty one is kept, a literal in the program too
        BEQ     SKKEEP
        BSR     INPROG
        BCS     SKKEEP
SKCOPY  LDB     ,X
        PSHS    X
        JSR     GETSPA
        PULS    U
        STB     <DSCTMP
        CLR     <DSCTMP+1
        STX     <DSCTMP+2
        CLR     <DSCTMP+4
        LDU     2,U             ; (read after GETSPA: the string may have moved)
        TSTB
        BEQ     SK5
SK4     LDA     ,U+
        STA     ,X+
        DECB
        BNE     SK4
SK5     LDX     #DSCTMP
SKKEEP  RTS
* INPROG: C set if the string of the descriptor at X is in a running program's text. Keeps X.
INPROG  LDD     <CURLIN
        CMPD    #$FFFF
        BEQ     IP1
        LDD     2,X
        CMPD    <TXTTAB
        BLO     IP1
        CMPD    <VARTAB
        BHS     IP1
        ORCC    #1
        RTS
IP1     ANDCC   #$FE
        RTS

* STRLIT: a string in quotes at the text pointer (on the opening quote): a temporary for it, the text pointer
* past the closing quote (or on the end of the line)
STRLIT  LDX     <TXTPTR
        LEAX    1,X
        PSHS    X
        CLRB
SL1     LDA     ,X
        BEQ     SL2
        CMPA    #'"'
        BEQ     SL2
        INCB
        LEAX    1,X
        BRA     SL1
SL2     STX     <TXTPTR
        PULS    X
        JSR     MKTMP
        LDA     [TXTPTR]
        BEQ     SL3
        JMP     CHRGET
SL3     JMP     CHRGOT

* CONCAT: the left string (ARGSTR) and the right one (STRPTR) joined: ?LS ERROR past 255 characters
CONCAT  LDX     <ARGSTR
        LDB     ,X
        LDX     <STRPTR
        ADDB    ,X
        BCC     CC1
        LDB     #ERR_LS
        JMP     ERROR
CC1     JSR     GETSPA
        PSHS    B,X
        LDU     <ARGSTR
        BSR     CCOPY
        LDU     <STRPTR
        BSR     CCOPY
        LDX     <STRPTR
        JSR     FRETMP
        LDX     <ARGSTR
        JSR     FRETMP
        PULS    B,X
        JMP     MKTMP
* CCOPY: copy the string of the descriptor at U to X, X ending past it
CCOPY   LDB     ,U
        BEQ     CCP2
        LDU     2,U
CCP1    LDA     ,U+
        STA     ,X+
        DECB
        BNE     CCP1
CCP2    RTS

* STRCMP: compare the left string (ARGSTR) with the right one (STRPTR), character codes in order, a shorter one
* that is the start of the other first. A = $FF, 0 or 1 as FCMP; both temporaries freed.
STRCMP  LDX     <STRPTR
        JSR     FRETMP
        STB     <TMPCNT
        STX     <TMPPTR
        LDX     <ARGSTR
        JSR     FRETMP
        STB     <TMPCNT+1
        LDU     <TMPPTR         ; X: the left string, U: the right
SC1     TST     <TMPCNT+1
        BEQ     SC3             ; the left one ended
        TST     <TMPCNT
        BEQ     SCGT            ; the right one ended first
        LDA     ,X+
        CMPA    ,U+
        BLO     SCLT
        BHI     SCGT
        DEC     <TMPCNT
        DEC     <TMPCNT+1
        BRA     SC1
SC3     TST     <TMPCNT
        BEQ     SCEQ
SCLT    LDA     #$FF
        RTS
SCGT    LDA     #1
        RTS
SCEQ    CLRA
        RTS
