# bb-only: what CSAVE "NAME",A writes (docs/clean-room-basic.md section 12): does the text start with a carriage
# return, and how is each line ended? On a blank tape: a two-line program of the case's own saved as text (the tape
# summary: the namefile's flags and the data block's length and hash), a one-line program, and an empty one after
# NEW. Then each read back from the tape's start as a data file with LINE INPUT #-1: each record's length, the record
# in brackets, and its first character's code. Last the two-line one CLOADed and LISTed. Syntax [UM]; the blocks and
# the records [BB].
#timeout 180
#tape-blank
NEW
10 PRINT "HI"
20 GOTO 10
CSAVE "X",A
#tape-blocks two-lines
NEW
10 END
CSAVE "Y",A
#tape-blocks one-line
NEW
CSAVE "Z",A
#tape-blocks empty
#tape-rewind
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
A$="Z":GOTO 10
#tape-rewind
NEW
CLOAD "X"
LIST
