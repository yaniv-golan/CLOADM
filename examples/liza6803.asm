; ---------------------------------------------------------------
; LIZA - an ELIZA-style conversation program for the MC-10 and the
; Matra Alice (MC6803), holding the same conversation as the 6809
; build (examples/liza.asm). The keywords, replies and pronoun swaps
; come from the data file both builds read (examples/liza-data.inc).
;
; What the 6803 forces (not choices): one index register, so the
; 6809 build's second pointer (Y) and U live in RAM and are reached
; with LDX ptr / STX ptr; ABX and INX replace LEAX; PSHS/PULS take
; one register at a time; JSR has no indirect form, so the ROM entry
; points are called directly.
;
; The 6803 has no ROM cursor variable this project can verify, so
; LIZA keeps its own: CUR is the screen cell the cursor block sits
; in, and it follows the console's rules (32 columns, newline to the
; next row, the screen scrolls at the bottom). See docs/claude.md,
; "LIZA for the 6803".
;
; It runs with Micro Color BASIC or the emulator's built-in stub,
; through the MC-10 ROM entry points POLCAT ($F883: key in A, Z set
; when none) and CHROUT ($F9C6: print A). The screen is the 32x16
; text screen at $4000. The program sits at $5000, above the 4K
; option's RAM, so it needs the MC-10/Alice 20K option. Size: 3530 bytes of code and data, from $5000 to
; $5DC9, with variables extending to $5FB4.
;
; Pointer state lives in the program's own RAM, not the 6803's
; on-chip RAM at $80-$FF: BASIC's own routines use that while CHROUT
; runs, and nothing here can say which bytes they keep there.
; ---------------------------------------------------------------

POLCAT  EQU     $F883           ; ROM entry: read key -> A, Z=1 if none
CHROUT  EQU     $F9C6           ; ROM entry: print the character in A
SCREEN  EQU     $4000           ; text screen (32x16, VDG codes)
LINEW   EQU     31              ; usable characters per line
MAXIN   EQU     60              ; longest input line
STACK   EQU     $5000-1         ; stack top: the 6803 pushes down, so the first JSR writes $4FFF
                                ; and $4FFE. At $5000 it would write over this program's first
                                ; instruction, which is the byte after ORG.

        ORG     $5000

START   LDS     #STACK          ; stack just below the program
        JSR     CLS
        LDX     #TITLE
        JSR     PRINTW
        JSR     NEWLN
        JSR     NEWLN
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
        BCC     BYENOW
        TST     INBUF           ; nothing typed?
        BNE     NOTEMP
        LDX     #R_EMPTY
        BRA     RESPND

BYENOW  LDX     #BYEMSG
        JSR     PRINTW
        JSR     NEWLN
DONE    BRA     DONE

NOTEMP  LDX     #INBUF          ; the same as last time?
        STX     CMP1
        LDX     #LASTIN
        STX     CMP2
        JSR     STREQZ
        BNE     NOTREP
        LDX     #R_REP
        BRA     RESPND

NOTREP  JSR     SAVELAST
        LDX     #KEYTAB         ; try every keyword, in priority order
KLOOP   TST     0,X
        BEQ     NOKEY
        STX     KEYKEEP
        PSHX
        JSR     FIND
        PULX
        BCC     GOTKEY
        JSR     SKIPZ           ; skip the keyword text (X ends past its zero)
        INX
        INX                     ; and its 2-byte response pointer
        BRA     KLOOP

GOTKEY  LDX     KEYKEEP         ; the keyword entry that matched: skip its text
        JSR     SKIPZ
        LDX     0,X             ; X = the response list
        BRA     RESPN2

NOKEY   LDX     #R_NONE
RESPND  PSHX                    ; REST = EMPTY, the 6809 build's Y, without losing X
        LDD     #EMPTY
        STD     REST
        PULX

; X -> response list: count, next index, pointers...
RESPN2  LDAB    1,X             ; take the next response in rotation
        PSHB
        INCB
        CMPB    0,X
        BLO     RESPN3
        CLRB
RESPN3  STAB    1,X
        PULB
        LSLB                    ; B = 2 * index
        ABX                     ; X = list + 2 * index
        INX
        INX                     ; X = list + 2 + 2 * index
        LDX     0,X             ; X -> response template
        JSR     BUILD           ; OUTBUF = the template with '*' expanded
        LDX     #OUTBUF
        JSR     PRINTW
        JSR     NEWLN
        JSR     NEWLN
        JMP     MAIN

; ---------------------------------------------------------------
; FIND: search WORK for the keyword at X.
; out: C=0 on a match, with REST -> the text after it. X preserved.
FIND    STX     KEYPTR
        LDX     #WORK
        STX     MATCH
