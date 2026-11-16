* pager.asm: our own 8K boot ROM for the Dragon Alpha comparisons (in place of alpha_bt_10.rom).
* The Alpha starts in the boot ROM bank. This closes the disk NMI gate (PIA2 CA2 low: after reset the WD2797's
* restore with no drive selected ends after 255 steps and would raise NMI), pages the BASIC bank in through PIA2 (DDRB bit 2 set, then a
* DDRA write that leaves PA2 low) from a few bytes copied to RAM, and jumps through the BASIC bank's reset
* vector, so the 16K firmware in the BASIC socket starts as it would on a Dragon 64.
        ORG     $A000
RESET   ORCC    #$50
        LDA     #$30
        STA     $FF25           ; PIA2 CRA: CA2 output, low: the disk interface's NMI stays off
        LDA     #$04
        STA     $FF26      ; PIA2 DDRB = $04 (CRB = 0 after reset)
        LDX     #TAIL
        LDU     #$7000
COPY    LDB     ,X+
        STB     ,U+
        CMPX    #TEND
        BNE     COPY
        JMP     $7000
TAIL    STA     $FF24      ; PIA2 DDRA = $04: port A $FB, PA2 low: the BASIC bank
        JMP     [$BFFE]
TEND    EQU     *
        ORG     $BFF2
        FDB     RESET,RESET,RESET,RESET,RESET,RESET,RESET
