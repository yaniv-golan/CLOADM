* ---------------- IF, FOR, NEXT, ON ----------------

* IF expression THEN statements | line [ELSE statements | line]; IF expression GO TO / GO SUB line [UM].
* A number that is not 0 is true. When it is false the line goes on after its ELSE (ELSEs pair with the IFs
* between, innermost first), or ends.
IFST    JSR     <ZEVNUM         ; (leaves the character after the expression in A)
        CMPA    #T_GO
        BEQ     IF1
        LDB     #T_THEN
        JSR     SYNCHR
IF1     TST     <FACEXP
        BEQ     IFNO
IFYES   JSR     <ZCHRGOT
        LBCC    EXECST
IFLINE  JMP     GOTO1
* false: look for this IF's ELSE
IFNO    LDX     <TXTPTR
        CLRB                    ; IFs met since
IFN1    JSR     NXTOK
        BEQ     IFN4
        CMPA    #T_IF
        BNE     IFN3A
        INCB
        BRA     IFN1
IFN3A   CMPA    #T_ELSE
        BNE     IFN1
        DECB
        BPL     IFN1
        LEAX    -1,X            ; on the ELSE
        STX     <TXTPTR
        JSR     <ZCHRGET
        BRA     IFYES
IFN4    LEAX    -1,X            ; the end of the line (on its 0: REM's scan stores it at once)
        JMP     REM1

* FOR variable = start TO limit [STEP step]: a frame on the stack (interp.inc, FORSIZ bytes): the marker,
* the variable's address, the step and the limit packed, the line and the text pointer after the statement.
* A FOR of a variable that already has a loop open ends that loop and those inside it [OWN; to confirm].
* The loop runs once before the limit is first checked, at NEXT [OWN; to confirm].
FOR     JSR     SIMVAR
        STX     <FORVAR
        JSR     SYNEQ
        JSR     <ZEVNUM
        LDX     <FORVAR
        JSR     <ZMOVMF
        LDB     #T_TO
        JSR     SYNCHR
        JSR     <ZEVNUM
        LDX     #FORLIM
        JSR     <ZMOVMF
        JSR     <ZCHRGOT
        CMPA    #T_STEP
        BEQ     FOR0
        JSR     <ZFPRUN         ; no STEP: 1
        FCB     F_LD+K_ONE,0
        BRA     FOR0A
FOR0    JSR     <ZCHRGET
        JSR     <ZEVNUM
FOR0A   LDX     #FORSTP
        JSR     <ZMOVMF
FOR1    JSR     ENDCHK
* drop an open loop of the same variable, and everything above it
        PULS    U               ; NEWSTT's return address
        LEAX    ,S
FOR2    CMPX    <STRBOT
        BHS     FOR4
        LDA     ,X
        CMPA    #T_FOR
        BNE     FOR4            ; a GOSUB frame: loops beyond it are not this one's
        LDD     1,X
        CMPD    <FORVAR
        BEQ     FOR3
        LEAX    FORSIZ,X
        BRA     FOR2
FOR3    LEAS    FORSIZ,X
FOR4    JSR     CHKSTK
        LDX     <CURLIN
        LDY     <TXTPTR
        PSHS    X,Y
        LDX     #FORLIM+5
        LDB     #10             ; the limit, then the step below it
FOR5    LDA     ,-X
        PSHS    A
        DECB
        BNE     FOR5
        LDA     #T_FOR
        LDX     <FORVAR
        PSHS    A,X
        JMP     ,U

* NEXT [variable [, variable ...]]: add the step; while the variable has not passed the limit (above it for a
* step of 0 or more, below it for a negative one) go round again, else close the loop and go on
NXDLY   EQU     9
NEXT    PULS    U
        STU     <NXRET
NXA     JSR     CHRGOT          ; (called straight, as MOVMF below: NEXT's own time counts in every loop)
        BEQ     NX1             ; no variable: the innermost loop
        CLR     <VARCRE         ; (a variable that does not exist is not any loop's)
        JSR     PTRGET
        STX     <FORVAR
        BRA     NX2
NX1     CLRA
        CLRB
        STD     <FORVAR
NX2     LEAX    ,S
NX3     CMPX    <STRBOT
        BHS     NFERR
        LDA     ,X
        CMPA    #T_FOR
        BNE     NFERR
        LDD     <FORVAR
        BEQ     NX4
        CMPD    1,X
        BEQ     NX4
        LEAX    FORSIZ,X        ; an inner loop: closed
        BRA     NX3
NX4     LEAS    ,X              ; the loops inside are gone
        LDX     1,S             ; the variable + the step
        STX     <FORVAR
        JSR     MOVFM
        LEAX    3,S
        JSR     MOVAM
        JSR     FADD
        LDA     <FACEXP         ; a variable below 256 waits: the original's NEXT takes longer there [BB bb2
        CMPA    #128+9          ; snd-timer: 500 empty passes, 29 fields, against ram-pointers2's 2000 in 113]
        BHS     NXW1
        LDB     #NXDLY
NXW     DECB
        BNE     NXW
NXW1    LDX     <FORVAR
        JSR     MOVMF
        LEAX    8,S             ; against the limit
        BSR     NXCMP
        TST     4,S             ; the step's sign
        BPL     NX5
        NEGA
NX5     TSTA
        BMI     NXDONE          ; passed
        LDD     13,S            ; again: the line and the text after the FOR
        STD     <CURLIN
        LDD     15,S
        STD     <TXTPTR
        JMP     [NXRET]
NXDONE  LEAS    FORSIZ,S
        JSR     <ZCHKCOM
        BNE     NX6
        JSR     <ZCHRGET
        BRA     NXA
NX6     JMP     [NXRET]
NFERR   CLRB                    ; ERR_NF
        JMP     ERROR
* NXCMP: FCMPM for NEXT (the limit at X against FAC, just stored, so rounded): A and the flags as FCMP's. Two
* non-zero numbers of one sign are compared packed; the others go through FCMPM.
NXCMP   LDA     <FACEXP
        BEQ     NXCSLO
        LDA     ,X
        BEQ     NXCSLO
        LDB     1,X
        EORB    <FACSGN
        BMI     NXCSLO          ; different signs
        CMPA    <FACEXP
        BNE     NXC1
        LDD     1,X
        ORA     #$80
        CMPD    <FACM
        BNE     NXC1
        LDD     3,X
        CMPD    <FACM+2
        BNE     NXC1
        CLRA                    ; equal
        RTS
NXC1    LDA     #1              ; C clear: the limit's magnitude is the larger
        BCC     NXC2
        NEGA
NXC2    TST     <FACSGN
        BPL     NXC3
        NEGA
NXC3    TSTA
        RTS
NXCSLO  JMP     FCMPM

* ON expression GO TO / GO SUB line, line, ...: the nth line; past the list (or 0), the next statement [UM]
ON      JSR     <ZGETBYT
        STB     <ONCNT
        CLR     <ONFND
        JSR     <ZCHRGOT
        CMPA    #T_GO
        LBNE    SNERR
        JSR     <ZCHRGET
        STA     <ONKIND
        CMPA    #T_TO
        BEQ     ON1
        CMPA    #T_SUB
        LBNE    SNERR
ON1     JSR     <ZCHRGET
ON2     JSR     <ZLINGET          ; each line number in turn
        DEC     <ONCNT
        BNE     ON3
        LDD     <BINVAL
        STD     <ONLINE
        INC     <ONFND
ON3     JSR     <ZCHKCOM
        BNE     ON4
        JSR     <ZCHRGET
        BRA     ON2
ON4     JSR     ENDCHK
        TST     <ONFND
        BEQ     ON6             ; none: go on
        LDD     <ONLINE
        STD     <BINVAL
        LDA     <ONKIND
        CMPA    #T_SUB
        LBEQ    GOSUB1          ; GOSUB: a frame returning to after this statement
        JMP     JUMPTO
ON6     RTS
