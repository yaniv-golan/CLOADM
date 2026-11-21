* CLOADM-style tape reader (tools/mame-diff/tape, written for CLOADM), installed in place of the BASIC ROM.
*
* Reads files from the tape the way BASIC's CLOADM goes about it, which is what decides whether a block is
* found: for each file it switches the motor on and waits about half a second (65536 x 8 cycles) before it
* looks for a block, as BASIC's CASON does (Color BASIC Unravelled II, CASON/CSRDON), reads the namefile,
* switches the motor off, then on again with the same wait, and reads blocks until the end-of-file block.
* The tape moves during each wait, so a block whose leader is shorter than the wait is missed.
* Each block read goes in a table at $1000, 4 bytes: type, length, checksum good (1) or bad (0), first data byte.
* It stops when no block starts within about 4 s (the end of the tape). In HALT: U = the end of the table.
* run-cloadm.js runs it in MAME and on our machine with the same .CAS files; the tables must be identical.
TABLE   EQU     $1000
BYTE    EQU     $0100
BITS    EQU     $0102
TYPE    EQU     $0103
LEN     EQU     $0104
SUM     EQU     $0105
FIRST   EQU     $0106
TOUT    EQU     $0107           ; high byte of the wait for an edge
        ORG     $8000
RESET   ORCC    #$50
        LDS     #$7F00
        CLRA
        TFR     A,DP
        CLR     $FF21           ; PIA1 port A: PA0 (cassette in) input, the rest outputs
        LDA     #$FE
        STA     $FF20
        LDA     #$34            ; motor off
        STA     $FF21
        LDU     #TABLE
FILE    JSR     CASON           ; the namefile
        JSR     BLOCK
        LDA     #$34            ; motor off, then on again with the wait
        STA     $FF21
        JSR     CASON
DATA    JSR     BLOCK
        LDA     TYPE
        CMPA    #$FF
        BNE     DATA
        LDA     #$34
        STA     $FF21
        BRA     FILE
END     LDA     #$34            ; (from RDBIT: no edge for about 4 s)
        STA     $FF21
HALT    BRA     HALT

* motor on, then 65536 x 8 cycles before anything is read
CASON   LDA     #$3C
        STA     $FF21
        LDX     #0
CDLY    LEAX    -1,X
        BNE     CDLY
        RTS

* one block: sync on $3C, then type, length, data, checksum; recorded in the table
BLOCK   CLR     BYTE
SYNC    JSR     RDBIT
        ROR     BYTE
        LDA     BYTE
        CMPA    #$3C
        BNE     SYNC
        JSR     RDBYTE
        STA     TYPE
        STA     SUM
        JSR     RDBYTE
        STA     LEN
        ADDA    SUM
        STA     SUM
        CLR     FIRST
        LDB     LEN
        BEQ     BKSUM
        JSR     RDBYTE
        STA     FIRST
        BRA     BKADD
BKLP    JSR     RDBYTE
BKADD   ADDA    SUM
        STA     SUM
        DECB
        BNE     BKLP
BKSUM   JSR     RDBYTE
        LDB     #1
        CMPA    SUM
        BEQ     BKREC
        CLRB
BKREC   LDA     TYPE
        STA     ,U+
        LDA     LEN
        STA     ,U+
        STB     ,U+
        LDA     FIRST
        STA     ,U+
        RTS

RDBYTE  PSHS    B
        LDB     #8
        STB     BITS
RBLP    JSR     RDBIT
        ROR     BYTE
        DEC     BITS
        BNE     RBLP
        LDA     BYTE
        PULS    B,PC

* one bit -> C: a cycle timed rising edge to rising edge (as cload.asm), under 31 counts is a 1. No edge for
* 4 x 65536 counts: the end of the tape
RDBIT   PSHS    A,X
        CLR     TOUT
        LDX     #0
RB1     LDA     $FF20           ; wait while high
        LEAX    1,X
        BEQ     RBT1
RB1C    LSRA
        BCS     RB1
RB2     LDA     $FF20           ; then while low: the next rising edge ends the cycle
        LEAX    1,X
        BEQ     RBT2
RB2C    LSRA
        BCC     RB2
        CMPX    #31             ; 18 cycles a count: a 1 is about 21 counts, a 0 about 41
        PULS    A,X,PC
RBT1    BSR     TICK
        BRA     RB1C
RBT2    BSR     TICK
        BRA     RB2C
TICK    INC     TOUT
        PSHS    A
        LDA     TOUT
        CMPA    #4
        PULS    A
        BHS     ENDT
        RTS
ENDT    LEAS    7,S             ; (TICK's return, RDBIT's A, X and return)
        JMP     END

        ORG     $BFF0
        FDB     RESET,RESET,RESET,RESET,RESET,RESET,RESET,RESET
