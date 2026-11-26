# bb-only: cassette data files (docs/clean-room-basic.md section 12; ours matches this case's record but for the
# leaders and motor timings): OPEN "O",#-1,"NAME", PRINT #-1 with strings, numbers, ; and , and CLOSE #-1 onto a
# blank tape, with the blocks that writes (the data's hash) and the motor's runs; the tape rewound, then OPEN "I",
# #-1,"NAME", INPUT #-1 in a loop until EOF(-1), and INPUT #-1 once more past the end; LINE INPUT #-1; the forms a
# magazine listing uses, without the # (OPEN "I",-1,"" for the first file, EOF(-1), CLOSE -1); reading the data file
# of the fixture data-file (our own); and PRINT #-1 and INPUT #-1 with no file open. WRITE is not a keyword of this
# BASIC (the manual has none), so it is not here. Syntax [UM, a magazine listing for the forms without #]; the
# answers and the blocks [BB].
#timeout 120
#tape-blank
10 OPEN "O",#-1,"F"
20 PRINT #-1,"HELLO";42
30 PRINT #-1,"A,B","C"
40 FOR I=1 TO 3:PRINT #-1,I*I:NEXT
50 PRINT #-1,"LAST LINE"
60 CLOSE #-1
70 PRINT "WRITTEN"
RUN
#tape-blocks written
#tape-rewind
NEW
10 OPEN "I",#-1,"F"
20 IF EOF(-1) THEN 50
30 INPUT #-1,A$:PRINT "<";A$;">"
40 GOTO 20
50 PRINT "END OF FILE"
60 INPUT #-1,A$
RUN
CLOSE #-1
#tape-rewind
NEW
10 OPEN "I",-1,""
20 IF EOF(-1) THEN 50
30 LINE INPUT #-1,L$:PRINT "[";L$;"]"
40 GOTO 20
50 CLOSE -1
60 PRINT "DONE"
RUN
#tape data-file
NEW
10 OPEN "I",#-1,"DATA"
20 IF EOF(-1) THEN 50
30 INPUT #-1,A$:PRINT A$
40 GOTO 20
50 CLOSE #-1
RUN
PRINT #-1,1
INPUT #-1,A
