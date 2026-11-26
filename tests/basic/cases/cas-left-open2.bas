# bb-only: what closes a cassette file left open by ?IO ERROR (docs/clean-room-basic.md section 12, open question 10),
# the question bb8 cas-left-open could not answer (the original's search stops with ?IO ERROR at a bad block it
# passes, and BAD came first on that tape). Here GOOD comes before BAD (the fixture good-then-bad, our own). Each time:
# CLOAD "BAD" meets its bad block (?IO ERROR, the file left open), one statement follows, then from the tape's start
# OPEN "I",#-1,"GOOD" (?AO ERROR while the file is still open; opened once it is closed) and CLOSE #-1. The
# statements: none, CLOSE #-1, CLOSE, NEW, RUN, CLEAR, an error (?/0), MOTOR, CLOAD "GOOD" (from the tape's start, as
# GOOD is before BAD: does a load close it?) and SKIPF. Syntax [UM]; the errors [BB].
#timeout 120
#tape good-then-bad
NEW
CLOAD "BAD"
#tape-rewind
OPEN "I",#-1,"GOOD"
CLOSE #-1
#tape-rewind
NEW
CLOAD "BAD"
CLOSE #-1
#tape-rewind
OPEN "I",#-1,"GOOD"
CLOSE #-1
#tape-rewind
NEW
CLOAD "BAD"
CLOSE
#tape-rewind
OPEN "I",#-1,"GOOD"
CLOSE #-1
#tape-rewind
NEW
CLOAD "BAD"
NEW
#tape-rewind
OPEN "I",#-1,"GOOD"
CLOSE #-1
#tape-rewind
NEW
CLOAD "BAD"
RUN
#tape-rewind
OPEN "I",#-1,"GOOD"
CLOSE #-1
#tape-rewind
NEW
CLOAD "BAD"
CLEAR
#tape-rewind
OPEN "I",#-1,"GOOD"
CLOSE #-1
#tape-rewind
NEW
CLOAD "BAD"
PRINT 1/0
#tape-rewind
OPEN "I",#-1,"GOOD"
CLOSE #-1
#tape-rewind
NEW
CLOAD "BAD"
MOTOR ON:MOTOR OFF
#tape-rewind
OPEN "I",#-1,"GOOD"
CLOSE #-1
#tape-rewind
NEW
CLOAD "BAD"
#tape-rewind
CLOAD "GOOD"
#tape-rewind
OPEN "I",#-1,"GOOD"
CLOSE #-1
#tape-rewind
NEW
CLOAD "BAD"
SKIPF
#tape-rewind
OPEN "I",#-1,"GOOD"
CLOSE #-1
