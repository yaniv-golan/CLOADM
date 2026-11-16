* Dragon 64 6551 ACIA diagnostic (tools/mame-diff, written for CLOADM; run.js dragon64 --serial, MAME -rs232
* loopback: RXD follows TXD).
*
* The ACIA is at $FF04 (data), $FF05 (status / programmed reset), $FF06 (command), $FF07 (control). Every poll loop
* counts its passes in Y, so the lockstep comparison checks when each status bit changes, to the cycle, not just
* what the registers hold. Covered: the registers after reset; a programmed reset; transmit and receive through the
* loopback at several rates and word formats (7 and 8 bits, odd and even parity, two stop bits); the receive and
* transmit interrupts, taken with CWAI; overrun; a break (framing error); DTR off (the clock stops). Results go to
* $7100 on; every byte read back in the configuration loop also goes to $7400 on, and the status seen by each
* interrupt to $7300 on. $7000 = $FF when done.
DONE    EQU     $7000
RXP     EQU     $7002           ; next byte of the read-back list
IRQN    EQU     $7004           ; interrupts taken
RXLOG   EQU     $7400
IRQLOG  EQU     $7300
DATA    EQU     $FF04
STAT    EQU     $FF05
CMD     EQU     $FF06
CTRL    EQU     $FF07
        ORG     $8000
RESET   ORCC    #$50
        LDS     #$7F00
        CLR     DONE
        CLR     IRQN
        LDX     #RXLOG
        STX     RXP
        LDU     #$7100
        ; after reset
        LDA     STAT
        STA     ,U+
        LDA     CMD
        STA     ,U+
        LDA     CTRL
        STA     ,U+
        LDA     DATA
        STA     ,U+
        ; programmed reset (any value to the status register)
        LDA     #$1F
        STA     CMD
        STA     STAT
        LDA     STAT
        STA     ,U+
        LDA     CMD
        STA     ,U+
        ; each configuration: control, command, then bytes sent and read back
        LDX     #CFGS
NEXTC   LDA     ,X+
        BEQ     IRQS
        STA     CTRL
        LDA     ,X+
        STA     CMD
        LDB     ,X+             ; byte count
        PSHS    B
SEND    LDA     ,X+
        LBSR    XFER
        DEC     ,S
        BNE     SEND
        LEAS    1,S
        LDA     STAT
        STA     ,U+
        BRA     NEXTC

* the interrupts: 9600 baud 8N1, receiver interrupt on, transmitter interrupt off ($09); then the transmitter
* interrupt on as well ($05). The CPU waits in CWAI; the handler records the status.
IRQS    LDA     #$1E
        STA     CTRL
        LDA     #$09
        STA     CMD
        LDA     STAT            ; clear anything pending
        LDA     DATA
        LDA     #$5A
        STA     DATA
        CWAI    #$EF            ; IRQ on: wait for the receiver
        LDA     DATA
        STA     ,U+
        LDA     #$05
        STA     CMD             ; transmitter interrupt too
        LDA     #$A5
        STA     DATA
        CWAI    #$EF            ; the transmitter takes the byte: TDRE
        CWAI    #$EF            ; the receiver: RDRF
        LDA     DATA
        STA     ,U+
        ORCC    #$10
        ; overrun: two bytes back to back, read only at the end
        LDA     #$0B
        STA     CMD
        LDA     #$11
        LBSR    PUTC
        LDA     #$22
        LBSR    PUTC
        LDY     #0
OV      LEAY    1,Y
        CMPY    #3000
        BNE     OV
        LDA     STAT
        STA     ,U+
        LDA     DATA
        STA     ,U+
        LDA     STAT
        STA     ,U+
        ; a break: transmitter control 11 holds TXD at space; the receiver sees a frame of zeros, no stop bit
        LDA     #$0F
        STA     CMD
        LDY     #0
BR      LEAY    1,Y
        CMPY    #400
        BNE     BR
        LDA     #$0B
        STA     CMD
        LDY     #0
BR2     LEAY    1,Y
        LDA     STAT
        BITA    #$08
        BNE     BR3
        CMPY    #2000
        BNE     BR2
BR3     STA     ,U+
        STY     ,U++
        LDA     DATA
        STA     ,U+
        ; DTR off: the clock stops; a byte written stays in the data register
        CLR     CMD
        LDA     #$77
        STA     DATA
        LDY     #0
DT      LEAY    1,Y
        CMPY    #2000
        BNE     DT
        LDA     STAT
        STA     ,U+
        LDA     #$0B
        STA     CMD             ; DTR on again: it goes out
        LBSR    GETC
        STA     ,U+
        LDA     #$FF
        STA     DONE
HALT    BRA     HALT

* send A and read it back through the loopback; the byte and the passes of both polls go to U
XFER    BSR     PUTC
        LBSR    GETC
        STA     ,U+
        PSHS    X
        LDX     RXP
        STA     ,X+
        STX     RXP
        PULS    X,PC
* wait for TDRE, counting passes, then write A
PUTC    LDY     #0
P1      LEAY    1,Y
        LDB     STAT
        BITB    #$10
        BEQ     P1
        STY     ,U++
        STA     DATA
        RTS
* wait for RDRF, counting passes, then read the byte into A
GETC    LDY     #0
G1      LEAY    1,Y
        LDB     STAT
        BITB    #$08
        BEQ     G1
        STY     ,U++
        STB     ,U+
        LDA     DATA
        RTS

* (CWAI stacked every register, so the handler logs through memory: RTI restores them)
IRQH    LDA     STAT            ; status (reading it clears the interrupt)
        LDX     #IRQLOG
        LDB     IRQN
        ABX
        STA     ,X
        INC     IRQN
        RTI

* control (rate, word length, stop bits; bit 4: internal clock), command (DTR, no receiver interrupt,
* transmitter on, parity), count, bytes
CFGS    FCB     $1E,$0B,4,$00,$FF,$55,$AA     ; 9600 baud, 8N1
        FCB     $18,$0B,2,$3C,$C3             ; 1200 baud, 8N1
        FCB     $1F,$0B,2,$01,$80             ; 19200 baud, 8N1
        FCB     $3E,$2B,3,$41,$7F,$00         ; 9600 baud, 7 bits, odd parity
        FCB     $3E,$6B,2,$42,$15             ; 9600 baud, 7 bits, even parity
        FCB     $9E,$0B,2,$99,$66             ; 9600 baud, 8 bits, 2 stop bits
        FCB     $1E,$EB,2,$12,$34             ; 9600 baud, 8 bits, space parity
        FCB     $1E,$2B,2,$03,$00             ; 9600 baud, 8 bits, odd parity (parity bit 1: the 9th bit received)
        FCB     $1E,$AB,1,$5A                 ; 9600 baud, 8 bits, mark parity
        FCB     0
        ORG     $BFF2
        FDB     RESET,RESET,RESET,IRQH,RESET,RESET,RESET   ; SWI3 SWI2 FIRQ IRQ SWI NMI RESET
        END     RESET