FLOOP   LDX     MATCH
        TST     0,X
        BEQ     FNOT            ; end of the text: no match
        LDX     MATCH
        STX     SCRPTR          ; compare from here
        LDX     KEYPTR
        STX     TMP
FCMP    LDX     TMP
        LDAA    0,X
        BEQ     FMATCH          ; the keyword ran out: it matched
        INX
        STX     TMP
        LDX     SCRPTR
        LDAB    0,X
        INX
        STX     SCRPTR
        CBA
        BEQ     FCMP
        LDX     MATCH           ; no match here: try one character on
        INX
        STX     MATCH
        BRA     FLOOP
FMATCH  LDX     SCRPTR
        STX     REST
        LDX     KEYPTR
        CLC
        RTS
FNOT    LDX     KEYPTR
        SEC
        RTS

; BUILD: copy the template at X to OUTBUF, replacing '*' by the
; reflected context (I -> YOU, MY -> YOUR, ...)
BUILD   STX     SRCPTR
        LDX     #OUTBUF
        STX     OUTPTR
BLOOP   LDX     SRCPTR
        LDAA    0,X
        BEQ     BDONE
        CMPA    #'*
        BNE     BPUT
        INX
        STX     SRCPTR
        JSR     REFLECT
        BRA     BLOOP
BPUT    INX
        STX     SRCPTR
        LDX     OUTPTR
        STAA    0,X
        INX
        STX     OUTPTR
        BRA     BLOOP
BDONE   LDX     OUTPTR
        CLR     0,X
        RTS

; REFLECT: append the words of REST to OUTPTR, swapping person
REFLECT LDX     REST
        STX     RELPTR
RWORD   LDX     RELPTR
        LDAA    0,X
        BEQ     RFIN
        CMPA    #' '
        BNE     RCOPY
        INX
        STX     RELPTR          ; skip the spaces between words
        BRA     RWORD
RCOPY   LDX     #WBUF           ; copy the word into WBUF
        STX     WORDPTR
RC1     LDX     RELPTR
        LDAA    0,X
        BEQ     RC2
        CMPA    #' '
        BEQ     RC2
        INX
        STX     RELPTR
        LDX     WORDPTR
        STAA    0,X
        INX
        STX     WORDPTR
        BRA     RC1
RC2     LDX     WORDPTR
        CLR     0,X             ; terminate WBUF
        LDX     OUTPTR          ; a space before the word
        LDAA    #' '
        STAA    0,X
        INX
        STX     OUTPTR
        LDX     #RTAB           ; look the word up in the swap table
        STX     WALK
RL1     LDX     WALK
        TST     0,X
        BEQ     RNOTF
        LDX     #WBUF
        STX     CMP1
        LDX     WALK
        STX     CMP2
        JSR     STREQZ
        BEQ     RFOUND
        LDX     WALK            ; skip the word and its replacement
        JSR     SKIPZ
        JSR     SKIPZ
        STX     WALK
        BRA     RL1
RFOUND  LDX     WALK
        JSR     SKIPZ           ; skip the word that matched
        JSR     APPEND          ; X -> its replacement: append that
        BRA     RWORD
RNOTF   LDX     #WBUF
        JSR     APPEND          ; no entry: the word as typed
        BRA     RWORD
RFIN    RTS

; APPEND: copy the zero-terminated string at X to OUTPTR. It keeps its own
; source pointer so a caller walking a string (BUILD over a template) can call
; it without losing its place.
APPEND  STX     APPTR
APP1    LDX     APPTR
        LDAA    0,X
        BEQ     APPX
        INX
        STX     APPTR
        LDX     OUTPTR
        STAA    0,X
        INX
        STX     OUTPTR
        BRA     APP1
APPX    RTS

