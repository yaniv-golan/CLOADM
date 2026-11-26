# bb-only: cassette data files, what bb4 cas-files left open (docs/clean-room-basic.md section 12, open question 10):
# PRINT #-1 ending in ; and in , (what the tape then holds, read back with LINE INPUT #-1, and the data block's hash);
# INPUT #-1 taking several items from one record, a record with an item left over, and a bad number (what it says,
# and whether the file is still open after it: OPEN "I" from the tape's start, ?AO ERROR while it is); OPEN "I" and
# LINE INPUT #-1 on a BASIC program saved as text and on machine code (the fixture mixed, our own: the code's record
# by its length only), and on a program CSAVEd tokenised (its records' lengths only). Syntax [UM]; the answers and
# the blocks [BB].
#timeout 180
#tape-blank
10 OPEN "O",#-1,"D"
20 PRINT #-1,"1,2,3"
30 PRINT #-1,"X"
40 PRINT #-1,"Y"
50 PRINT #-1,"SEMI";
60 PRINT #-1,"COMMA",
70 PRINT #-1,"END"
80 CLOSE #-1
RUN
#tape-blocks written
#tape-rewind
NEW
10 OPEN "I",#-1,"D"
20 IF EOF(-1) THEN 50
30 LINE INPUT #-1,L$:PRINT "[";L$;"]"
40 GOTO 20
50 CLOSE #-1
RUN
#tape-rewind
NEW
10 OPEN "I",#-1,"D"
20 INPUT #-1,A,B:PRINT A;B
30 INPUT #-1,C$:PRINT "<";C$;">"
40 INPUT #-1,D:PRINT D
50 PRINT "AFTER"
RUN
#tape-rewind
OPEN "I",#-1,"D"
CLOSE #-1
#tape mixed
NEW
10 OPEN "I",#-1,"PROG"
20 LINE INPUT #-1,L$:PRINT "[";L$;"]";EOF(-1)
30 CLOSE #-1
RUN
CLOSE #-1
#tape-rewind
NEW
10 OPEN "I",#-1,"CODE"
20 LINE INPUT #-1,L$:PRINT LEN(L$);EOF(-1)
30 CLOSE #-1
RUN
CLOSE #-1
#tape-blank
NEW
10 PRINT "TOKENS"
CSAVE "TOK"
#tape-rewind
NEW
10 OPEN "I",#-1,"TOK"
20 IF EOF(-1) THEN 50
30 LINE INPUT #-1,L$:PRINT LEN(L$)
40 GOTO 20
50 CLOSE #-1
RUN
