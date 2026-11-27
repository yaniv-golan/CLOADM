# bb-only: when a line typed over a cassette read shows twice, built from cas-ascii-save's own steps (docs/
# clean-room-basic.md section 12; open after bb10 cas-ascii-save, whose screen before its first NEW held a line at two
# rows). The cause is NOT known: that program prints only LEN [..] and ASC and END <name>, never the typed text, so a
# second copy is not its output. Variant 4 of 4: the original's full sequence exactly as cas-ascii-save runs it, up to
# and including the Z line, then CLS at once with nothing typed after: this is the step that produced the two copies in
# the bb10 record, so it should reproduce them, and the three variants before it say what it depends on.
# No memory is read or written. Syntax [UM]; the screens [BB].
# On OURS this stops at the X read (it never returns to OK there, so the Z step below is not reached);
# the variant exists to run on the real ROM, where the whole sequence is the point.
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
NEW
10 OPEN "I",#-1,A$
20 IF EOF(-1) THEN 50
30 LINE INPUT #-1,L$:PRINT LEN(L$);"[";L$;"]";:IF LEN(L$) THEN PRINT ASC(L$) ELSE PRINT
40 GOTO 20
50 CLOSE #-1:PRINT "END ";A$
A$="Y":GOTO 10
#tape-rewind
NEW
10 OPEN "I",#-1,A$
20 IF EOF(-1) THEN 50
30 LINE INPUT #-1,L$:PRINT LEN(L$);"[";L$;"]";:IF LEN(L$) THEN PRINT ASC(L$) ELSE PRINT
40 GOTO 20
50 CLOSE #-1:PRINT "END ";A$
A$="Z":GOTO 10
CLS
