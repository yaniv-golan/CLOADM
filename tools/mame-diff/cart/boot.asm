* boot.asm: our own code in place of the BASIC ROMs for the cartridge comparisons (tools/mame-diff/cart/spec.js).
* It starts the cartridge at $C000 with interrupts masked; the vectors point into the cartridge's jump table:
* $C000 start, $C003 NMI, $C006 FIRQ, $C009 IRQ (and the SWIs). $BFF0 holds the machine flag the firmware reads
* (head.asm MACH: 0 here, 3 in boot3.asm).
        ORG     $8000
RESET   ORCC    #$50
        LDS     #$7F00
        JMP     $C000
        ORG     $BFF0
        FCB     0
        ORG     $BFF2
        FDB     $C009,$C009,$C006,$C009,$C009,$C003,RESET
