* CoCo serial printer, started the way CLOADM's no-ROM stub starts the machine (tools/mame-diff, written for CLOADM;
* run.js <coco> --printer --stub-init): PIA1 port A set up exactly as js/machines/sam.js stubInit (and coco3.js's)
* sets it up - mark in the output register first, then the DDR, then $82 (the DAC mid, PA1 at mark) - idle there
* for a few character times, then the same print as printer-serial.asm (every byte value 0-255 and a line of text at
* 600 baud). The printer must receive nothing from that start: MAME 0.264's serial printer against ours, byte for
* byte, and nothing before the first byte sent.
* (The stub's old order - the DDR first, with 0 in the output register, then $80 - dropped the line to space; MAME
* and ours then both printed one NUL before the first byte: measured with this firmware set up that way.)
STAT    EQU     $7000
DONE    EQU     $7001
DELAY   EQU     182             ; 182 x 8 cycles (LEAX, BNE); see the measured bit times above
        ORG     $8000
RESET   ORCC    #$50
        LDS     #$7F00
        CLR     STAT
        CLR     DONE
        ; PIA1 port A as the stub sets it up: mark in the output register, then the DDR (PA1-PA7 outputs), then
        ; $82: the DAC mid and PA1 still at mark
        LDA     #$34
        STA     $FF21
        LDA     #$82
        STA     $FF20
        CLR     $FF21
        LDA     #$FE
        STA     $FF20
        LDA     #$34
        STA     $FF21
        LDA     #$82
        STA     $FF20
        LDX     #2000           ; a few character times at mark first
IDLE    LEAX    -1,X
        BNE     IDLE
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
