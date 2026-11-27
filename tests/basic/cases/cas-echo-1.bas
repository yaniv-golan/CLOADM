# bb-only: when a line typed over a cassette read shows twice, built from cas-ascii-save's own steps (docs/
# clean-room-basic.md section 12; open after bb10 cas-ascii-save, whose screen before its first NEW held a line at two
# rows). The cause is NOT known: that program prints only LEN [..] and ASC and END <name>, never the typed text, so a
# second copy is not its output. Each variant is standalone, and differs only in what is on the screen before the typed
# line, so which variant shows two copies says which part of the sequence it depends on. Variant 1 of 4: the Z save and
# the Z read only, with nothing typed before it (the shortest form the sequence takes). Each ends with CLS, whose
# pre-clear screen the harness keeps in `clears`. No memory is read or written. Syntax [UM]; the screens [BB].
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
A$="Z":GOTO 10
CLS
