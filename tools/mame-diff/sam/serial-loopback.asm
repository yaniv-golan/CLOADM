* CoCo bit-banger serial port in loopback (tools/mame-diff, written for CLOADM; run.js <coco> --serial, MAME
* -rs232 loopback: RXD follows TXD, rs232/loopback.cpp).
*
* Sends each byte of DATA as an 8N1 frame on TXD (PIA1 PA1) and, after every bit, reads RXD (PIA1 PB0, the serial
* input) back; the bits read rebuild a byte, stored at $7100 + n. It also records PIA1 port B and PIA1's control
* register A (CA1 is the port's carrier detect) before and after, so the lockstep comparison sees every input
* the port gives. $7000 = $FF when done; $7001 = number of bytes that came back different (0 expected).
DONE    EQU     $7000
BAD     EQU     $7001
RXB     EQU     $7002           ; the byte being read back
OUT     EQU     $7100
        ORG     $8000
RESET   ORCC    #$50
        LDS     #$7F00
        CLR     DONE
        CLR     BAD
        ; PIA1 port A: TXD at mark before PA1 becomes an output
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
        ; PIA1 port B: PB0-PB2 inputs, PB3-PB7 outputs (the VDG lines), as BASIC sets it
        LDA     #$30
        STA     $FF23
        LDA     #$F8
        STA     $FF22
        LDA     #$34
        STA     $FF23
        LDU     #OUT
        LDA     $FF22           ; idle: RXD at mark
        STA     ,U+
        LDA     $FF21           ; carrier detect (CA1) flag
        STA     ,U+
        LDX     #DATA
NEXT    CMPX    #DATAEND
        BEQ     FIN
        LDA     ,X+
        PSHS    X
        BSR     XCHG
        PULS    X
        STB     ,U+
        CMPB    -1,X
        BEQ     NEXT
        INC     BAD
        BRA     NEXT
FIN     LDA     $FF22
        STA     ,U+
        LDA     $FF21
        STA     ,U+
        LDA     #$FF
        STA     DONE
HALT    BRA     HALT

* send A as a frame; B = the data bits read back from RXD
XCHG    CLR     RXB
        CLRB                    ; start bit
        STB     $FF20
        BSR     DELAY
        LDY     #8
BIT     LDB     #$00
        LSRA
        BCC     ZERO
        LDB     #$02
ZERO    STB     $FF20           ; data bit out
        LDB     $FF22           ; and read back (PB0)
        LSRB                    ; into C
        ROR     RXB
        BSR     DELAY
        LEAY    -1,Y
        BNE     BIT
        LDB     #$02            ; stop bit
        STB     $FF20
        BSR     DELAY
        LDB     RXB             ; the byte read back
        RTS

DELAY   LDX     #40
D1      LEAX    -1,X
        BNE     D1
        RTS

DATA    FCB     $00,$FF,$55,$AA,$01,$80,$3C,$C3,$4C,$6F,$6F,$70,$21
DATAEND FCB     0               ; (not sent)
        ORG     $BFF2
        FDB     RESET,RESET,RESET,RESET,RESET,RESET,RESET
        END     RESET
