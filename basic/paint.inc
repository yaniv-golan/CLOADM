* ---------------- PAINT ----------------
* docs/clean-room-basic-p2.md section 5 [OWN, a scan-line seed fill]. It works on the mode's own pixels, each a
* place (its byte and mask), so it never computes a coordinate: a seed is taken; if its pixel does not stop the fill,
* the run it lies in is found (left, then right, to a pixel that stops the fill or the picture's edge) and filled
* with HSPAN; along the run, the rows above and below get a seed at the left end of each stretch of pixels that do
* not stop the fill. A pixel stops the fill if it has the border colour [UM] or the paint colour [OWN: otherwise the
* fill would not end; BB]. What is filled is the 4-connected region of the start [OWN; BB], whatever the order the
* seeds are taken in. The seeds (a byte's address and a mask, 3 bytes) go on the 6809 stack, into the free memory
* above the arrays; when it is down to CHKSTK's margin: ?OM ERROR [OWN].
* Work (direct page, PAINT's alone while it runs): the run's ends, a row's end, the mode's masks and row length,
* the end of the pages, the border colour's byte.
PLX     EQU     TMPPTR          ; the run's left end (byte, mask)
PLM     EQU     TMPCNT
PRX     EQU     TMPPT2          ; its right end
PRM     EQU     TMPCNT+1
PFLAG   EQU     BINVAL          ; a stretch is open (PROW)
PBORD   EQU     BINVAL+1        ; the border colour in every pixel of a byte
PREND   EQU     USDSC           ; a row's last byte (PROW)
PTMP    EQU     USEXP
P4COL   EQU     USPOS           ; bit 7 set in four colours
PFIRST  EQU     USANY           ; a byte's first and last pixel masks
PLAST   EQU     USKIND
PBPRM   EQU     USNB            ; the bytes a row - 1
PEND    EQU     USNA            ; the high byte of the end of the pages

* PAINT (x,y)[,c[,b]] [UM]: from the point, in colour c (the foreground by default) up to the border colour b (c by
* default) [OWN; BB]. ?FC ERROR for a point off the picture or a colour above 8 [BB].
PAINT   LDU     #GXY
        JSR     GETXY
        JSR     RPAREN
        LDB     FGCOL
        JSR     <ZCHKCOM
        BNE     PN1
        JSR     GETCOL
PN1     PSHS    B
        JSR     <ZCHKCOM
        BNE     PN2
        JSR     GETCOL
        FCB     $8C             ; (CMPX #: skips the LDB)
PN2     LDB     ,S
        JSR     COLVAL
        STB     <PBORD
        PULS    B
        JSR     COLVAL
        STB     <GCOLB
* the mode: masks, row length, the pages' end
        LDX     <GMENT
        LDD     2,X             ; A: the bytes a row and the halvings, B: the first pixel's mask
        STB     <PFIRST
        ANDA    #$30
        DECA
        STA     <PBPRM
        LDA     #1
        ASLB
        STB     <P4COL
        BPL     PN3
        LDA     #3
PN3     STA     <PLAST
        LDA     1,X
        LSRA
        LSRA
        LSRA
        ADDA    <GBEG
        STA     <PEND
        CLRA                    ; under the seeds: address 0 ends the fill
        CLRB
        PSHS    D
        PSHS    A
        LDA     GXY+1
        LDB     GXY+3
        JSR     GPIXAD
        BRA     PQ2
PQ1     PULS    A,X
        LEAX    ,X
        BEQ     PQ9
PQ2     BSR     PTEST
        BEQ     PQ1
        STX     <PRX
        STA     <PRM
PQ3     STX     <PLX            ; left to the run's start
        STA     <PLM
        BSR     PLEFT
        BCS     PQ4
        BSR     PTEST
        BNE     PQ3
PQ4     LDX     <PRX            ; right from the seed to the run's end
        LDA     <PRM
PQ5     STX     <PRX
        STA     <PRM
        BSR     PRIGHT
        BCS     PQ6
        BSR     PTEST
        BNE     PQ5
PQ6     LDX     <PLX
        LDA     <PLM
        LDU     <PRX
        LDB     <PRM
        JSR     HSPAN
        LDB     <PBPRM          ; the row above, then the row below
        INCB
        NEGB
        SEX
        BSR     PROW
        LDB     <PBPRM
        INCB
        CLRA
        BSR     PROW
        BRA     PQ1
PQ9     RTS

* PTEST: Z set if the pixel of mask A in the byte at X stops the fill (keeps A, X)
PTEST   LDB     ,X
        EORB    <GCOLB
        PSHS    A
        ANDB    ,S
        BEQ     PT9
        LDB     ,X
        EORB    <PBORD
        ANDB    ,S
PT9     PULS    A,PC

* PRIGHT, PLEFT: the pixel to the right or left of (X, A); C set if that is off the row
PRIGHT  TST     <P4COL
        BPL     PZ1
        LSRA
PZ1     LSRA
        BNE     PZ9
        LEAX    1,X
        LDA     <PFIRST
        BSR     PROWB           ; the next byte starts a row: off it
        BRA     PZ8
PLEFT   TST     <P4COL
        BPL     PZ2
        ASLA
PZ2     ASLA
        BNE     PZ9
        BSR     PROWB           ; this byte starts a row: off it
        LEAX    -1,X
        LDA     <PLAST
PZ8     CMPB    #1              ; (C set when B is 0)
PZ9     RTS
* PROWB: B = X's place in its row (0 at the row's first byte)
PROWB   STX     <PTMP
        LDB     <PTMP+1
        ANDB    <PBPRM
        RTS

* PROW: seeds along the row D bytes away from the run (none off the pages). The seeds go on the stack, so the
* return address is kept in Y.
PROW    PULS    Y
        PSHS    D
        ADDD    <PRX
        STD     <PREND
        PULS    D
        ADDD    <PLX
        CMPA    <GBEG
        BLO     PJ9
        CMPA    <PEND
        BHS     PJ9
        TFR     D,X
        LDA     <PLM
        CLR     <PFLAG
PJ1     BSR     PTEST
        BEQ     PJ2
        TST     <PFLAG
        BNE     PJ3
        COM     <PFLAG          ; a stretch starts: its seed
        JSR     CHKSTK
        PSHS    A,X
        BRA     PJ3
PJ2     CLR     <PFLAG
PJ3     CMPX    <PREND
        BNE     PJ4
        CMPA    <PRM
        BEQ     PJ9
PJ4     BSR     PRIGHT
        BRA     PJ1
PJ9     JMP     ,Y
