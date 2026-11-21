; ---------------------------------------------------------------
; LIZA - an ELIZA-style conversation program for the Dragon 64
; 6809 assembly. Uses the ROM POLCAT/CHROUT vectors, so it runs
; with the real Dragon BASIC ROM or the emulator's built-in stub.
; Assemble with the emulator's built-in assembler.
; ---------------------------------------------------------------

POLCAT  EQU     $A000           ; ROM vector: read key -> A, Z=1 if none
CHROUT  EQU     $A002           ; ROM vector: print character in A
CURPOS  EQU     $0088           ; text cursor address (ROM variable)
SCREEN  EQU     $0400
LINEW   EQU     31              ; usable characters per line
MAXIN   EQU     60              ; longest input line

        ORG     $3000

START   LDS     #$3000          ; stack just below the program
        JSR     HEADER
        LDX     #INTRO
        JSR     PRINTW
        JSR     NEWLN
        JSR     NEWLN

; ---- main conversation loop ----
MAIN    LDX     #PROMPT
        JSR     PRINTZ
        JSR     READLN
        JSR     NEWLN
        JSR     NORMAL          ; WORK = " " + cleaned input + " "

        LDX     #KBYE           ; leaving?
        JSR     FIND
        BCS     NOTBYE
BYENOW  LDX     #BYEMSG         ; (BREAK in READLN comes here too)
        JSR     PRINTW
        JSR     NEWLN
DONE    BRA     DONE

NOTBYE  TST     INBUF           ; nothing typed?
        BNE     NOTEMP
        LDX     #R_EMPTY
        BRA     RESPND

NOTEMP  LDX     #INBUF          ; same as last time?
        LDY     #LASTIN
        JSR     STREQ
        BNE     NOTREP
        LDX     #R_REP
        BRA     RESPND

NOTREP  JSR     SAVELAST
        LDX     #KEYTAB         ; try every keyword in priority order
KLOOP   TST     ,X
        BEQ     NOKEY
        PSHS    X
        JSR     FIND
        PULS    X
        BCC     GOTKEY
        JSR     SKIPZ           ; skip keyword text
        LEAX    2,X             ; and its response pointer
        BRA     KLOOP

GOTKEY  STY     REST            ; text following the keyword
        JSR     SKIPZ
        LDX     ,X              ; X = response list
        BRA     RESPN2

NOKEY   LDX     #R_NONE
RESPND  LDY     #EMPTY
        STY     REST

; X -> response list: count, next index, pointers...
RESPN2  LDB     1,X             ; pick the next response in rotation
        PSHS    B
        INCB
        CMPB    ,X
        BLO     RESPN3
        CLRB
RESPN3  STB     1,X
        PULS    B
        LSLB
        LEAY    2,X
        LDX     B,Y             ; X -> response template
        JSR     BUILD           ; OUTBUF = template with '*' expanded
        LDX     #OUTBUF
        JSR     PRINTW
        JSR     NEWLN
        JSR     NEWLN
        JMP     MAIN

; ---------------------------------------------------------------
; FIND: search WORK for keyword at X.
; out: C=0 found, Y -> text after the keyword. X preserved.
FIND    LDU     #WORK
FLOOP   TST     ,U
        BEQ     FNOT
        PSHS    X,U
FCMP    LDA     ,X+
        BEQ     FMATCH
        CMPA    ,U+
        BEQ     FCMP
        PULS    X,U
        LEAU    1,U
        BRA     FLOOP
FMATCH  LEAY    ,U
        PULS    X,U
        ANDCC   #$FE
        RTS
FNOT    ORCC    #$01
        RTS

; BUILD: copy template X to OUTBUF, replacing '*' by the
; reflected keyword context (I -> YOU, MY -> YOUR, ...)
BUILD   LDU     #OUTBUF
BLOOP   LDA     ,X+
        BEQ     BDONE
        CMPA    #'*
        BNE     BPUT
        PSHS    X
        JSR     REFLECT
        PULS    X
        BRA     BLOOP
