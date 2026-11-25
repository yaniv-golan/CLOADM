* ---------------- string functions, CLEAR ----------------
* Each function starts on the character after its token [UM for what each returns].

* GIVNUM: a function's numeric result D (signed 16-bit) into FAC
GIVNUM  CLR     <VALTYP
        JMP     GIVABF
* COMMA: the character must be ','; take it
COMMA   LDB     #','
        JMP     SYNCHR
* COMBYT: a ',' and an expression 0-255 into B
COMBYT  BSR     COMMA
        JMP     GETBYT
* STRFN: ( string expression ): X = the string, B = its length (FRESTR)
STRFN   JSR     LPAREN
STRFN1  JSR     EVSTR
        JSR     RPAREN
        JMP     FRESTR
* STRARG: ( string expression : STRPTR, and the descriptor pushed under the caller's return address
STRARG  JSR     LPAREN
        JSR     EVSTR
        PULS    U
        LDX     <STRPTR
        PSHS    X
        JMP     ,U
* STRCPY: a new temporary string holding the B bytes at X (not in the string space)
STRCPY  PSHS    X
        JSR     GETSPA
        PULS    U
        PSHS    B,X
        JSR     CPYUX
        PULS    B,X
        JMP     MKTMP

* LEN(s$)
LEN     BSR     STRFN
        CLRA
        BRA     GIVNUM
* ASC(s$): the first character's code (?FC ERROR for an empty string)
ASC     BSR     STRFN
        TSTB
        LBEQ    FCERR
        LDB     ,X
        CLRA
        BRA     GIVNUM
* CHR$(n)
CHRS    JSR     LPAREN
        JSR     GETBYT
        PSHS    B
        JSR     RPAREN
        PULS    A
CHR1    LDX     #FBUFFR         ; a string of the one character A
        STA     ,X
        LDB     #1
        BRA     STRCPY
* LEFT$(s$, n), RIGHT$(s$, n), MID$(s$, m [, n])
LEFTS   BSR     STRARG
        BSR     COMBYT
        STB     <SBCNT
        CLR     <SBSTRT
        BRA     SUBEND
RIGHTS  BSR     STRARG
        BSR     COMBYT
        STB     <SBCNT
        LDX     ,S
        LDB     ,X              ; the start: length - n, or 0
        SUBB    <SBCNT
        BCC     RS1
        CLRB
RS1     STB     <SBSTRT
        BRA     SUBEND
MIDS    BSR     STRARG
        BSR     COMBYT
        TSTB
        LBEQ    FCERR           ; the first character is 1
        DECB
        STB     <SBSTRT
        LDB     #255
        STB     <SBCNT
        JSR     <ZCHKCOM
        BNE     SUBEND
        JSR     <ZCHRGET
        JSR     GETBYT
        STB     <SBCNT
SUBEND  JSR     RPAREN
        PULS    X
* SUBSTR: SBCNT characters from SBSTRT of the string of the descriptor at X (as many as there are)
SUBSTR  PSHS    X
        LDB     ,X
        SUBB    <SBSTRT
        BHI     SS1
        CLRB                    ; starting past the end: empty
SS1     CMPB    <SBCNT
        BHS     SS2
        STB     <SBCNT
SS2     LDB     <SBCNT
        JSR     GETSPA          ; (may move the string: its address is read after)
        LDU     ,S
        LDU     2,U
        PSHS    B,X
        LDB     <SBSTRT
        CLRA
        LEAU    D,U
        LDB     ,S
        JSR     CPYUX
        PULS    B,U
        PULS    X
        PSHS    B,U
        JSR     FRETMP          ; the argument's temporary
        PULS    B,X
        JMP     MKTMP

* STR$(n): the number as PRINT shows it, without the space after
STRS    JSR     <ZFNARGN
        JSR     FOUT
STRZ    CLRB                    ; the 0-terminated text at X as a string
STZ1    TST     B,X
        BEQ     STZ2
        INCB
        BRA     STZ1
STZ2    JMP     STRCPY

* VAL(s$): the number at the start of the string (0 if there is none), read in place with a 0 put after it for
* the while. An error in the number (?OV ERROR) leaves that 0 there: after 40 X=VAL("1E99") the line lists as
* 40 X=VAL("1E99 [BB bb1 review-fixes]
VAL     JSR     STRFN
        LDU     <TXTPTR
        PSHS    U
        LEAU    -1,X
        STU     <TXTPTR
        ABX
        LDA     ,X
        PSHS    X,A
        CLR     ,X
        JSR     <ZCHRGET
        JSR     FIN
        PULS    A,X
        STA     ,X
        PULS    D
        STD     <TXTPTR
        CLR     <VALTYP
        RTS

* INSTR([start,] s$, t$): where t$ first appears in s$ from position start, or 0
INSTR   JSR     LPAREN
        LDB     #1
        STB     <SBSTRT
        JSR     EVAL
        TST     <VALTYP
        BNE     IN1
        JSR     CNVBYT
        TSTB
        LBEQ    FCERR
        STB     <SBSTRT
        JSR     COMMA
        JSR     EVSTR
IN1     LDX     <STRPTR
        PSHS    X
        JSR     COMMA
        JSR     STRFN1          ; t$: X, B
        STX     <TMPPTR
        STB     <SBCNT
        PULS    X
        JSR     FRETMP          ; s$: X, B
        STB     <TMPCNT
        LDB     <SBSTRT         ; positions start-1 .. len(s) - len(t)
        DECB
        STB     <TMPCNT+1
IN2     LDA     <TMPCNT         ; room left for t$ from here?
        SUBA    <TMPCNT+1
        BLO     INNO
        CMPA    <SBCNT
        BLO     INNO
        LDB     <SBCNT
        BEQ     INYES           ; an empty t$ is found at once
        PSHS    X
        LDB     <TMPCNT+1
        CLRA
        LEAX    D,X
        LDB     <SBCNT
        LDU     <TMPPTR
IN3     LDA     ,X+
        CMPA    ,U+
        BNE     IN4
        DECB
        BNE     IN3
        PULS    X
        BRA     INYES
IN4     PULS    X
        INC     <TMPCNT+1
        BRA     IN2
INYES   LDB     <TMPCNT+1
        INCB
        CLRA
        JMP     GIVNUM
INNO    CLRA
        CLRB
        JMP     GIVNUM

* STRING$(n, c) or STRING$(n, c$): n of the character
STRNGS  JSR     LPAREN
        JSR     GETBYT
        PSHS    B
        JSR     COMMA
        JSR     EVAL
        TST     <VALTYP
        BNE     SG1
        JSR     CNVBYT
        BRA     SG2
SG1     JSR     FRESTR
        TSTB
        LBEQ    FCERR
        LDB     ,X
SG2     PSHS    B
        JSR     RPAREN
        LDB     1,S
        JSR     GETSPA
        PULS    A
        PSHS    X
        TSTB
        BEQ     SG4
SG3     STA     ,X+
        DECB
        BNE     SG3
SG4     PULS    X
        PULS    B
        JMP     MKTMP

* HEX$(n): n (0-65535) in hexadecimal, no leading zeros
HEXS    JSR     <ZFNARGN
        JSR     GETADR
        LDX     #FBUFFR
        PSHS    D
        LDB     #4              ; four digits, leading zeros dropped (the last is always kept)
        STB     <TMPCNT
HXS1    LDD     ,S
        LSRA                    ; the top digit
        LSRA
        LSRA
        LSRA
        PSHS    A
        LDD     1,S
        ASLB
        ROLA
        ASLB
        ROLA
        ASLB
        ROLA
        ASLB
        ROLA
        STD     1,S
        PULS    A
        CMPX    #FBUFFR
        BNE     HXS2
        TSTA
        BNE     HXS2
        LDB     <TMPCNT
        CMPB    #1
        BNE     HXS3
HXS2    ADDA    #'0'
        CMPA    #'9'
        BLS     HXS2A
        ADDA    #7
HXS2A   STA     ,X+
HXS3    DEC     <TMPCNT
        BNE     HXS1
        CLR     ,X
        LEAS    2,S
        LDX     #FBUFFR
        JMP     STRZ

* INKEY$: the key pressed since the last look, or an empty string
INKEY   JSR     KEYIN
        BEQ     IK1
        JMP     CHR1
IK1     CLRB
        JMP     MKTMP

* CLEAR [string space [, top of memory]]: no variables, the string space set, the stack emptied [UM]
CLEAR   BEQ     CL3
        JSR     EVADR
        STD     <TMPCNT
        LDD     <MEMTOP
        STD     <TMPPT2
        JSR     <ZCHKCOM
        BNE     CL1
        JSR     <ZCHRGET
        JSR     EVADR
        CMPD    #RAMTOP
        LBHI    FCERR
        STD     <TMPPT2
CL1     JSR     ENDCHK
        LDD     <TMPPT2         ; the new bottom of the string space: top - size, above the variables
        SUBD    <TMPCNT
        LBLO    OMERR
        PSHS    D
        LDD     <VARTAB
        ADDD    #128
        CMPD    ,S
        PULS    D
        LBHI    OMERR
        STD     <STRBOT
        LDD     <TMPPT2
        STD     <MEMTOP
CL3     JSR     CLRVAR
        LDS     <STRBOT
        JMP     NEWSTT
