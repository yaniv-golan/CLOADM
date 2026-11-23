* CoCo serial printer glitch diagnostic (tools/mame-diff, written for CLOADM; run.js <coco> --printer --glitch).
* MAME 0.264 records 307 bytes from it: one $FF (a PA1 glitch of a few cycles once the line idles at mark), then
* every byte value 0-255 and the text. tests/stub-printer.test.js checks CLOADM's bytes against that record.
*
* Prints every byte value 0-255 and then a line of text through the bit-banger (PIA1 PA1, RS-232 out) at
* 600 baud, 8 data bits, no parity, 1 stop bit - the serial printer MAME fits by default (coco12.cpp
* rs_printer) - as BASIC's printer routine does: start bit (space, 0), the data bits least significant first,
* stop bit (mark, 1), with the line held at mark between characters. One bit is 894886 / 600 = 1491.5 CPU
* cycles. Measured in our emulator from one BITT call to the next: data bits 1491 and 1493 cycles, the start
* bit 1486, the stop bit 1521 (with the step to the next character); a character drifts by under 60 cycles,
* far inside the half bit (746 cycles) the receiver allows. $7000 counts the bytes sent;
* $7001 = $FF once the firmware is done.
STAT    EQU     $7000
DONE    EQU     $7001
DELAY   EQU     182             ; 182 x 8 cycles (LEAX, BNE); see the measured bit times above
        ORG     $8000
RESET   ORCC    #$50
        LDS     #$7F00
        CLR     STAT
        CLR     DONE
        ; PIA1 port A: PA1-PA7 outputs, PA0 input (cassette). The output register gets mark (PA1 high) before
        ; the DDR makes PA1 an output, so the line never drops to space (which a receiver would take for a
        ; start bit)
        LDA     #$34
        STA     $FF21
        LDA     #$02
        STA     $FF20
        LDA     #$30
        STA     $FF21
        LDA     #$FE
        STA     $FF20
        LDA     #$34
        STA     $FF21
        LDX     #4500           ; a few character times at mark first
IDLE    LEAX    -1,X
        BNE     IDLE
        ; a glitch: PA1 low for one instruction (DAC mid, PA1 = space), then mark again. MAME's receiver
        ; (diserial.cpp) takes any drop for a start bit, samples mark after it, and prints $FF; so does CLOADM's
        LDA     #$FC
        STA     $FF20
        LDA     #$FE
        STA     $FF20
        LDX     #4500           ; that character's time, and more, at mark
IDLE2   LEAX    -1,X
        BNE     IDLE2
        ; every byte value
        CLRA
ALL     BSR     SEND
        INCA
        BNE     ALL
        ; and a line of text
        LDX     #TEXT
TXT     LDA     ,X+
        BEQ     FIN
        PSHS    X
        BSR     SEND
        PULS    X
        BRA     TXT
FIN     LDA     #$FF
        STA     DONE
HALT    BRA     HALT

* send A: start bit, eight data bits, stop bit (A is kept)
SEND    PSHS    A,B,X,Y
        CLRB                    ; start bit: space
        BSR     BITT
        LDA     ,S
        LDY     #8
DATA    CLRB
        LSRA
        BCC     ZERO
        LDB     #$02
ZERO    BSR     BITT
        LEAY    -1,Y
        BNE     DATA
        LDB     #$02            ; stop bit: mark
        BSR     BITT
        INC     STAT
        PULS    A,B,X,Y,PC

* put B (the line in bit 1) on PIA1 PA and wait out the bit
BITT    STB     $FF20
        LDX     #DELAY
WAIT    LEAX    -1,X
        BNE     WAIT
        RTS

TEXT    FCC     "CLOADM PRINTER TEST, COCO SERIAL PORT, 600 BAUD"
        FCB     13,10,0
        ORG     $BFF2
        FDB     RESET,RESET,RESET,RESET,RESET,RESET,RESET
        END     RESET
