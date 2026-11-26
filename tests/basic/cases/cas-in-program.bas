# bb-only: CLOAD and SKIPF run inside a program (docs/clean-room-basic.md section 12, open question 10), on the
# fixture three-progs (our own: ONE, TWO, THREE): SKIPF, then the rest of its line; CLOAD in a program (does the
# program go on with the statement after it, stop at OK, or run the program it loaded?); CLOAD "NAME" in a program.
# LIST after each shows what is in memory. A pause before the CLOAD keeps the lines before it on the screen for at
# least a frame, so the record's clears hold them. Syntax [UM]; what follows [BB].
#timeout 120
#tape three-progs
10 SKIPF:PRINT "AFTER SKIPF"
20 PRINT "LINE 20":FOR D=1 TO 300:NEXT
30 CLOAD:PRINT "AFTER CLOAD"
40 PRINT "LINE 40"
RUN
LIST
#tape-rewind
NEW
10 CLOAD "THREE":PRINT "AFTER CLOAD THREE"
20 PRINT "LINE 20"
RUN
LIST
