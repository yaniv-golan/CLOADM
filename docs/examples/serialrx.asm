; serialrx.asm - receive bytes on the CoCo's bit-banger serial port (PIA1 port B bit 0) at 1200 baud, 8N1, and keep
; them in RAM, for the serial-peer note in docs/automation.md. CoCo 1/2, built-in firmware (no ROMs). Written for this
; project; the delays are counted from the MC6809 cycle table at the CoCo's 894,886 Hz clock (745.7 cycles a bit).
COUNT   EQU     $31FF           ; bytes received so far
BUF     EQU     $3200           ; the bytes, in order
RXD     EQU     $FF22           ; PIA1 port B: bit 0 is the serial port's received data
        ORG     $3000
START   ORCC    #$50            ; no interrupts
        CLR     COUNT
        LDY     #BUF
WSTART  LDA     RXD             ; wait for a start bit (the line goes low)
        ANDA    #1
        BNE     WSTART
        LDX     #140            ; 1.5 bits (1120 cycles): the middle of data bit 0
D15     LEAX    -1,X
        BNE     D15
        LDB     #$80            ; a marker bit: after 8 shifts it has moved into carry
BIT     LDA     RXD             ; sample the bit (5 cycles)
        LSRA                    ; bit 0 into carry (2)
        RORB                    ; into B from the top, the first bit ending lowest (2)
        BCS     DONE            ; the marker is out: all 8 bits are in (3)
        LDX     #90             ; one bit time: 3 + 90 x 8 = 723 cycles, plus the 15 around it = 738
D1      LEAX    -1,X
        BNE     D1
        BRA     BIT
DONE    STB     ,Y+             ; keep the byte
        INC     COUNT
        LDX     #90             ; across the stop bit, then wait for the next start
D2      LEAX    -1,X
        BNE     D2
        BRA     WSTART
        END     START
