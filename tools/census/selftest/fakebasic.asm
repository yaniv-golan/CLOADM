; A stand-in for a BASIC interpreter's line entry, for the token probe's self-test (tests/census.test.js). Written
; for this project; it knows nothing of any real BASIC: its keywords and token values are made up.
;
; It prints OK, reads a line through the built-in firmware's POLCAT/CHROUT, takes the line number, replaces each
; of its own keywords by a one-byte token (bit 7 set), and stores the line as a linked program line:
;   [address of the next line][line number][tokens and characters][0], then [0][0] at the next line
; (one line at a time: each new line replaces the program).
PROGST  EQU     $4001
        ORG     $3000
START   LDX     #PROGST
        CLR     ,X
        CLR     1,X
PROMPT  LDX     #OKMSG
        JSR     PRINT
        CLR     LEN
GETK    JSR     [$A000]
        BEQ     GETK
        CMPA    #13
        BEQ     ENTER
        JSR     [$A002]
        LDX     #BUF
        LDB     LEN
        ABX
        STA     ,X
        INC     LEN
        BRA     GETK
ENTER   JSR     [$A002]
        LDX     #BUF
        LDB     LEN
        ABX
        CLR     ,X
        LDX     #BUF
        LDD     #0
        STD     LNUM
NUML    LDB     ,X
        SUBB    #'0
        BLO     SKIPSP
        CMPB    #9
        BHI     SKIPSP
        LEAX    1,X
        PSHS    B
        LDD     LNUM
        ASLB
        ROLA
        STD     TMP
        ASLB
        ROLA
        ASLB
        ROLA
        ADDD    TMP
        ADDB    ,S+
        ADCA    #0
        STD     LNUM
        BRA     NUML
SKIPSP  LDA     ,X
        CMPA    #32
        BNE     TOK
        LEAX    1,X
        BRA     SKIPSP
TOK     LDY     #PROGST+4
TLOOP   LDA     ,X
        BEQ     TEND
        LDU     #KWTAB
KWNEXT  LDA     ,U
        BEQ     NOKW
        PSHS    X
KWCMP   LDA     ,U+
        BMI     KWHIT
        CMPA    ,X+
        BEQ     KWCMP
KWSKIP  LDA     ,U+
        BPL     KWSKIP
        PULS    X
        BRA     KWNEXT
KWHIT   STA     ,Y+             ; TOKEN: the token byte
        LEAS    2,S
        BRA     TLOOP
NOKW    LDA     ,X+
        STA     ,Y+
        BRA     TLOOP
TEND    CLR     ,Y+
        STY     PROGST
        LDD     LNUM
        STD     PROGST+2
        CLR     ,Y
        CLR     1,Y
        JMP     PROMPT
PRINT   LDA     ,X+
        BEQ     PRINTX
        PSHS    X
        JSR     [$A002]
        PULS    X
        BRA     PRINT
PRINTX  RTS
OKMSG   FCC     "OK"
        FCB     13,0
KWTAB   FCC     "ALPHA"
        FCB     $C1
        FCC     "BETA"
        FCB     $C2
        FCC     "GO"
        FCB     $C3
        FCB     0
LEN     FCB     0
LNUM    FDB     0
TMP     FDB     0
BUF     RMB     80
        END     START
