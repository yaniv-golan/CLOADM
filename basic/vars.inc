* ---------------- variables ----------------
* A simple variable: 7 bytes, the name (2; bit 7 of the second set for a string) and the value (a packed number
* or a string descriptor). An array: the name (2), its whole size (2), the number of dimensions (1), each
* dimension's size (2), then the elements, the first subscript varying fastest [OWN].
* Two characters of a name count [UM].

* ISLET: C set if A is a letter
ISLET   CMPA    #'A'
        BLO     ISL1
        CMPA    #'Z'
        BHI     ISL1
        ORCC    #1
        RTS
ISL1    ANDCC   #$FE
        RTS

ZEROV   FCB     0,0,0,0,0       ; the value of a variable not yet made: 0, or the empty string

* PTRGET: the variable named at the text pointer. X = the address of its value, VALTYP = $FF for a string;
* the text pointer ends on the character after the name (and its subscripts). A simple variable that does not
* exist is made only when VARCRE is nonzero (an assignment); otherwise X points at a 0. An array that does not
* exist is made with 11 elements a dimension, or with the sizes given when DIMFLG is set (DIM).
PTRGET  JSR     CHRGOT
        BSR     ISLET
        BCS     PG0
        JMP     SNERR
PG0     STA     <VARNAM
        CLR     <VARNAM+1
        CLR     <VALTYP
        JSR     CHRGET
        BCS     PG1
        BSR     ISLET
        BCC     PG2
PG1     STA     <VARNAM+1
PG1A    JSR     CHRGET          ; further letters and digits do not count
        BCS     PG1A
        BSR     ISLET
        BCS     PG1A
PG2     CMPA    #'$'
        BNE     PG3
        COM     <VALTYP
        LDA     <VARNAM+1
        ORA     #$80
        STA     <VARNAM+1
        JSR     CHRGET
PG3     CMPA    #'('
        LBEQ    ARYGET
* PTRLKP: the simple variable VARNAM (made if VARCRE is nonzero)
PTRLKP  LDX     <VARTAB
PG4     CMPX    <ARYTAB
        BHS     PG5
        LDD     ,X
        CMPD    <VARNAM
        BEQ     PG6
        LEAX    7,X
        BRA     PG4
PG6     LEAX    2,X
        RTS
PG5     TST     <VARCRE
        BNE     PG7
        LDX     #ZEROV
        RTS
* make it: the arrays move up 7 bytes
PG7     LDD     <ARYEND
        ADDD    #7
        JSR     ROOMCK
        LDU     <ARYEND
        LEAY    7,U
        STY     <ARYEND
PG8     CMPU    <ARYTAB
        BLS     PG9
        LDA     ,-U
        STA     ,-Y
        BRA     PG8
PG9     LDX     <ARYTAB
        LEAY    7,X
        STY     <ARYTAB
        LDD     <VARNAM
        STD     ,X++
        CLR     ,X
        CLR     1,X
        CLR     2,X
        CLR     3,X
        CLR     4,X
        RTS

* ROOMCK: D (a new end of the variables) must leave room below the stack, or ?OM ERROR
ROOMCK  PSHS    D
        ADDD    #64
        BCS     RCOM
        PSHS    D
        TFR     S,D
        CMPD    ,S++
        BLS     RCOM
        PULS    D,PC
RCOM    JMP     OMERR

