# bb-only: cassette data files' errors and what closes a file (docs/clean-room-basic.md section 12, open question 10),
# on a blank tape, so that each step's blocks are recorded (a file closed writes its last block and an end of file:
# the summaries show whether NEW, RUN or an error closed it). With no file open, in a program: PRINT #-1 and INPUT #-1
# (?NO); OPEN with a mode other than I and O, and with the devices #-2 and #0 (?FM, ?DN). INPUT #-1 from a file open
# for output; a second OPEN while one is open (?AO); EOF(-1) of a file open for output. Then a file opened for output
# and left open across NEW, across RUN and across an error (?/0), each followed by OPEN "O" again (?AO ERROR while it
# is still open) and CLOSE #-1. Syntax [UM]; the errors and the blocks [BB].
#timeout 180
#tape-blank
10 PRINT #-1,1
RUN
NEW
10 INPUT #-1,A
RUN
NEW
10 OPEN "X",#-1,"E"
RUN
NEW
10 OPEN "O",#-2,"E"
RUN
NEW
10 OPEN "O",#0,"E"
RUN
#tape-blocks no-file
CLOSE #-1
NEW
10 OPEN "O",#-1,"E"
20 INPUT #-1,A
RUN
#tape-blocks input-from-output
CLOSE #-1
#tape-blocks close-e
NEW
10 OPEN "O",#-1,"F":OPEN "O",#-1,"G"
RUN
#tape-blocks second-open
CLOSE #-1
#tape-blocks close-f
NEW
10 OPEN "O",#-1,"H"
20 PRINT EOF(-1)
RUN
#tape-blocks eof-out
CLOSE #-1
#tape-blocks close-h
NEW
10 OPEN "O",#-1,"N"
20 PRINT #-1,"OPEN ACROSS NEW"
RUN
#tape-blocks open-n
NEW
#tape-blocks new
OPEN "O",#-1,"P"
#tape-blocks after-new
CLOSE #-1
#tape-blocks close-p
10 OPEN "O",#-1,"R"
20 PRINT #-1,"OPEN ACROSS RUN"
RUN
#tape-blocks run-1
RUN
#tape-blocks run-2
CLOSE #-1
#tape-blocks close-r
NEW
10 OPEN "O",#-1,"Z":PRINT #-1,"OPEN ACROSS ERROR":PRINT 1/0
RUN
#tape-blocks error
OPEN "O",#-1,"Q"
#tape-blocks after-error
CLOSE #-1
#tape-blocks close-q
