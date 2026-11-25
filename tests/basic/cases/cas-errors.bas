# bb-only: the cassette's errors (docs/clean-room-basic.md section 12): CLOAD of a data file and of machine code (the
# fixture mixed, our own: a data file, six bytes of code, a program as text), and CLOAD "NAME" past both to the
# program; a block whose checksum is wrong (the fixture bad-block) and whether a program typed before survives it;
# SKIPF over a bad block; and BREAK while CLOAD searches a tape with no such file (last, as an original that does not
# look at BREAK there never comes back). Syntax [UM]; the errors [BB].
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
#frames 1500
#break
#tape-blocks break
LIST
