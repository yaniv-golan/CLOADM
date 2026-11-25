# bb-only: the cassette's errors (docs/clean-room-basic.md section 12): CLOAD of a data file and of machine code (the
# fixture mixed, our own: a data file, six bytes of code, a program as text), and CLOAD "NAME" past both to the
# program; a block whose checksum is wrong (the fixture bad-block) and whether a program typed before survives it;
# SKIPF over a bad block; and BREAK while CLOAD searches a tape with no such file (last, as an original that does not
# look at BREAK there never comes back): the picture while it searches, then BREAK with a wait of 10 s for OK. The
# original searched on (bb5: BREAK did not end the search), so that timeout is the case's end (#expect-timeout).
# The screen the search's clear wiped is in the record's clears. Syntax [UM]; the errors [BB].
#timeout 120
#tape mixed
CLOAD
CLOAD
CLOAD
LIST
#tape-rewind
NEW
CLOAD "PROG"
LIST
#tape bad-block
5 REM KEPT
CLOAD
LIST
#tape-rewind
SKIPF
#tape-blocks after-skipf
#tape mixed
#nowait
CLOAD "NONE"
#frames 500
#screenshot searching
#tape-blocks searching
#timeout 10
#expect-timeout
#break
#screenshot after-break
#tape-blocks break
LIST
