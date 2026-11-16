* pia1b.asm: our own firmware, in place of coco3.rom, for PIA1 port B's inputs on the CoCo 3 (run.js coco3
* --pia1b); the reads are in ../sam/pia1b-body.asm. Ends in its HALT loop.
        ORG     $8000
RESET   ORCC    #$50
        LDS     #$1F00
        JSR     PIA1B
HALT    BRA     HALT
        INCLUDE "../sam/pia1b-body.asm"
        ORG     $FFF2
        FDB     RESET,RESET,RESET,RESET,RESET,RESET,RESET
