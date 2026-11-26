* ---------------- strings ----------------
* A string descriptor: 5 bytes, the length, 0, the address (2), 0. Strings live in the string space, allocated
* downward from MEMTOP (FRETOP is the lowest in use), or in the program text (literals). A string value being
* worked on is a descriptor pointed at by STRPTR: a variable's, or one of the temporary descriptors at TMPDSC
* (used and freed like a stack; ?ST ERROR when they run out).


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

* GETSPA: room for B bytes in the string space: X = their address. When there is too little, the garbage is
* collected first; then ?OS ERROR. Keeps B.
GETSPA  PSHS    B
        CLR     <GCDONE
GS0     CLRA
        PSHS    D
        LDD     <FRETOP
        SUBD    ,S++
        BLO     GS1
        CMPD    <STRBOT
        BLO     GS1
        STD     <FRETOP
        TFR     D,X
        PULS    B,PC
GS1     TST     <GCDONE
        BNE     GS2
        INC     <GCDONE
        BSR     GARBAG
        LDB     ,S
        BRA     GS0
GS2     LDB     #ERR_OS
        JMP     ERROR

* Invariant: no two descriptors share a string in the string space (STRKEEP copies a variable's string rather than
* share it), so moving a string updates its one descriptor.
* GARBAG: the garbage collector. Every string in use (the variables', the arrays', the temporaries') is moved up
* to the top of the string space, the highest first, so the free space below them is all in one piece.
GARBAG  PSHS    D,X,Y,U
        LDD     <MEMTOP
        STD     <GCTOP          ; where the strings kept so far begin
        STD     <GCLIM          ; strings below this are still to do
GC1     CLRA
        CLRB
        STD     <GCBEST
        LDD     <FRETOP
        STD     <GCADR
        LDX     #TMPDSC         ; the temporaries
GC2     CMPX    <TEMPPT
        BHS     GC3
        BSR     GCCHK
        LEAX    5,X
        BRA     GC2
GC3     LDX     <VARTAB         ; the simple variables
GC4     CMPX    <ARYTAB
        BHS     GC6
        TST     1,X
        BPL     GC5
        LEAX    2,X
        BSR     GCCHK
        LEAX    -2,X
GC5     LEAX    7,X
        BRA     GC4
GC6     LDX     <ARYTAB         ; the arrays of strings
GC7     CMPX    <ARYEND
        BHS     GC10
        LDD     2,X
        LEAY    D,X             ; the next array
        TST     1,X
        BPL     GC9
        LDB     4,X
        CLRA
        ASLB
        ADDB    #5
        ADCA    #0
        LEAU    D,X             ; the first element
        PSHS    X
GC8     PSHS    Y               ; the elements up to the array's end
        CMPU    ,S++
        BHS     GC8A
        TFR     U,X
        BSR     GCCHK
        LEAU    5,U
        BRA     GC8
GC8A    PULS    X
GC9     TFR     Y,X
        BRA     GC7
* move the highest string found up under the ones kept
GC10    LDX     <GCBEST
        BEQ     GC12
        LDD     2,X
        STD     <GCLIM
        LDB     ,X
        CLRA
        PSHS    D
        LDD     <GCTOP
        SUBD    ,S
        STD     <GCTOP
        LDU     2,X             ; copied from the end down (it only moves up)
        PULS    D
        LEAU    D,U
        LDY     <GCTOP
        LEAY    D,Y
GC11    LDA     ,-U
        STA     ,-Y
        DECB
        BNE     GC11
        LDD     <GCTOP
        STD     2,X
        LBRA    GC1
GC12    LDD     <GCTOP
        STD     <FRETOP
        PULS    D,X,Y,U,PC
* GCCHK: the descriptor at X is the best so far if its string is in the string space, below GCLIM, and higher
* than the best found
GCCHK   TST     ,X
        BEQ     GCC1
        LDD     2,X
        CMPD    <GCLIM
        BHS     GCC1
        CMPD    <GCADR
        BLO     GCC1
        STD     <GCADR
        STX     <GCBEST
GCC1    RTS

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
        JSR     CPYUX
        LDX     #DSCTMP
SKKEEP  RTS
* INPROG: C set if the string of the descriptor at X is in a running program's text. Keeps X.
INPROG  JSR     DIRCHK
        BEQ     IP1
        LDD     2,X
        CMPD    <TXTTAB
        BLO     IP1
        CMPD    <VARTAB         ; (C set below it: inside the program)
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
        PSHS    B,X             ; in direct mode the literal is copied to the string space (the typed line goes):
        JSR     DIRCHK          ; A$="HELLO":B$=A$+"!" takes 12 bytes, "!" one of them [BB bb3 ram-pointers]
        BNE     SL4
        LDB     ,S
        JSR     GETSPA
        LDU     1,S
        STX     1,S
        JSR     CPYUX
SL4     PULS    B,X
        JSR     MKTMP
        LDA     [TXTPTR]
        BEQ     SL3
        JMP     <ZCHRGET
SL3     JMP     <ZCHRGOT

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
* CPYXU: copy B bytes (at least one) from X to U; both end past them, B = 0
CPYXU   LDA     ,X+
        STA     ,U+
        DECB
        BNE     CPYXU
        RTS
* CPYUX: copy B bytes (0 for none) from U to X; both end past them, B = 0
CCOPY   LDB     ,U
        LDU     2,U
CPYUX   TSTB
        BEQ     CCP2
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
