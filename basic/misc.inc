* ---------------- memory, machine code, user functions ----------------

* PEEK(address)
PEEK    JSR     FNARGN
        JSR     GETADR
        TFR     D,X
        LDB     ,X
        CLRA
        JMP     GIVNUM
* POKE address, value
POKE    JSR     EVNUM
        JSR     GETADR
        PSHS    D
        JSR     COMMA
        JSR     GETBYT
        PULS    X
        STB     ,X
        RTS
* EXEC [address]: call machine code (it returns with RTS); without an address, the last one given [UM]
EXEC    BEQ     EXC1
        JSR     EVNUM
        JSR     GETADR
        STD     <EXECAD
EXC1    LDX     <EXECAD
        LBEQ    FCERR           ; no address ever given
        JSR     ,X
        JMP     CHRGOT
* USRn(x): call the machine code DEF USRn gave, with x in FAC; it returns its result in FAC [UM]
USR     JSR     USRNUM
        PSHS    X
        JSR     FNARGN
        PULS    X
        LDX     ,X
        LBEQ    FCERR           ; never defined
        JSR     ,X
        CLR     <VALTYP
        RTS
* USRNUM: an optional digit after USR: X = its entry in USRTAB
USRNUM  JSR     CHRGOT
        LDB     #0
        BCC     UN1
        SUBA    #'0'
        TFR     A,B
        JSR     CHRGET
UN1     ASLB
        LDX     #USRTAB
        ABX
        RTS

* DEF FN name(parameter) = expression; DEF USRn = address [UM]. A function's definition is a variable whose
* name has bit 7 of its first letter set: its value holds the expression's place in the program and the
* parameter's address.
DEF     CMPA    #$FF
        BNE     DEF1
        JSR     CHRGET
        CMPA    #T_USRF
        LBNE    SNERR
        JSR     CHRGET
        JSR     USRNUM
        PSHS    X
        LDB     #T_EQ
        JSR     SYNCHR
        JSR     EVNUM
        JSR     GETADR
        PULS    X
        STD     ,X
        RTS
DEF1    CMPA    #T_FN
        LBNE    SNERR
        LDD     <CURLIN
        CMPD    #$FFFF
        LBEQ    IDERR           ; only in a program
        JSR     CHRGET
        JSR     FNNAME
        LDA     #1
        STA     <VARCRE
        JSR     PTRLKP
        PSHS    X
        JSR     LPAREN
        LDA     #1
        STA     <VARCRE
        JSR     PTRGET
        CLR     <VARCRE
        TST     <VALTYP
        LBNE    TMERR
        CMPX    <ARYTAB         ; a simple variable only
        LBHS    SNERR
        PSHS    X
        JSR     RPAREN
        LDB     #T_EQ
        JSR     SYNCHR
        PULS    D
        PULS    X
        STD     2,X             ; the parameter
        LDD     <TXTPTR
        STD     ,X              ; the expression
        JMP     DATAST          ; the rest of the statement is not run now
* FN name(argument): the parameter takes the argument while the expression is evaluated, then gets its own
* value back (?UF ERROR if the function was never defined)
FNCALL  JSR     CHRGET
        JSR     FNNAME
        LDA     <VALTYP
        PSHS    A               ; the function's type
        CLR     <VARCRE
        JSR     PTRLKP
        CMPX    #ZEROV
        BNE     FNC1
        LDB     #ERR_UF
        JMP     ERROR
FNC1     PSHS    X               ; the definition, over the type
        JSR     FNARGN          ; the argument
        LDX     ,S
        LDU     2,X             ; the parameter: its own value kept on the stack
        LEAS    -5,S
        LDB     #4
FNC2     LDA     B,U
        STA     B,S
        DECB
        BPL     FNC2
        PSHS    U
        TFR     U,X
        JSR     MOVMF           ; the parameter = the argument
        LDD     <TXTPTR
        PSHS    D
        LDX     9,S             ; the definition: the text pointer 0, the parameter 2, the saved value 4-8
        LDD     ,X
        STD     <TXTPTR
        JSR     EVAL
        PULS    D
        STD     <TXTPTR
        PULS    U               ; the parameter's value back
        LDB     #4
FNC3     LDA     B,S
        STA     B,U
        DECB
        BPL     FNC3
        LEAS    7,S             ; the saved value and the definition
        PULS    A
        CMPA    <VALTYP
        LBNE    TMERR
        RTS
* FNNAME: a function's name at the text pointer into VARNAM (bit 7 of its first letter set) and VALTYP
FNNAME  JSR     CHRGOT
        JSR     ISLET
        LBCC    SNERR
        ORA     #$80
        STA     <VARNAM
        CLR     <VARNAM+1
        CLR     <VALTYP
        JSR     CHRGET
        BCS     FN1
        JSR     ISLET
        BCC     FN2
FN1     STA     <VARNAM+1
FN1A    JSR     CHRGET
        BCS     FN1A
        JSR     ISLET
        BCS     FN1A
FN2     CMPA    #'$'
        BNE     FN3
        COM     <VALTYP
        LDA     <VARNAM+1
        ORA     #$80
        STA     <VARNAM+1
        JSR     CHRGET
FN3     RTS

* VARPTR(variable): the address of its value
VARPTR  JSR     LPAREN          ; (a variable that does not exist: ?FC ERROR; making it would move the arrays
        CLR     <VARCRE         ; under an element address the expression may hold)
        JSR     PTRGET
        CMPX    #ZEROV
        LBEQ    FCERR
        PSHS    X
        JSR     RPAREN
        PULS    D
        JMP     GIVUNS
* MEM: the bytes free between the arrays and the stack
MEM     TFR     S,D
        SUBD    <ARYEND
        JMP     GIVUNS
* POS(n): the cursor's column (n is not used)
POS     JSR     FNARGN
        LDB     <CURPOS+1
        ANDB    #31
        CLRA
        JMP     GIVNUM
* TIMER: the fields counted since it was last set (50 a second); TIMER = n sets it [UM]
TIMERF  LDD     <TIMER
        JMP     GIVUNS
TIMERS  LDB     #T_EQ
        JSR     SYNCHR
        JSR     EVNUM
        JSR     GETADR
        STD     <TIMER
        RTS
