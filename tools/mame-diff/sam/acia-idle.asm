* Dragon 64 6551 ACIA with nothing in the serial port (tools/mame-diff, written for CLOADM; run.js dragon64
* --serial-idle, MAME with no -rs232 device, as the machine is fitted by default). The handshake inputs are then
* idle: CTS, DSR and DCD high (not asserted), so the status register has DSR and DCD set and the transmitter data
* register empty bit masked by CTS (it never reads 1, and a byte written never goes out).
*
* The ACIA is at $FF04 (data), $FF05 (status / programmed reset), $FF06 (command), $FF07 (control). Covered:
* every register after reset and a while later; the status after each of a control and a command write; an attempt
* to transmit (status and the passes of its poll, so the lockstep comparison checks the cycle each bit would change
* at); the transmitter and the receiver interrupt enabled in turn (status bit 7, read twice, the second read after
* the first would have cleared it); DTR off and on; a programmed reset. Results go to $7100 on; $7000 = $FF when
* done. Interrupts stay masked (nothing arrives to wait for).
DONE    EQU     $7000
DATA    EQU     $FF04
STAT    EQU     $FF05
CMD     EQU     $FF06
CTRL    EQU     $FF07
        ORG     $8000
RESET   ORCC    #$50
        LDS     #$7F00
        CLR     DONE
        LDU     #$7100
        ; after reset, nothing plugged in
        LDA     STAT
        STA     ,U+
        LDA     CMD
        STA     ,U+
        LDA     CTRL
        STA     ,U+
        LDA     DATA
        STA     ,U+
        ; a while later: the idle inputs are sampled again
        LDY     #0
WAIT    LEAY    1,Y
        CMPY    #4000
        BNE     WAIT
        LDA     STAT
        STA     ,U+
        ; control, then command: the status after each
        LDA     #$1E            ; 9600 baud, 8N1, internal clock
        STA     CTRL
        LDA     STAT
        STA     ,U+
        LDA     #$0B            ; DTR on, receiver interrupt off, transmitter on
        STA     CMD
        LDA     STAT
        STA     ,U+
        ; try to send a byte: poll the transmitter data register empty bit, counting passes
        LDA     #$55
        STA     DATA
        LDY     #0
TX      LEAY    1,Y
        LDA     STAT
        BITA    #$10
        BNE     TXDONE
        CMPY    #3000
        BNE     TX
TXDONE  STA     ,U+
        STY     ,U++
        LDA     DATA            ; the byte read back from the data register
        STA     ,U+
        ; transmitter interrupt enabled (RTS low): the IRQ bit, read twice
        LDA     #$05
        STA     CMD
        LDA     STAT
        STA     ,U+
        LDA     STAT
        STA     ,U+
        ; receiver interrupt enabled
        LDA     #$01
        STA     CMD
        LDA     STAT
        STA     ,U+
        LDA     STAT
        STA     ,U+
        LDA     CMD
        STA     ,U+
        ; DTR off, then on again
        CLR     CMD
        LDA     STAT
        STA     ,U+
        LDA     #$01
        STA     CMD
        LDA     STAT
        STA     ,U+
        ; a programmed reset (any value to the status register)
        LDA     #$1F
        STA     CMD
        STA     STAT
        LDA     STAT
        STA     ,U+
        LDA     CMD
        STA     ,U+
        LDA     CTRL
        STA     ,U+
        LDA     #$FF
        STA     DONE
HALT    BRA     HALT
        ORG     $BFF2
        FDB     RESET,RESET,RESET,RESET,RESET,RESET,RESET   ; SWI3 SWI2 FIRQ IRQ SWI NMI RESET
        END     RESET
