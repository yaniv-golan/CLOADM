* pia1b.asm: our own firmware for PIA1 port B's inputs on the Dragon Alpha (run.js dgnalpha --pia1b); the reads are
* in ../sam/pia1b-body.asm. PIA1 PB2, when an output, pages between the boot ROM and BASIC (dragon64_state::
* pia1_pb_changed, page_rom), and the body sets it both ways; so this runs at $A000-$BFFF, the only part of the
* boot bank that holds ROM, and spec.js puts the same 8K in the boot socket and in the BASIC socket's upper half.
* Ends in its HALT loop.
        ORG     $A000
RESET   ORCC    #$50
        LDS     #$7F00
        JSR     PIA1B
HALT    BRA     HALT
        INCLUDE "../sam/pia1b-body.asm"
        ORG     $BFF2
        FDB     RESET,RESET,RESET,RESET,RESET,RESET,RESET
