* head.asm (INCLUDEd at the start of every cartridge firmware, at $C000): the jump table that boot.asm's
* vectors use, interrupt handlers that count into RAM, and the copy of the firmware's RAM code to $1000 (it runs
* from RAM so that it can switch banks and slots). spec.js places the bytes assembled at $1000 at RAMSRC in the
* ROM image; the including file ends its RAM code with the label RAMEND.
NCOUNT  EQU     $0100           ; NMIs taken
FCOUNT  EQU     $0101           ; FIRQs taken
ICOUNT  EQU     $0102           ; IRQs taken
RAMSRC  EQU     $C800
MACH    EQU     $BFF0           ; in the boot ROM: 3 on a CoCo 3, else 0 (boot.asm, boot3.asm)
        ORG     $C000
        JMP     START
        JMP     NMIH
        JMP     FIRQH
        JMP     IRQH
NMIH    INC     NCOUNT
        RTI
IRQH    INC     ICOUNT
        LDA     $FF02           ; clear PIA0's flags
        LDA     $FF00
        RTI
FIRQH   INC     FCOUNT
        LDA     $FF22           ; clear PIA1's flags (CB1 is CART)
        LDA     $FF20
        RTI
START   LDS     #$7F00
        CLR     $FF21           ; PIA1: every port line an output (the tests read back what they wrote,
        CLR     $FF23           ; never an input pin), outputs 0, then the data registers at $FF20/$FF22
        LDA     #$FF            ; (reading them clears the flags)
        STA     $FF20
        STA     $FF22
        LDA     #$04
        STA     $FF21
        STA     $FF23
        CLR     $FF20
        CLR     $FF22
        CLR     NCOUNT
        CLR     FCOUNT
        CLR     ICOUNT
        LDX     #RAMSRC
        LDU     #$1000
CPY     LDA     ,X+
        STA     ,U+
        CMPU    #RAMEND
        BNE     CPY
        JMP     $1000