BPUT    STA     ,U+
        BRA     BLOOP
BDONE   CLR     ,U
        RTS

; REFLECT: append words of REST to U, swapping person
REFLECT LDY     REST
RWORD   LDA     ,Y
        BEQ     RFIN
        CMPA    #' '
        BNE     RCOPY
        LEAY    1,Y
        BRA     RWORD
RCOPY   LDX     #WBUF
RC1     LDA     ,Y
        BEQ     RC2
        CMPA    #' '
        BEQ     RC2
        STA     ,X+
        LEAY    1,Y
        BRA     RC1
RC2     CLR     ,X
        LDA     #' '
        STA     ,U+
        LDX     #RTAB
RL1     TST     ,X
        BEQ     RNOTF
        PSHS    Y
        LDY     #WBUF
        JSR     STREQ
        PULS    Y
        BEQ     RFOUND
        JSR     SKIPZ
        JSR     SKIPZ
        BRA     RL1
RFOUND  JSR     SKIPZ
        BSR     APPEND
        BRA     RWORD
RNOTF   LDX     #WBUF
        BSR     APPEND
        BRA     RWORD
RFIN    RTS

APPEND  LDA     ,X+             ; copy string X to U
        BEQ     APPX
        STA     ,U+
        BRA     APPEND
APPX    RTS

SKIPZ   LDA     ,X+             ; advance X past a zero-terminated string
        BNE     SKIPZ
        RTS

; STREQ: compare strings at X and Y. Z=1 if equal. X,Y preserved.
STREQ   PSHS    X,Y
SQ1     LDA     ,X+
        CMPA    ,Y+
        BNE     SQ2
        TSTA
        BNE     SQ1
SQ2     PULS    X,Y,PC

SAVELAST LDX    #INBUF
        LDY     #LASTIN
SV1     LDA     ,X+
        STA     ,Y+
        BNE     SV1
        RTS

; NORMAL: WORK = " " + input (punctuation -> spaces) + " "
NORMAL  LDX     #INBUF
        LDU     #WORK
        LDA     #' '
        STA     ,U+
N1      LDA     ,X+
        BEQ     N3
        LDY     #PUNCT
N2      LDB     ,Y+
        BEQ     N4
        PSHS    B
        CMPA    ,S+
        BNE     N2
        LDA     #' '
N4      STA     ,U+
        BRA     N1
N3      LDA     #' '
        STA     ,U+
        CLR     ,U
        RTS

; ---------------------------------------------------------------
; screen and keyboard

; HEADER: a clear screen with the title and a blank line under it
HEADER  JSR     CLS
        LDX     #TITLE
        JSR     PRINTW
        JSR     NEWLN
        JMP     NEWLN

CLS     LDX     #SCREEN
        LDA     #$60
CL1     STA     ,X+
        CMPX    #SCREEN+512
        BNE     CL1
        LDX     #SCREEN
        STX     CURPOS
        CLR     COL
        RTS

; PUTC: print A, keeping track of the column
PUTC    PSHS    A,B,X,Y,U
        LDX     CURPOS          ; remove the cursor block
        LDB     #$60
        STB     ,X
        JSR     [CHROUT]
        LDA     ,S
        CMPA    #13
        BNE     PC1
        CLR     COL
        BRA     PC3
PC1     CMPA    #8
        BNE     PC2
        DEC     COL
        BRA     PC3
PC2     INC     COL
        LDA     COL
        CMPA    #32
        BLO     PC3
        CLR     COL
PC3     PULS    A,B,X,Y,U,PC

NEWLN   LDA     #13
        BRA     PUTC

SHOWCUR PSHS    A,X
        LDX     CURPOS
        LDA     #$80            ; black block
        STA     ,X
        PULS    A,X,PC