* ARYGET: an array element: the subscripts in parentheses, each 0 to the dimension's size - 1 (?BS ERROR)
ARYGET  LDD     <VARNAM
        PSHS    D
        LDA     <VALTYP
        LDB     <DIMFLG
        PSHS    D
        CLR     <DIMFLG         ; (a subscript's own arrays are not being DIMmed)
        CLRB                    ; the number of subscripts
AG1     PSHS    B
        JSR     CHRGET
        JSR     EVNUM
        JSR     GETIDX
        TFR     D,Y
        PULS    B
        PSHS    Y
        INCB
        JSR     CHRGOT
        CMPA    #','
        BEQ     AG1
        CMPA    #')'
        BEQ     AG2
        JMP     SNERR
AG2     JSR     CHRGET
        STB     <NDIMS
        LEAU    B,S
        LEAU    B,U             ; U: the saved VALTYP and DIMFLG, then the name
        LDD     ,U
        STA     <VALTYP
        STB     <DIMFLG
        LDD     2,U
        STD     <VARNAM
        LDX     <ARYTAB
AG3     CMPX    <ARYEND
        BHS     AGNEW
        LDD     ,X
        CMPD    <VARNAM
        BEQ     AGFND
        LDD     2,X
        LEAX    D,X
        BRA     AG3
AGFND   TST     <DIMFLG
        BEQ     AG4
        LDB     #ERR_DD         ; DIM of an array that exists
        JMP     ERROR
AG4     LDB     4,X
        CMPB    <NDIMS
        BEQ     AGELEM
AGBS    LDB     #ERR_BS
        JMP     ERROR
* a new array at ARYEND: each dimension's size from DIM (subscript + 1), or 11
AGNEW   LDB     <NDIMS          ; the header: 5 + 2 per dimension
        CLRA
        ASLB
        ADDB    #5
        ADCA    #0
        STD     <TMPCNT
        LDD     #5              ; the element count, times 5
        STD     <TMPPT2
        LDX     <ARYEND
        LEAY    5,X             ; the dimension sizes go here, the first subscript's first
        LDB     <NDIMS
        LEAU    ,S
        LEAU    B,U
        LEAU    B,U             ; U: just past the first subscript (the deepest on the stack)
        PSHS    B
AGN1    LDD     ,--U
        TST     <DIMFLG
        BEQ     AGN2
        ADDD    #1
        BRA     AGN3
AGN2    LDD     #11
AGN3    STD     ,Y++
        JSR     MULTMP          ; TMPPT2 = TMPPT2 x D (?OM ERROR past 64K)
        DEC     ,S
        BNE     AGN1
        LEAS    1,S
        LDD     <TMPPT2
        ADDD    <TMPCNT         ; the whole size
        BCS     AGOM
        STD     <TMPPT2
        ADDD    <ARYEND
        BCS     AGOM
        JSR     ROOMCK
        LDX     <ARYEND
        STD     <ARYEND
        LDD     <VARNAM
        STD     ,X
        LDD     <TMPPT2
        STD     2,X
        LDB     <NDIMS
        STB     4,X
        TFR     X,U             ; clear the elements
        LDD     <TMPCNT
        LEAU    D,U
AGN4    CMPU    <ARYEND
        BHS     AGN5
        CLR     ,U+
        BRA     AGN4
AGN5    TST     <DIMFLG
        BEQ     AGELEM
        LDB     <NDIMS          ; DIM: nothing more
        ASLB
        ADDB    #4
        LEAS    B,S
        RTS
AGOM    JMP     OMERR
* the element: offset = s1 + d1 x (s2 + d2 x (...)), checked against each size
AGELEM  STX     <TMPPTR
        LDB     <NDIMS
        DECB
        ASLB                    ; the last dimension's size is at 5 + 2(n-1),X
        ABX
        LDD     #0
        STD     <TMPPT2         ; the offset so far
        LEAU    ,S              ; the last subscript
        LDB     <NDIMS
        STB     <TMPCNT
AGE1    LDD     <TMPPT2         ; offset x this size
        PSHS    X
        LDX     5,X
        PSHS    X
        LDD     <TMPPT2
        JSR     MUL16
        LEAS    2,S
        PULS    X
        STD     <TMPPT2
        LDD     ,U++            ; the subscript
        CMPD    5,X
        LBHS    AGBS
        ADDD    <TMPPT2
        STD     <TMPPT2
        LEAX    -2,X
        DEC     <TMPCNT
        BNE     AGE1
        LDD     <TMPPT2         ; x 5
        ASLB
        ROLA
        ASLB
        ROLA
        ADDD    <TMPPT2
        ADDD    #5
        ADDD    <TMPPTR
        PSHS    D
        LDB     <NDIMS
        CLRA
        ASLB
        ADDD    ,S++
        TFR     D,X             ; the element
        LDB     <NDIMS
        ASLB
        ADDB    #4
        LEAS    B,S
        RTS

* MUL16: D = D x the word at 2,S (the caller's pushed value); ?OM ERROR past 65535
MUL16   PSHS    D
        LDD     #0
        PSHS    D               ; the result
        LDA     3,S             ; low x low
        LDB     7,S
        MUL
        STD     ,S
        LDA     2,S             ; high x low
        LDB     7,S
        MUL
        TSTA
        BNE     M16OV
        ADDB    ,S
        BCS     M16OV
        STB     ,S
        LDA     3,S             ; low x high
        LDB     6,S
        MUL
        TSTA
        BNE     M16OV
        ADDB    ,S
        BCS     M16OV
        STB     ,S
        LDA     2,S             ; high x high must be 0
        LDB     6,S
        MUL
        CMPD    #0
        BNE     M16OV
        PULS    D
        LEAS    2,S
        RTS
M16OV   JMP     OMERR
* MULTMP: TMPPT2 = TMPPT2 x D
MULTMP  PSHS    D
        LDD     <TMPPT2
        BSR     MUL16
        STD     <TMPPT2
        PULS    D,PC

* GETIDX: FAC as a subscript, 0-32767, in D (?FC ERROR if negative or too large)
GETIDX  JSR     INTCNV
        TSTA
        BPL     GI1
        JMP     FCERR
GI1     RTS

* DIM name(sizes), ...
DIM     LDA     #1
        STA     <DIMFLG
        STA     <VARCRE
        JSR     PTRGET
        CLR     <DIMFLG
        JSR     CHRGOT
        CMPA    #','
        BNE     DIM1
        JSR     CHRGET
        BRA     DIM
DIM1    RTS

* LET name = expression
LET     LDA     #1
        STA     <VARCRE
        JSR     PTRGET
        CLR     <VARCRE
        PSHS    X
        LDA     <VALTYP
        PSHS    A
        LDB     #T_EQ
        JSR     SYNCHR
        JSR     EVAL
        PULS    A
        CMPA    <VALTYP
        LBNE    TMERR
        PULS    X
* ASSIGN: store the value just evaluated at X (its type in VALTYP)
ASSIGN  TST     <VALTYP
        BNE     ASS1
        JMP     MOVMF
ASS1    PSHS    X
        JSR     STRKEEP         ; X = a descriptor the variable may hold
        PULS    U
        LDD     ,X
        STD     ,U
        LDD     2,X
        STD     2,U
        LDA     4,X
        STA     4,U
        RTS
