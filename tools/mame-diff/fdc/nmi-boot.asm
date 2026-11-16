* nmi-boot.asm: our own code, in place of the BASIC ROM, for nmi.asm (run.js dragon64 --fdc --nmi). Unlike
* boot.asm it never loads S, so the 6809 starts with NMI disarmed.
        ORG     $8000
RESET   JMP     $C000
        ORG     $BFF2
        FDB     $C009,$C009,$C006,$C009,$C009,$C003,RESET
