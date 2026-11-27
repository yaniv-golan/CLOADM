# bb-only: CLOSE after a second OPEN that failed while the first file, open for output, has a record not yet written
# (docs/clean-room-basic.md section 12, open question 10; bb8 cas-data-errors had none pending). On a blank tape, so
# each step's blocks are recorded: which blocks the failed OPEN writes (its own namefile? the pending record?), and
# which the CLOSE after it writes. A record pending then OPEN "O" again (F, then G: ?AO ERROR), then OPEN "I" (H, then
# G); one left pending by a program and a second OPEN typed as a statement (J, then K); 330 bytes (one full block
# and a part) then OPEN "O" (L, then M); and with nothing pending, as bb8 did, then PRINT #-1 after the ?AO ERROR (N,
# then G: is the file still open, and is that record N's?). Last, the tape read back from its start: the records of F,
# J and N (OPEN "I" by name; the files' names in A$). Syntax [UM]; the errors and the blocks [BB].
#timeout 180
#tape-blank
NEW
10 OPEN "O",#-1,"F":PRINT #-1,"PENDING F":OPEN "O",#-1,"G"
RUN
#tape-blocks open-f-g
CLOSE #-1
#tape-blocks close-f
NEW
10 OPEN "O",#-1,"H":PRINT #-1,"PENDING H":OPEN "I",#-1,"G"
RUN
#tape-blocks open-h-g
CLOSE #-1
#tape-blocks close-h
NEW
10 OPEN "O",#-1,"J":PRINT #-1,"PENDING J"
RUN
#tape-blocks open-j
OPEN "O",#-1,"K"
#tape-blocks open-k
CLOSE #-1
#tape-blocks close-j
NEW
10 OPEN "O",#-1,"L":FOR I=1 TO 30:PRINT #-1,"0123456789":NEXT:OPEN "O",#-1,"M"
RUN
#tape-blocks open-l-m
CLOSE #-1
#tape-blocks close-l
NEW
10 OPEN "O",#-1,"N":OPEN "O",#-1,"G"
RUN
#tape-blocks open-n-g
PRINT #-1,"AFTER"
#tape-blocks print-n
CLOSE #-1
#tape-blocks close-n
#tape-rewind
NEW
10 OPEN "I",#-1,A$
20 IF EOF(-1) THEN 50
30 LINE INPUT #-1,L$:PRINT "[";L$;"]"
40 GOTO 20
50 CLOSE #-1:PRINT "END ";A$
A$="F":GOTO 10
#tape-rewind
A$="J":GOTO 10
#tape-rewind
A$="N":GOTO 10
