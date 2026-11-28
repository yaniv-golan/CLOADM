* ---------------- memory, machine code, user functions ----------------

* POKE address, value
POKE    JSR     EVADR
        PSHS    D
        JSR     COMBYT
        PULS    X
        STB     ,X
        RTS
* EXEC [address]: call machine code (it returns with RTS); without an address, the last one given [UM]
EXEC    BEQ     EXC1
        JSR     EVADR
        STD     <EXECAD
EXC1    LDX     <EXECAD
        LBEQ    FCERR           ; no address ever given
        JSR     ,X
        JMP     <ZCHRGOT
* USRn(x): call the machine code DEF USRn gave, with x in FAC; it returns its result in FAC [UM]
USR     BSR     USRNUM
        PSHS    X
        JSR     <ZFNARGN
        PULS    X
        LDX     ,X
        LBEQ    FCERR           ; never defined
        JSR     ,X
        CLR     <VALTYP
        RTS
* USRNUM: an optional digit after USR: X = its entry in USRTAB
USRNUM  CLRB
        JSR     <ZCHRGOT
        BCC     UN1
        SUBA    #'0'
        TFR     A,B
        JSR     <ZCHRGET
UN1     ASLB
        LDX     #USRTAB
        ABX
        RTS

* DEF FN name(parameter) = expression; DEF USRn = address [UM]. A function's definition is a variable whose
* name has bit 7 of its first letter set: its value holds the expression's place in the program and the
* parameter's address.
DEF     CMPA    #$FF
        BNE     DEF1
        JSR     <ZCHRGET
        CMPA    #T_USRF
        LBNE    SNERR
        JSR     <ZCHRGET
        BSR     USRNUM
DEFSTO  PSHS    X
        JSR     SYNEQ
        JSR     EVADR
        PULS    X
        STD     ,X
        RTS
TIMERS  LDX     #TIMER
        BRA     DEFSTO
DEF1    CMPA    #T_FN
        LBNE    SNERR
        JSR     DIRCHK
        LBEQ    IDERR           ; only in a program
        JSR     <ZCHRGET
        BSR     FNNAME
        INC     <VARCRE
        JSR     PTRLKP
        PSHS    X
        JSR     <ZLPAREN
        JSR     SIMVAR
        PSHS    X
        JSR     <ZRPAREN
        JSR     SYNEQ
        PULS    D
        PULS    X
        STD     2,X             ; the parameter
        LDD     <TXTPTR
        STD     ,X              ; the expression
        JMP     DATAST          ; the rest of the statement is not run now
* FN name(argument): the parameter takes the argument while the expression is evaluated, then gets its own
* value back (?UF ERROR if the function was never defined)
FNCALL  JSR     <ZCHRGET
        BSR     FNNAME
        CLR     <VARCRE
        JSR     PTRLKP
        CMPX    #ZEROV
        BNE     FNC1
        LDB     #ERR_UF
        JMP     <ZERROR
FNC1     PSHS    X               ; the definition
        JSR     <ZFNARGN          ; the argument
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
        JSR     <ZMOVMF           ; the parameter = the argument
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
        JMP     <ZCHKNUM          ; (a function is numeric: its value too)
* FNNAME: a function's name at the text pointer into VARNAM (bit 7 of its first letter set); a string name is
* ?TM ERROR, in DEF too [BB bb1 fn-misc: DEF FN A$(X)=... is ?TM ERROR]
FNNAME  JSR     VNAME
        LDA     <VARNAM
        ORA     #$80
        STA     <VARNAM
        JMP     <ZCHKNUM

* VARPTR(variable): the address of its value
VARPTR  JSR     <ZLPAREN          ; (a variable that does not exist: ?FC ERROR; making it would move the arrays
        CLR     <VARCRE         ; under an element address the expression may hold)
        JSR     PTRGET
        CMPX    #ZEROV
        LBEQ    FCERR
        PSHS    X
        JSR     <ZRPAREN
        PULS    D
        BRA     MEMGIV
* MEM: the bytes free between the arrays and the stack, as the original counts them [BB bb2 gfx-pclear: 2 more]
MEM     LEAX    4,S             ; (the original's MEM with its string space at 32766 [BB bb3 ram-pointers])
        TFR     X,D
        SUBD    <ARYEND
MEMGIV  JMP     GIVUNS
* TIMER: the fields counted since it was last set (50 a second); TIMER = n sets it [UM]
TIMERF  LDD     TIMER
        BRA     MEMGIV
