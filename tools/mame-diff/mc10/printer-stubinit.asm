; MC-10 serial printer diagnostic, set up as CLOADM's no-ROM stub (tools/mame-diff, written for CLOADM;
; run.js mc10 --printer --stub-init; alice too). The same print as printer.asm, after the ports are set up in the
; stub's order (js/machines/mc10.js stubInit). With the stub's old order (port 2's DDR before its data register)
; P20 drove 0 for a moment and CLOADM's printer took the drop for a start bit: here its first byte came out $7F, not
; the $00 sent (and a stub left idle printed one $FF), while MAME 0.264 printed the 306 bytes as sent. In this order
; both print exactly the 306 bytes sent, identical, nothing before them.
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
        ; ports set up as CLOADM's no-ROM stub sets them up (js/machines/mc10.js stubInit): port 1 all high,
        ; then port 2's data register (mark) before its DDR makes P20 an output
        LDAA    #$FF
        STAA    $00
        STAA    $02
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
