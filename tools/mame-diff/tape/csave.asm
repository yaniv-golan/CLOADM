* Cassette writer diagnostic (tools/mame-diff/tape, written for CLOADM).
*
* Writes a tape the way Color BASIC's and Dragon BASIC's CSAVEM do, installed in place of the BASIC ROM:
* the motor relay on (PIA1 CA2), each bit one sine cycle on the 6-bit DAC (PIA1 PA2-7), 2400 Hz for 1 and
* 1200 Hz for 0, least significant bit first; blocks are a leader of $55 bytes, $3C, type, length, data and a
* checksum (the sum of type, length and data), then one $55. It writes a namefile block, stops the motor for a
* moment as BASIC does, then a 255-byte data block (byte i = 11 + 37 i) and an end-of-file block, and stops in
* HALT. tests/tape.test.js builds the same byte stream independently and requires the capture to decode to it.
*
* The sine has 8 steps a cycle; the delay per step (3 or 12 loop passes) gives about 2270 and 1185 Hz on a
* 0.895 MHz CPU, about as far from nominal as BASIC's own writer.
CNT     EQU     $0100           ; bits left in the byte
SUM     EQU     $0101           ; block checksum
        ORG     $8000
RESET   ORCC    #$50
        LDS     #$7F00
        CLRA
        TFR     A,DP
        CLR     $FF21           ; PIA1 port A: DAC bits and PA1 as outputs, PA0 (cassette in) input
        LDA     #$FE
        STA     $FF20
        LDA     #$34            ; data register, CA2 low: motor off
        STA     $FF21
        LDA     #$82            ; DAC at mid level, PA1 high
        STA     $FF20
* ---- namefile block ----
        LDA     #$3C            ; motor on
        STA     $FF21
        JSR     PAUSE
        JSR     LEADER
        LDX     #NAMEF
        LDA     #$00            ; type: namefile
        LDB     #NAMEFE-NAMEF
        JSR     BLOCK
        LDA     #$34            ; motor off, a pause, motor on (as BASIC does after the namefile)
        STA     $FF21
        JSR     PAUSE
        LDA     #$3C
        STA     $FF21
        JSR     PAUSE
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
DATLP   PSHS    A,B
        JSR     WRBYTE
        ADDA    SUM
        STA     SUM
        PULS    A,B
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
        LDA     #$34            ; motor off
        STA     $FF21
HALT    BRA     HALT

* 128 leader bytes
LEADER  LDB     #128
LDLP    LDA     #$55
        JSR     WRBYTE
        DECB
        BNE     LDLP
        RTS

* a block: A = type, B = length, X = data; writes $3C type length data checksum $55
BLOCK   PSHS    A,B
        LDA     #$3C
        JSR     WRBYTE
        PULS    A,B
        STA     SUM
        JSR     WRBYTE
        TFR     B,A
        JSR     WRBYTE
        ADDA    SUM
        STA     SUM
        TSTB
        BEQ     BLKEND
BLKLP   LDA     ,X+
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

* write the byte in A, least significant bit first; A is preserved
WRBYTE  PSHS    A,B,X
        LDB     #8
        STB     CNT
WBIT    LSRA
        PSHS    A
        LDB     #12             ; 0: 1200 Hz
        BCC     WCYC
        LDB     #3              ; 1: 2400 Hz
WCYC    LDX     #SINE
WSTEP   LDA     ,X+
        STA     $FF20
        PSHS    B
WDLY    DECB
        BNE     WDLY
        PULS    B
        CMPX    #SINEE
        BNE     WSTEP
        PULS    A
        DEC     CNT
        BNE     WBIT
        PULS    A,B,X,PC

* about a third of a second
PAUSE   LDX     #20000
PSLP    LEAX    -1,X
        BNE     PSLP
        RTS

* one cycle of the sine on the DAC (bits 7-2), PA1 kept high
SINE    FCB     $82,$DA,$FE,$DA,$82,$2A,$06,$2A
SINEE
* namefile: name, type 2 (machine code), not ASCII, no gaps, exec $3000, load $3000
NAMEF   FCC     "CLOADM  "
        FCB     $02,$00,$00,$30,$00,$30,$00
NAMEFE

        ORG     $BFF0
        FDB     RESET,RESET,RESET,RESET,RESET,RESET,RESET,RESET
