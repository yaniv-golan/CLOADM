* Cassette signal timer (tools/mame-diff/tape, written for CLOADM), installed in place of the BASIC ROM.
*
* Turns the motor on and times the cassette input (PIA1 PA0) for as long as the tape plays: every level change
* is an edge, and a stretch of more than GAPMIN counts with no edge is a gap (silence). For each gap it stores
* how many edges came before it (since the last gap) and how long it was, so the table describes the signal
* as runs of cycles separated by silences. run-gaps.js reads the table from MAME and from our machine: it is
* what shows where an emulator adds silence or leader when it plays a .CAS file.
*   table at $1000, 5 bytes per gap: edges (16-bit), gap length (24-bit, in loop counts of 22 cycles)
*   the last entry is the run after the last gap, ended by a silence of ENDHI x 65536 counts (about 19 s)
* In HALT: U = the end of the table.
TABLE   EQU     $1000
LAST    EQU     $0100           ; the input level last seen
HI      EQU     $0101           ; high byte of the count
GAPMIN  EQU     64              ; counts (about 1.6 ms): longer than any 1200 Hz half cycle
ENDHI   EQU     12
        ORG     $8000
RESET   ORCC    #$50
        LDS     #$7F00
        CLRA
        TFR     A,DP
        CLR     $FF21           ; PIA1 port A: PA0 (cassette in) input, the rest outputs
        LDA     #$FE
        STA     $FF20
        LDA     #$3C            ; data register, CA2 high: motor on
        STA     $FF21
        LDU     #TABLE
        LDY     #0              ; edges in the current run
        CLR     HI
        LDX     #0
        LDA     $FF20
        ANDA    #1
        STA     LAST
LOOP    LDA     $FF20           ; 22 cycles a count
        ANDA    #1
        CMPA    LAST
        BNE     EDGE
        LEAX    1,X
        BNE     LOOP
        INC     HI
        LDB     HI
        CMPB    #ENDHI
        BLO     LOOP
        STY     ,U++            ; the end: the last run, and the silence that ended it
        LDB     HI
        STB     ,U+
        STX     ,U++
        LDA     #$34            ; motor off
        STA     $FF21
HALT    BRA     HALT
EDGE    STA     LAST
        TST     HI
        BNE     GAP
        CMPX    #GAPMIN
        BLO     NOGAP
GAP     STY     ,U++
        LDB     HI
        STB     ,U+
        STX     ,U++
        LDY     #0
NOGAP   LEAY    1,Y
        LDX     #0
        CLR     HI
        BRA     LOOP

        ORG     $BFF0
        FDB     RESET,RESET,RESET,RESET,RESET,RESET,RESET,RESET