GETKEY  PSHS    B,X,Y,U
GK1     JSR     [POLCAT]
        BEQ     GK1
        PULS    B,X,Y,U,PC

; PRINTZ: print zero-terminated string at X
PRINTZ  LDA     ,X+
        BEQ     PZX
        JSR     PUTC
        BRA     PRINTZ
PZX     RTS

; PRINTW: print string at X with word wrapping
PRINTW  LDA     ,X
        BEQ     PWEND
        CMPA    #' '
        BNE     PWWORD
        LEAX    1,X
        TST     COL
        BEQ     PRINTW          ; no spaces at the start of a line
        BSR     WLEN
        ADDB    COL
        INCB
        CMPB    #LINEW
        BHI     PWNL
        LDA     #' '
        JSR     PUTC
        BRA     PRINTW
PWNL    JSR     NEWLN
        BRA     PRINTW
PWWORD  BSR     WLEN
        ADDB    COL
        CMPB    #LINEW
        BLS     PWC
        TST     COL
        BEQ     PWC
        JSR     NEWLN
PWC     LDA     ,X
        BEQ     PRINTW
        CMPA    #' '
        BEQ     PRINTW
        JSR     PUTC
        LEAX    1,X
        BRA     PWC
PWEND   RTS

WLEN    PSHS    X               ; B = length of word at X
        CLRB
WL1     LDA     ,X+
        BEQ     WL2
        CMPA    #' '
        BEQ     WL2
        INCB
        BRA     WL1
WL2     PULS    X,PC

; READLN: read a line into INBUF (upper case), with backspace.
; BREAK (POLCAT code 3) leaves as BYE does; CLEAR (12) drops the
; line, clears the screen and starts a fresh prompt. Neither returns.
READLN  LDX     #INBUF
        CLR     INLEN
RLC     JSR     SHOWCUR
RLK     JSR     GETKEY
        CMPA    #13
        BEQ     RLEND
        CMPA    #8
        BEQ     RLBS
        CMPA    #3
        BEQ     RLBRK
        CMPA    #12
        BEQ     RLCLR
        CMPA    #' '
        BLO     RLK
        CMPA    #'a
        BLO     RLU
        CMPA    #'z
        BHI     RLU
        SUBA    #32
RLU     LDB     INLEN
        CMPB    #MAXIN
        BHS     RLK
        STA     ,X+
        INC     INLEN
        JSR     PUTC
        BRA     RLC
RLBS    TST     INLEN
        BEQ     RLK
        DEC     INLEN
        LEAX    -1,X
        JSR     PUTC
        BRA     RLC
RLEND   CLR     ,X
        RTS
RLBRK   JSR     NEWLN
        JMP     BYENOW
RLCLR   LDS     #$3000          ; abandon READLN's caller: back to MAIN
        JSR     HEADER
        JMP     MAIN

; ---------------------------------------------------------------
; data

TITLE   FCB     "LIZA - A DRAGON 64 THERAPIST",0
INTRO   FCB     "HELLO, I AM LIZA. PLEASE TELL ME WHAT IS ON YOUR MIND. TYPE BYE WHEN YOU WANT TO LEAVE.",0
PROMPT  FCB     "> ",0
BYEMSG  FCB     "GOODBYE. IT WAS NICE TALKING TO YOU. TAKE CARE OF YOURSELF.",0
KBYE    FCB     " BYE",0
PUNCT   FCB     "?!.,;:",0
EMPTY   FCB     0

INCLUDE "liza-data.inc"         ; the keywords, replies and pronoun swaps,
                                ; shared with the 6803 build

; ---- variables ----
COL     RMB     1
INLEN   RMB     1
REST    RMB     2
INBUF   RMB     MAXIN+1
LASTIN  RMB     MAXIN+1
WORK    RMB     MAXIN+4
WBUF    RMB     MAXIN+1
OUTBUF  RMB     200

        END     START
