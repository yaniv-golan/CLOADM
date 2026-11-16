* pia1b.asm: our own firmware, in place of the BASIC ROMs, for PIA1 port B's inputs on the CoCo 1/2 and its clones
* (run.js <profile> --pia1b); the reads are in pia1b-body.asm. Ends in its HALT loop.
        ORG     $8000
RESET   ORCC    #$50
        LDS     #$0F00          ; inside the smallest RAM option (4K): the run covers 4K, 16K and 32K too
        JSR     PIA1B
HALT    BRA     HALT
        INCLUDE "pia1b-body.asm"
        ORG     $BFF2
        FDB     RESET,RESET,RESET,RESET,RESET,RESET,RESET
