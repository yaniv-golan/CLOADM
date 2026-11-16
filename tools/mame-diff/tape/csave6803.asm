* Cassette writer diagnostic for the MC-10 / Matra Alice (tools/mame-diff/tape, written for CLOADM).
*
* Writes a tape the way the MC-10's BASIC does, installed in place of the BASIC ROM: the cassette output is
* P20 (port 2, bit 0) and there is no motor relay, so the writer only ever toggles P20. Each bit is one cycle
* of a square wave at 1200 Hz (0) or 2400 Hz (1), least significant bit first; blocks are a leader of $55
* bytes, $3C, type, length, data and a checksum (the sum of type, length and data), then one $55. It writes a
* namefile block, a 255-byte data block (byte i = 11 + 37 i) and an end-of-file block, then stops in HALT.
*
* The CPU is a 6803 at 0.895 MHz (3.579545 MHz / 4): one cycle of a bit is 746 CPU ticks at 1200 Hz and 373
* at 2400 Hz. Each half is burnt by a countdown of N passes of a DECB/BNE loop (5 ticks a pass, and the loop's
* own overhead on top), so a bit's length is set by N and came out as HALF0 = 67 and HALF1 = 30 - measured
* from the recording (the two halves are not equal, since the second also carries the loop's tail) and
* checked by decoding: a cycle then lasts about 742 ticks at 1200 Hz and 372 at 2400. tests/tape.test.js
* requires the capture to decode to the byte stream it builds independently.
* The scalars live in the 6803's own internal RAM at $0080-$00FF, which is mapped whatever RAM the machine
* has fitted. $0400 is NOT RAM on the MC-10 (it reads back 0), and $4000+ is only RAM from 4K up, so neither
* is safe for the writer's own state.
CNT     EQU     $80             ; bits left in the byte
SUM     EQU     $81             ; block checksum
TMP     EQU     $82
        ORG     $E000
RESET   LDS     #$4FFF        ; top of the 4K the MC-10 always has (MAME's default fitting is 4K)
        CLRA
        CLR     $01             ; port 2 DDR: all inputs for now
        CLR     $03             ; port 2 data: P20 low
        CLR     $00             ; port 1 DDR: all inputs
        LDA     #$01
        STA     $01             ; DDR2: P20 an output (port 2 is $01/$03, not $00/$02)
* ---- namefile block ----
        JSR     LEADER
        LDX     #NAMEF
        LDA     #$00            ; type: namefile
        LDB     #NAMEFE-NAMEF
        JSR     BLOCK
* ---- data block: 255 bytes computed, 11 + 37 i ----
        JSR     LEADER
        LDA     #$3C
        JSR     WRBYTE
        LDA     #$01            ; type: data
        STA     SUM
        JSR     WRBYTE
        LDA     #255            ; length
        JSR     WRBYTE
        ADDA    SUM
        STA     SUM
        LDA     #11
        LDB     #255
DATLP   PSHA
        PSHB
        JSR     WRBYTE
        ADDA    SUM
        STA     SUM
        PULB
        PULA
        ADDA    #37
        DECB
        BNE     DATLP
        LDA     SUM
        JSR     WRBYTE
        LDA     #$55
        JSR     WRBYTE
* ---- end-of-file block ----
        JSR     LEADER
        LDA     #$FF            ; type: end of file, no data
        CLRB
        JSR     BLOCK
        CLR     $03
HALT    BRA     HALT

* 128 leader bytes
LEADER  PSHB
        LDB     #128
LDLP    PSHA
        PSHB
        LDA     #$55
        JSR     WRBYTE
        PULB
        PULA
        DECB
        BNE     LDLP
        PULB
        RTS

* a block: A = type, B = length, X = data; writes $3C type length data checksum $55
BLOCK   PSHA
        PSHB
        LDA     #$3C
        JSR     WRBYTE
        PULB
        PULA
        STA     SUM
        JSR     WRBYTE
        TBA
        JSR     WRBYTE
        ADDA    SUM
        STA     SUM
        TSTB
        BEQ     BLKEND
BLKLP   LDA     ,X
        INX
        JSR     WRBYTE
        ADDA    SUM
        STA     SUM
        DECB
        BNE     BLKLP
BLKEND  LDA     SUM
        JSR     WRBYTE
        LDA     #$55
        JSR     WRBYTE
        RTS

* write the byte in A, least significant bit first, by toggling P20; A is preserved
WRBYTE  PSHA
        PSHB
        PSHX
        LDB     #8
        STB     CNT
WBIT    LSRA
        PSHA
        BCC     WZERO
        LDA     HALF1           ; 1: 2400 Hz (the table holds the loop count, not its address)
        BRA     WCYC
WZERO   LDA     HALF0           ; 0: 1200 Hz
* one full cycle: P20 toggles, wait, toggle back, wait. A holds the count; WAITX burns it in B so A survives.
WCYC    STA     TMP             ; the count for the second half
        LDB     TMP
        LDA     $03
        EORA    #$01
        STA     $03
        JSR     WAITB
        LDB     TMP
        LDA     $03
        EORA    #$01
        STA     $03
        JSR     WAITB
        PULA
        DEC     CNT
        BNE     WBIT
        PULX
        PULB
        PULA
        RTS

* wait B loop passes (DECB/BNE is 4 cycles a pass)
WAITB   DECB
        BNE     WAITB
        RTS

        ORG     $E100
* 746 ticks a bit at 1200 Hz and 373 at 2400, as 10N + 72 (see the header for the count)
HALF0   FCB     67
HALF1   FCB     30
* namefile: name, type 2 (machine code), not ASCII, no gaps, exec $3000, load $3000
NAMEF   FCC     "CLOADM  "
        FCB     $02,$00,$00,$30,$00,$30,$00
NAMEFE

        ORG     $FFF2
        FDB     RESET,RESET,RESET,RESET,RESET,RESET
        ORG     $FFFE
        FDB     RESET
        END     RESET
