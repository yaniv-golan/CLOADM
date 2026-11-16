; MC-10 serial printer diagnostic (tools/mame-diff, written for CLOADM; run.js mc10 --printer).
;
; Prints every byte value 0-255 and then a line of text through port 2 bit 0 (P20, the cassette and printer
; output) at 600 baud, 8 data bits, no parity, 1 stop bit - the serial printer MAME fits by default (mc10.cpp
; rs_printer): start bit (space, 0), the data bits least significant first, stop bit (mark, 1), the line held
; at mark between characters. One bit is 894886 / 600 = 1491.5 CPU cycles. Measured in our emulator from one
; BITT call to the next: data bits 1492-1497 cycles, the start bit 1486, the stop bit 1512 (with the step to the
; next character): far inside the half bit (746 cycles) the receiver allows. $4F00 counts the bytes sent; $4F01
; = $FF once the firmware is done.
STAT    EQU     $4F00
DONE    EQU     $4F01
CH      EQU     $4F02
CNT     EQU     $4F03
DELAY   EQU     243             ; 243 x 6 cycles (DEX, BNE)
        ORG     $E000
RESET   SEI
        LDS     #$4EFF
        CLR     STAT
        CLR     DONE
        ; port 2: the data register gets mark (P20 high) before the DDR makes P20 an output
        LDAA    #$01
        STAA    $03
        STAA    $01
        LDX     #2000           ; a few character times at mark first
IDLE    DEX
        BNE     IDLE
        ; every byte value
        CLRA
ALL     BSR     SEND
        INCA
        BNE     ALL
        ; and a line of text
        LDX     #TEXT
TXT     LDAA    0,X
        BEQ     FIN
        BSR     SEND
        INX
        BRA     TXT
FIN     LDAA    #$FF
        STAA    DONE
HALT    BRA     HALT

; send A: start bit, eight data bits, stop bit (A and X are kept)
SEND    STAA    CH
        PSHX
        CLRB                    ; start bit: space
        BSR     BITT
        LDAB    #8
        STAB    CNT
DATA    CLRB
        LSR     CH
        BCC     ZERO
        LDAB    #$01
ZERO    BSR     BITT
        DEC     CNT
        BNE     DATA
        LDAB    #$01            ; stop bit: mark
        BSR     BITT
        INC     STAT
        PULX
        RTS

; put B (the line in bit 0) on port 2 and wait out the bit
BITT    STAB    $03
        LDX     #DELAY
WAIT    DEX
        BNE     WAIT
        RTS

TEXT    FCC     "CLOADM PRINTER TEST, MC-10 SERIAL PORT, 600 BAUD"
        FCB     13,10,0
        ORG     $FFFE
        FDB     RESET
        END     RESET
