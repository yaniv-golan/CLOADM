; MC-10 serial port in loopback (tools/mame-diff, written for CLOADM; run.js mc10 --serial, MAME -rs232 loopback:
; RXD follows TXD, rs232/loopback.cpp).
;
; Sends each byte of DATA as an 8N1 frame on TXD (port 2 bit 0) and, after every bit, reads port 2 back: bit 2 is
; RXD, bit 3 the device's CTS (MAME mc10.cpp mc10_port2_r). The bits read rebuild a byte, stored at $4F10 + n;
; port 2 itself is recorded before and after, bits 0-4 (bits 5-7 read the operating mode latched at reset on the
; MC6803, 0 in MAME: a documented deviation, masked as in diag.asm). $4F00 = $FF when done; $4F01 = bytes that
; came back different.
DONE    EQU     $4F00
BAD     EQU     $4F01
RXB     EQU     $4F02
CNT     EQU     $4F03
PTR     EQU     $4F04           ; 2 bytes: where the next result goes
OUT     EQU     $4F10
        ORG     $E000
RESET   SEI
        LDS     #$4EFF
        CLR     DONE
        CLR     BAD
        ; port 2: TXD at mark before P20 becomes an output
        LDAA    #$01
        STAA    $03
        STAA    $01
        LDX     #OUT
        LDAA    #$1F            ; idle: RXD at mark (the mask first, so bits 5-7 never reach a register)
        ANDA    $03
        STAA    0,X
        INX
        STX     PTR
        LDX     #DATA
NEXT    CPX     #DATAEND
        BEQ     FIN
        LDAA    0,X
        PSHX
        BSR     XCHG
        PULX
        PSHX
        LDX     PTR
        STAB    0,X
        INX
        STX     PTR
        PULX
        CMPB    0,X
        BEQ     SAME
        INC     BAD
SAME    INX
        BRA     NEXT
FIN     LDX     PTR
        LDAA    #$1F
        ANDA    $03
        STAA    0,X
        LDAA    #$FF
        STAA    DONE
HALT    BRA     HALT

; send A as a frame; B = the data bits read back from RXD
XCHG    CLR     RXB
        CLRB                    ; start bit
        STAB    $03
        BSR     DELAY
        LDAB    #8
        STAB    CNT
BIT     CLRB
        LSRA
        BCC     ZERO
        LDAB    #$01
ZERO    STAB    $03             ; data bit out
        LDAB    #$1F            ; and read back (bits 0-4): RXD is bit 2
        ANDB    $03
        LSRB
        LSRB
        LSRB                    ; bit 2 into C
        ROR     RXB
        BSR     DELAY
        DEC     CNT
        BNE     BIT
        LDAB    #$01            ; stop bit
        STAB    $03
        BSR     DELAY
        LDAB    RXB
        RTS

DELAY   LDX     #40
D1      DEX
        BNE     D1
        RTS

DATA    FCB     $00,$FF,$55,$AA,$01,$80,$3C,$C3,$4C,$6F,$6F,$70,$21
DATAEND FCB     0               ; (not sent)
        ORG     $FFFE
        FDB     RESET
        END     RESET
