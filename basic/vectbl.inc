* The published indirect calls, $A000-$A00D: a word each, the address of a routine [DOC: Dragon Data Ltd, "Dragon 32
* Information for Machine Code Users!", March 1983, printed pages 4-5]. Ours where it does what the page says, the
* rest $FFFF. tools/build-basic.js includes this between two routines, before the one that starts at $A000 (nothing
* runs on into it: an RTS, a BRA, a JMP... comes before it), so it costs no byte and that routine goes on at $A00E;
* the build fails if no routine starts there. A mutant's build (tests only) may put it lower, the gap up to $A000
* left $FF, or go without it.
        ORG     $A000
VECTBL  FDB     KEYIN           ; $A000 the keyboard polled, as $8006 [DOC p.5]
        RMB     2               ; $A002 (not published)
        RMB     2               ; $A004 made ready for reading, in bit sync, as $8021 [DOC p.4]: inside CRBLK here
        RMB     2               ; $A006 a block read to the address at $7E, Z set if its checksum is right [DOC p.4]:
*                                 CRBLK reads to X
        RMB     2               ; $A008 a block written [DOC p.4]: CWBLK takes its own RAM
        RMB     2               ; $A00A (not published)
        RMB     2               ; $A00C made ready for writing, as $801B [DOC p.4]: inside CWBLK here
        ORG     $A00E
