* Cassette reader diagnostic for the MC-10 / Matra Alice (tools/mame-diff/tape, written for CLOADM).
*
* Reads a tape the way the MC-10's BASIC does, installed in place of the BASIC ROM: the cassette input is
* port 2 bit 4 (port 2 data is $03 and its DDR $01 on the 6803), and there is no motor relay - the tape runs
* while the program keeps polling that input. Every cycle is timed from one rising edge to the next with a
* counting loop; short cycles are 1 and long cycles 0, least significant bit first. It slides bits into a byte
* until it holds the sync byte $3C, then reads type, length, data and checksum. It stops at the end-of-file
* block and reports, in HALT, for the comparison:
*   X  data bytes read      A:B  the 16-bit sum of them (A = low)
* and in memory for the comparison: NBLK (blocks read) at $0088 and NBAD (bad checksums) at $008A, both
* 16-bit and high byte first. The 6803 has only one 16-bit register, so the counts live in memory and are
* checked there.
* All of the reader's state is in the 6803's internal RAM ($0080-$00FF), which is mapped with any RAM fitting:
* $0400 is not RAM on the MC-10, and the machine may have only the base 4K at $4000-$4FFF.
NAMEBUF EQU     $4200           ; in the base 4K, below the stack
DATABUF EQU     $4400
BYTE    EQU     $80             ; byte being assembled
BITS    EQU     $82             ; bits left
TYPE    EQU     $83
LEN     EQU     $84
SUM     EQU     $85
DPTR    EQU     $86             ; where data blocks go (2 bytes)
NBLK    EQU     $88             ; blocks read
NBAD    EQU     $8A             ; bad checksums
SUMW    EQU     $8C             ; the 16-bit sum of the data bytes (high byte first, so ADDD/STD use it whole)
COUNT   EQU     $8E             ; the data byte count, computed from DPTR at the end
        ORG     $E000
RESET   LDS     #$4FFF        ; top of the 4K the MC-10 always has (MAME's default fitting is 4K)
        CLRA
        CLR     $01             ; port 2 DDR: all inputs, so P24 reads the cassette
        CLR     $00             ; port 1 DDR: all inputs
        CLR     BYTE
        CLR     NBLK
        CLR     NBLK+1
        CLR     NBAD
        CLR     NBAD+1
        CLR     SUMW
        CLR     SUMW+1
        LDX     #DATABUF
        STX     DPTR
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
        STA     ,X
        INX
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
        INX
        STX     NBAD
GOOD    LDX     NBLK
        INX
        STX     NBLK
        LDA     TYPE
        CMPA    #$FF
        BNE     BLOCK
* ---- end of file: report ----
        LDX     #DATABUF        ; the sum of the data bytes, 16 bits in the word at SUMW
SUMLP   CPX     DPTR
        BEQ     SUMEND
        LDB     ,X              ; D is big endian (A high), so the byte goes in B and A is cleared
        INX
        CLRA
        ADDD    SUMW            ; the word at SUMW is the running sum
        STD     SUMW
        BRA     SUMLP
SUMEND  ; report: X = the number of data bytes, and A:B = their 16-bit sum with A the low byte (the 6803's D is
        ; big endian, so the pair is read out of the word low byte first). The block count and bad checksums stay
        ; in memory for the comparison: the 6803 has no spare 16-bit register.
        LDD     DPTR
        SUBD    #DATABUF
        STD     COUNT
        LDX     COUNT
        LDA     SUMW+1          ; low byte of the sum
        LDB     SUMW            ; high byte
HALT    BRA     HALT

* read a byte, least significant bit first -> A
RDBYTE  PSHB
        LDB     #8
        STB     BITS
RBLP    JSR     RDBIT
        ROR     BYTE
        DEC     BITS
        BNE     RBLP
        LDA     BYTE
        PULB
        RTS

* read one bit -> C: time one cycle, rising edge to rising edge. A cycle of a 1 (2400 Hz, 373 CPU ticks) takes
* about 22 passes of the timing loop and a cycle of a 0 (1200 Hz, 746 ticks) about 49, so the dividing line is
* 35 passes.
RDBIT   PSHX
        LDX     #0
RBHIGH  LDA     $03             ; wait for the input to go low (end of the high half)
        ANDA    #$10
        BEQ     RBLOW
        INX
        BRA     RBHIGH
RBLOW   LDA     $03             ; then wait for it to go high again: the next rising edge ends the cycle
        ANDA    #$10
        BNE     RBDONE
        INX
        BRA     RBLOW
RBDONE  CMPX    #35             ; C set (a 1) when shorter
        PULX
        RTS

        ORG     $FFF2
        FDB     RESET,RESET,RESET,RESET,RESET,RESET
        ORG     $FFFE
        FDB     RESET
        END     RESET