; SKIPZ: advance X past a zero-terminated string (past the zero, as the
; 6809 build's LDA 0,X+ version of this does)
SKIPZ   LDAA    0,X
        BEQ     SKIPX
        INX
        BRA     SKIPZ
SKIPX   INX
        RTS

; STREQZ: compare the strings at CMP1 and CMP2. Z=1 when equal.
STREQZ  LDX     CMP1
        LDAA    0,X
        INX
        STX     CMP1
        LDX     CMP2
        LDAB    0,X
        INX
        STX     CMP2
        CBA
        BNE     STRX
        TSTA
        BNE     STREQZ
STRX    RTS

; SAVELAST: copy INBUF to LASTIN
SAVELAST LDX    #INBUF
        STX     SAVSRC
        LDX     #LASTIN
        STX     SAVDST
SV1     LDX     SAVSRC
        LDAA    0,X
        INX
        STX     SAVSRC
        LDX     SAVDST
        STAA    0,X
        INX
        STX     SAVDST
        TSTA                    ; copy the terminator too
        BNE     SV1
        RTS

; NORMAL: WORK = " " + input (punctuation -> spaces) + " "
NORMAL  LDX     #INBUF
        STX     NPTR
        LDX     #WORK
        STX     OUTPTR
        LDAA    #' '
        JSR     OUTCH
N1      LDX     NPTR
        LDAA    0,X
        INX
        STX     NPTR
        TSTA                    ; (STX sets the flags on a 6801: test A, not the store)
        BEQ     N3
        LDX     #PUNCT
        STX     WALK
N2      LDX     WALK
        LDAB    0,X
        BEQ     N4
        INX
        STX     WALK
        CBA
        BNE     N2
        LDAA    #' '            ; punctuation becomes a space
N4      JSR     OUTCH
        BRA     N1
N3      LDAA    #' '
        JSR     OUTCH
        CLRA
        JSR     OUTCH
        RTS

; OUTCH: store A at OUTPTR and advance it
OUTCH   LDX     OUTPTR
        STAA    0,X
        INX
        STX     OUTPTR
        RTS

; ---------------------------------------------------------------
; screen and keyboard

; CLS: clear the screen, home the console's cursor and ours
CLS     LDAA    #12
        JSR     CHROUT
        LDX     #SCREEN         ; clear it here too, so the screen is clean
        LDAA    #$60            ; even on a ROM that treats $0C differently
CL1     STAA    0,X
        INX
        CPX     #SCREEN+512
        BNE     CL1
        LDX     #SCREEN
        STX     CUR
        CLR     COL
        RTS

; PUTC: print A, keeping our cursor (CUR) and column (COL) in step
; with the console. Preserves A, B and X.
PUTC    PSHX
        PSHB
        PSHA
        LDX     CUR
        LDAA    #$60
        STAA    0,X             ; remove the cursor block
        PULA
        PSHA
        JSR     CHROUT          ; print it (the console advances its cursor)
        PULA
        PSHA
        CMPA    #13
        BEQ     PC_CR
        CMPA    #8
        BEQ     PC_BS
        CMPA    #32
        BLO     PC_COL          ; other control codes move nothing
        JSR     CURADV          ; a printable character: one cell on
        BRA     PC_COL
PC_CR   JSR     CURCR
        BRA     PC_COL
PC_BS   JSR     CURBS
PC_COL  PULA                    ; the column count
        CMPA    #13
        BNE     PC1
        CLR     COL
        BRA     PCX
PC1     CMPA    #8
        BNE     PC2
        DEC     COL
        BRA     PCX
PC2     INC     COL
        LDAA    COL
        CMPA    #32
        BLO     PCX
        CLR     COL
PCX     PULB
        PULX
        RTS

; CURADV: one cell on, scrolling as the console does at the bottom
CURADV  LDX     CUR
        INX
        CPX     #SCREEN+512
        BNE     CURAD1
        LDX     #SCREEN+512-32  ; the console scrolled: the last row
CURAD1  STX     CUR
        RTS

; CURCR: the start of the next row, scrolling at the bottom
CURCR   LDD     CUR
        SUBD    #SCREEN         ; the offset within the screen
        ANDB    #$E0            ; the start of this row
        ADDD    #SCREEN+32      ; the start of the next
        STD     CUR
        SUBD    #SCREEN+512
        BLO     CURCR1
        LDD     #SCREEN+512-32  ; the console scrolled: the last row
        STD     CUR
CURCR1  RTS

; CURBS: one cell back, not before the top of the screen
CURBS   LDX     CUR
        CPX     #SCREEN
        BLS     CURBS1
        DEX
        STX     CUR
CURBS1  RTS

NEWLN   LDAA    #13
        JMP     PUTC

SHOWCUR PSHX
        LDAA    #$80            ; the block that marks the cursor
        LDX     CUR
        STAA    0,X
        PULX
        RTS

GETKEY  PSHX
        PSHB
GK1     JSR     POLCAT
        BEQ     GK1
        PULB
        PULX
        RTS

; PRINTZ: print the zero-terminated string at X
PRINTZ  STX     ZPTR
PZ1     LDX     ZPTR
        LDAA    0,X
        BEQ     PZX
        INX
        STX     ZPTR
        JSR     PUTC
        BRA     PZ1
PZX     RTS

; PRINTW: print the string at X with word wrapping
PRINTW  STX     WPTR
PW1     LDX     WPTR
        LDAA    0,X
        BEQ     PWEND
        CMPA    #' '
        BNE     PWWORD
        INX
        STX     WPTR
        TST     COL
        BEQ     PW1             ; no space at the start of a line
        BSR     WLEN
        ADDB    COL
        INCB
        CMPB    #LINEW
        BHI     PWNL
        LDAA    #' '
        JSR     PUTC
        BRA     PW1
PWNL    JSR     NEWLN
        BRA     PW1
PWWORD  BSR     WLEN
        ADDB    COL
        CMPB    #LINEW
        BLS     PWC
        TST     COL
        BEQ     PWC
        JSR     NEWLN
PWC     LDX     WPTR
        LDAA    0,X
        BEQ     PWEND
        CMPA    #' '
        BEQ     PW1
        INX
        STX     WPTR
        JSR     PUTC
        BRA     PWC
PWEND   RTS

; WLEN: B = the length of the word at X. A and X preserved.
WLEN    PSHX
        PSHA
        CLRB
WL1     LDAA    0,X
        BEQ     WL2
        CMPA    #' '
        BEQ     WL2
        INX
        INCB
        BRA     WL1
WL2     PULA
        PULX
        RTS

; READLN: read a line into INBUF (upper case), with backspace
READLN  LDX     #INBUF
        STX     RPTR
        CLR     INLEN
RLC     JSR     SHOWCUR
RLK     JSR     GETKEY
        CMPA    #13
        BEQ     RLEND
        CMPA    #8
        BEQ     RLBS
        CMPA    #' '
        BLO     RLK
        CMPA    #'a
        BLO     RLU
        CMPA    #'z
        BHI     RLU
        SUBA    #32
RLU     LDAB    INLEN
        CMPB    #MAXIN
        BHS     RLK
        LDX     RPTR
        STAA    0,X
        INX
        STX     RPTR
        INC     INLEN
        JSR     PUTC
        BRA     RLC
RLBS    TST     INLEN
        BEQ     RLK
        DEC     INLEN
        LDX     RPTR
        DEX
        STX     RPTR
        JSR     PUTC
        BRA     RLC
RLEND   LDX     RPTR
        CLR     0,X
        RTS

; ---------------------------------------------------------------
; data

; The title names the machine the build runs on, selected at assembly time by the same per-machine flags
; the welcome program uses (tools/build-examples.js passes all of them, 0 or 1; an undefined one is an
; assembler error, so a build cannot take the wrong machine's name). The two titles are THE SAME LENGTH as
; the old single title and each other, with the 0 terminator at the same offset, so the two machine builds
; differ only in the name AND the layout (and every address after it) is unchanged from the pre-split MC-10
; build: tests/liza6803.test.js checks the byte-for-byte difference.
;   "LIZA - AN TANDY MC-10 THERAPIST"   -> "LIZA - AN MC-10 THERAPIST" is the old title; keep its length:
; the pair below is 25 characters each, as the old one was.
        IF      MC10
TITLE   FCB     "LIZA - AN MC-10 THERAPIST",0
        ENDIF
        IF      ALICE
TITLE   FCB     "LIZA - AN ALICE THERAPIST",0
        ENDIF
INTRO   FCB     "HELLO, I AM LIZA. PLEASE TELL ME WHAT IS ON YOUR MIND. TYPE BYE WHEN YOU WANT TO LEAVE.",0
PROMPT  FCB     "> ",0
BYEMSG  FCB     "GOODBYE. IT WAS NICE TALKING TO YOU. TAKE CARE OF YOURSELF.",0
KBYE    FCB     " BYE",0
PUNCT   FCB     "?!.,;:",0
EMPTY   FCB     0

INCLUDE "liza-data.inc"         ; the keywords, replies and pronoun swaps,
                                ; shared with the 6809 build

; ---- variables ----
CUR     RMB     2               ; the screen cell the cursor block is in
REST    RMB     2               ; the text after the keyword that matched
ZPTR    RMB     2               ; PRINTZ: the string being printed
WPTR    RMB     2               ; PRINTW: the string being printed
RPTR    RMB     2               ; READLN: the next free cell of INBUF
NPTR    RMB     2               ; NORMAL: the input being cleaned
KEYPTR  RMB     2               ; FIND: the keyword
KEYKEEP RMB     2               ; the keyword entry that matched
MATCH   RMB     2               ; FIND: where this attempt starts in WORK
SCRPTR  RMB     2               ; FIND: the text being compared
TMP     RMB     2               ; FIND: the keyword being compared
SRCPTR  RMB     2               ; BUILD/APPEND: the source string
OUTPTR  RMB     2               ; BUILD/REFLECT: where the reply is built
RELPTR  RMB     2               ; REFLECT: the reflected text being walked
WORDPTR RMB     2               ; REFLECT: the word being copied
WALK    RMB     2               ; a table being walked
CMP1    RMB     2               ; STREQZ: string 1
CMP2    RMB     2               ; STREQZ: string 2
SAVSRC  RMB     2               ; SAVELAST: source
SAVDST  RMB     2               ; SAVELAST: destination
APPTR   RMB     2               ; APPEND: the string being copied
COL     RMB     1
INLEN   RMB     1
INBUF   RMB     MAXIN+1
LASTIN  RMB     MAXIN+1
WORK    RMB     MAXIN+4
WBUF    RMB     MAXIN+1
OUTBUF  RMB     200

        END     START
