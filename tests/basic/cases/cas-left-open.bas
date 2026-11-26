# bb-only: a cassette file left open by ?IO ERROR (docs/clean-room-basic.md section 12, open question 10), on the
# fixture bad-then-good (our own: BAD, a program whose data block has a wrong checksum, then GOOD). First SKIPF over
# BAD: what it does with the bad block (its motor runs, what it says, then whether CLOAD "GOOD" works). Then, each
# time from the tape's start, CLOAD meets the bad block (?IO ERROR, the file left open: bb5 cas-errors) and one
# statement follows: does it refuse (?AO ERROR, as SKIPF did in bb5) or close the file, or neither? CLOAD "GOOD" after
# it, from the tape's start again (a named search passes BAD by its namefile), tells: ?AO ERROR while the file is
# still open, GOOD loaded once it is closed. The statements: PRINT #-1, EOF(-1), CLOSE #-1, CLOSE, MOTOR, NEW, RUN,
# CLEAR, an error (?/0), OPEN "I" (late: should it open GOOD, that file is what is left open) and CSAVE (its motor
# runs show whether it wrote). Syntax [UM]; the errors [BB].
#timeout 120
#tape bad-then-good
SKIPF
#tape-blocks skipf-bad
CLOAD "GOOD"
LIST
#tape-rewind
NEW
CLOAD
PRINT #-1,1
#tape-rewind
CLOAD "GOOD"
LIST
#tape-rewind
NEW
CLOAD
PRINT EOF(-1)
#tape-rewind
CLOAD "GOOD"
LIST
#tape-rewind
NEW
CLOAD
CLOSE #-1
#tape-rewind
CLOAD "GOOD"
LIST
#tape-rewind
NEW
CLOAD
CLOSE
#tape-rewind
CLOAD "GOOD"
LIST
#tape-rewind
NEW
CLOAD
MOTOR ON:MOTOR OFF
#tape-rewind
CLOAD "GOOD"
LIST
#tape-rewind
NEW
CLOAD
NEW
#tape-rewind
CLOAD "GOOD"
LIST
#tape-rewind
NEW
CLOAD
RUN
#tape-rewind
CLOAD "GOOD"
LIST
#tape-rewind
NEW
CLOAD
CLEAR
#tape-rewind
CLOAD "GOOD"
LIST
#tape-rewind
NEW
CLOAD
PRINT 1/0
#tape-rewind
CLOAD "GOOD"
LIST
#tape-rewind
NEW
CLOAD
OPEN "I",#-1,"GOOD"
#tape-rewind
CLOAD "GOOD"
LIST
#tape-rewind
NEW
CLOAD
CSAVE "X"
#tape-blocks csave
#tape-rewind
CLOAD "GOOD"
LIST
