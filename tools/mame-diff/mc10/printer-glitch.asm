; MC-10 serial printer glitch diagnostic (tools/mame-diff, written for CLOADM; run.js mc10|alice --printer --glitch).
; MAME 0.264 records 307 bytes from it: one $FF (the glitch of step 2), then every byte value 0-255 and the text.
; Step 1 sets port 2 up DDR first; MAME's m6801 drives port 2 only once its data register has been written, so that
; order prints nothing (CLOADM printed a stray byte there, until its 6803 did the same: js/cpu/cpu6803.js
; resetPeripherals). tests/stub-printer.test.js checks CLOADM's bytes against MAME's record.
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
        ; 1. port 2's DDR before its data register (the order CLOADM's no-ROM stub had): the data register has not
        ;    been written, so the port drives nothing yet (MAME m6801.cpp write_port2, !m_port2_written) and the
        ;    printer sees no start bit
        LDAA    #$01
        STAA    $01
        STAA    $03
        LDX     #6000           ; a few character times at mark
IDLE    DEX
        BNE     IDLE
        ; 2. a glitch: P20 low for 11 cycles, once the port is driven. MAME's receiver (diserial.cpp) takes any
        ;    drop for a start bit, samples mark after it, and prints $FF; so does CLOADM's
        CLR     $03
        NOP
        STAA    $03
        LDX     #6000           ; that character's time, and more, at mark
IDLE2   DEX
        BNE     IDLE2
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
