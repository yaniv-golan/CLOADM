# bb-only: when a line typed over a cassette read shows twice, built from cas-ascii-save's own steps (docs/
# clean-room-basic.md section 12; open after bb10 cas-ascii-save, whose screen before its first NEW held a line at two
# rows). The cause is NOT known: that program prints only LEN [..] and ASC and END <name>, never the typed text, so a
# second copy is not its output. Variant 3 of 4: X, Y and Z as in the original, but with a CLS before the Z line, so
# Z is typed on an empty screen while X and Y were typed over the earlier reads. Each ends with CLS, whose pre-clear
# screen the harness keeps in `clears`. No memory is read or written. Syntax [UM]; the screens [BB].
# This variant needs the X read, and ours never returns to OK there (it
# times out at the A$="X" line), so on ours it stops there; the real ROM is where it answers.
#expect-timeout
#timeout 180
#tape-blank
NEW
10 PRINT "HI"
20 GOTO 10
CSAVE "X",A
NEW
10 END
CSAVE "Y",A
NEW
CSAVE "Z",A
NEW
10 OPEN "I",#-1,A$
20 IF EOF(-1) THEN 50
30 LINE INPUT #-1,L$:PRINT LEN(L$);"[";L$;"]";:IF LEN(L$) THEN PRINT ASC(L$) ELSE PRINT
40 GOTO 20
50 CLOSE #-1:PRINT "END ";A$
A$="X":GOTO 10
#tape-rewind
A$="Y":GOTO 10
#tape-rewind
CLS
A$="Z":GOTO 10
CLS
