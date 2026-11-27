# bb-only: LLIST and PRINT #-2 with the printer ready (docs/clean-room-basic.md, the printer; open after bb10
# stmt-printer, whose LLIST waited until the case's #timeout and sent nothing). #printer-ready makes PIA1 PB0, the
# printer's BUSY input (high = busy: Dragon Data, "Dragon 32 Information for Machine Code Users", March 1983, the
# $FF22 entry; 6809.org.uk, "Dragon hardware details", PIA1 B), read 0 in the harness. The record holds the bytes the
# printer received (printer, rule 2: a byte at each rise of the strobe PIA1 PA1 that leaves the DAC's bits alone):
# LLIST of a two-line program, LLIST of one line, PRINT #-2 of a string, of numbers and of a number with a ; after it.
# A step that times out (if the original still waits for something) is the result. Syntax [UM]; the bytes [BB].
#printer-ready
#timeout 10
#expect-timeout
10 PRINT "AB"
20 REM CD
LLIST
LLIST 20
PRINT #-2,"XY"
PRINT #-2,12;-3
PRINT #-2,4;
PRINT #-2
PRINT "DONE"
