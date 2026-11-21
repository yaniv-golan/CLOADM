* A stand-in for BASIC's CLOADM and EXEC (tools/mame-diff/tape, written for CLOADM; no BASIC ROM code or data in
* it), installed in place of the BASIC ROM. It models only what decides whether a tape that loads over BASIC's own
* RAM starts, so that tests/tape-load.test.js can load such tapes through Session.load as a dropped file is:
*   - the namefile goes to the cassette buffer at $01DA, the exec address to $009D and each data block straight
*     to the load address, with BASIC's stack below a 200-byte string space at the top of 32K (S = $7F36): a
*     block that lands on the stack replaces the return address of the routine reading it (Color BASIC
*     Unravelled II: CASBUF, EXECJP, the stack below the string space; the Dragon's map is the same here)
*   - CASON: the motor on, then about half a second (65536 x 8 cycles) before a leader is looked for, for the
*     namefile and again for the data blocks, with the motor off in between (Color BASIC Unravelled II, CASON)
*   - a line is entered with ENTER (row 6, column 0 on the Dragon and the CoCo alike): the first runs CLOADM,
*     after which "OK" goes out through the console-out hook at $0167 (a RAM hook BASIC calls; the load may have
*     replaced it), and the next runs EXEC: a jump to the exec address. The keys before ENTER are not read.
* Waiting for a key it sits in a loop in ROM that reads the keyboard, as BASIC at its prompt does.
* $0080 says how far it got: 'C' CLOADM running, 'O' printing through the hook, 'P' at the prompt after it,
* 'E' EXEC. A tape's own start-up code (the tests') writes "ST" at $4000.
CASBUF  EQU     $01DA
HOOK    EQU     $0167
EXECJP  EQU     $009D
CBUFAD  EQU     $007E
STAGE   EQU     $0080
BYTE    EQU     $00E0
BITS    EQU     $00E1
TYPE    EQU     $00E2
LEN     EQU     $00E3
        ORG     $8000
RESET   ORCC    #$50
        LDS     #$7F36
        CLRA
        TFR     A,DP
        STA     STAGE
        CLR     $FF01           ; PIA0: port A rows in, port B columns out
        CLR     $FF00
        LDA     #$04
        STA     $FF01
        CLR     $FF03
        LDA     #$FF
        STA     $FF02
        LDA     #$04
        STA     $FF03
        CLR     $FF21           ; PIA1 port A: PA0 (cassette in) input, the rest outputs
        LDA     #$FE
        STA     $FF20
        LDA     #$34            ; motor off
        STA     $FF21
        CLR     $FF23           ; PIA1 port B: VDG mode bits out
        LDA     #$F8
        STA     $FF22
        LDA     #$34
        STA     $FF23
        CLR     $FF22           ; text mode
        STA     $FFC9           ; SAM display offset $0400
        LDA     #$39            ; the console-out hook: RTS
        STA     HOOK
        LDX     #$0400          ; a clear text screen with OK on it (Session's boot check)
        LDD     #$6060
CLS     STD     ,X++
        CMPX    #$0600
        BNE     CLS
        LDD     #$4F4B          ; "OK" (VDG codes for O and K)
        STD     $0400
        JSR     ENTER           ; the CLOADM line
        LDA     #'C'
        STA     STAGE
        JSR     CLOADM
        LDA     #'O'
        STA     STAGE
        JSR     HOOK            ; "OK" goes out through the hook
        LDA     #'P'
        STA     STAGE
        JSR     ENTER           ; the EXEC line
        LDA     #'E'
        STA     STAGE
        JMP     [EXECJP]

* wait for ENTER to go down and come back up, reading the keyboard all the while
ENTER   LDA     #$FE            ; column 0
        STA     $FF02
ENDN    LDA     $FF00
        BITA    #$40
        BNE     ENDN
ENUP    LDA     $FF00
        BITA    #$40
        BEQ     ENUP
        RTS

CLOADM  JSR     CASON           ; the namefile
        LDX     #CASBUF
        JSR     BLKIN
        LDD     CASBUF+11
        STD     EXECJP
        LDD     CASBUF+13
        STD     CBUFAD
        LDA     #$34            ; motor off, then on again with the wait
        STA     $FF21
        JSR     CASON
BLKLP   LDX     CBUFAD
        JSR     BLKIN
        STX     CBUFAD
        LDA     TYPE
        CMPA    #$FF
        BNE     BLKLP
        LDA     #$34
        STA     $FF21
        RTS

* motor on, then 65536 x 8 cycles before anything is read
CASON   LDA     #$3C
        STA     $FF21
        LDX     #0
CDLY    LEAX    -1,X
        BNE     CDLY
        RTS

* a block to X: sync on $3C, type, length, data, checksum (not checked); X past the data
BLKIN   CLR     BYTE
SYNC    JSR     RDBIT
        ROR     BYTE
        LDA     BYTE
        CMPA    #$3C
        BNE     SYNC
        JSR     RDBYTE
        STA     TYPE
        JSR     RDBYTE
        STA     LEN
        LDB     LEN
        BEQ     BKSUM
BKLP    JSR     RDBYTE
        STA     ,X+
        DECB
        BNE     BKLP
BKSUM   JSR     RDBYTE
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

RDBIT   PSHS    A,X
        LDX     #0
RB1     LDA     $FF20
        LEAX    1,X
        LSRA
        BCS     RB1
RB2     LDA     $FF20
        LEAX    1,X
        LSRA
        BCC     RB2
        CMPX    #37
        PULS    A,X,PC

        ORG     $BFF0
        FDB     RESET,RESET,RESET,RESET,RESET,RESET,RESET,RESET
