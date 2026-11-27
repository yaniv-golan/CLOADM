# bb-only: when a line typed over a cassette read shows twice, built from cas-ascii-save's own steps (docs/
# clean-room-basic.md section 12; open after bb10 cas-ascii-save, whose screen before its first NEW held a line at two
# rows). The cause is NOT known: that program prints only LEN [..] and ASC and END <name>, never the typed text, so a
# second copy is not its output. Variant 2 of 4: the Z read typed straight after a CLS, so the screen is empty when the
# line goes in (variant 1 leaves the save's own output on screen). Each ends with CLS, whose pre-clear screen the
# harness keeps in `clears`. No memory is read or written. Syntax [UM]; the screens [BB].
#timeout 120
#tape-blank
NEW
CSAVE "Z",A
#tape-rewind
NEW
10 OPEN "I",#-1,A$
20 IF EOF(-1) THEN 50
30 LINE INPUT #-1,L$:PRINT LEN(L$);"[";L$;"]";:IF LEN(L$) THEN PRINT ASC(L$) ELSE PRINT
40 GOTO 20
50 CLOSE #-1:PRINT "END ";A$
CLS
A$="Z":GOTO 10
CLS
