* Cassette reader diagnostic (tools/mame-diff/tape, written for CLOADM).
*
* Reads a tape the way BASIC's CLOAD does, installed in place of the BASIC ROM: the motor relay on (PIA1 CA2),
* every cycle on the cassette input (PIA1 PA0) timed from one rising edge to the next with a counting loop,
* short cycles are 1 and long cycles 0, least significant bit first. It slides bits into a byte until it holds
* the sync byte $3C, then reads type, length, data and checksum. Namefile data goes to $2F00, data blocks one
* after another from $3000; the end-of-file block stops it. In HALT it reports, for the comparison:
*   X  data bytes read      Y  16-bit sum of them      U  blocks read      B  blocks with a bad checksum
* run-tape.js runs it in MAME on our exported WAV; tests/tape.test.js runs it on our machines.
NAMEBUF EQU     $2F00
DATABUF EQU     $3000
BYTE    EQU     $0100           ; byte being assembled
BITS    EQU     $0102           ; bits left
TYPE    EQU     $0103
LEN     EQU     $0104
SUM     EQU     $0105
DPTR    EQU     $0106           ; where data blocks go
NBLK    EQU     $0108           ; blocks read
NBAD    EQU     $010A           ; bad checksums
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
        LDA     #$82
        STA     $FF20
        LDX     #DATABUF
        STX     DPTR
        LDX     #0
        STX     NBLK
        STX     NBAD
* ---- a block: wait for sync ----
BLOCK   CLR     BYTE
SYNC    JSR     RDBIT
        ROR     BYTE            ; the bit (in C) goes in at the top
        LDA     BYTE
        CMPA    #$3C
        BNE     SYNC
        JSR     RDBYTE          ; type
        STA     TYPE
        STA     SUM
        JSR     RDBYTE          ; length
        STA     LEN
        ADDA    SUM
        STA     SUM
        LDX     #NAMEBUF        ; namefile data to NAMEBUF, data blocks to DPTR
        LDA     TYPE
        BEQ     DATA
        LDX     DPTR
DATA    LDB     LEN
        BEQ     CHECK
DLP     JSR     RDBYTE
        STA     ,X+
        ADDA    SUM
        STA     SUM
        DECB
        BNE     DLP
CHECK   LDA     TYPE            ; a data block moves the pointer on
        CMPA    #$01
        BNE     CHK2
        STX     DPTR
CHK2    JSR     RDBYTE          ; checksum
        CMPA    SUM
        BEQ     GOOD
        LDX     NBAD
        LEAX    1,X
        STX     NBAD
GOOD    LDX     NBLK
        LEAX    1,X
        STX     NBLK
        LDA     TYPE
        CMPA    #$FF
        BNE     BLOCK
* ---- end of file: report ----
        LDA     #$34            ; motor off
        STA     $FF21
        LDX     #DATABUF        ; Y = sum of the data bytes
        LDY     #0
SUMLP   CMPX    DPTR
        BEQ     SUMEND
        LDB     ,X+
        CLRA
        LEAY    D,Y
        BRA     SUMLP
SUMEND  LDD     DPTR
        SUBD    #DATABUF
        TFR     D,X
        LDU     NBLK
        LDB     NBAD+1
HALT    BRA     HALT

* read a byte, least significant bit first -> A
RDBYTE  PSHS    B
        LDB     #8
        STB     BITS
RBLP    JSR     RDBIT
        ROR     BYTE
        DEC     BITS
        BNE     RBLP
        LDA     BYTE
        PULS    B,PC

* read one bit -> C: time one cycle, rising edge to rising edge; under 37 counts (15 cycles each) is a 1
RDBIT   PSHS    A,X
        LDX     #0
RB1     LDA     $FF20           ; wait while high
        LEAX    1,X
        LSRA
        BCS     RB1
RB2     LDA     $FF20           ; then while low: the next rising edge ends the cycle
        LEAX    1,X
        LSRA
        BCC     RB2
        CMPX    #37             ; C set (a 1) when shorter
        PULS    A,X,PC

        ORG     $BFF0
        FDB     RESET,RESET,RESET,RESET,RESET,RESET,RESET,RESET
