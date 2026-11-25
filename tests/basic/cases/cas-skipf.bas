# bb-only: SKIPF (docs/clean-room-basic.md section 12) on a tape of three programs (the fixture three-progs: ONE,
# TWO, THREE, our own, saved as text): SKIPF passes over the next file, SKIPF "NAME" over the file of that name (and
# what it says of the files before it), then CLOAD takes the file after; two SKIPFs on one line; and the motor's runs
# of a SKIPF. Syntax [UM]; the messages and the timing [BB].
#timeout 120
#tape three-progs
SKIPF
#tape-blocks skipf
CLOAD
LIST
#tape-rewind
SKIPF "TWO"
CLOAD
LIST
#tape-rewind
SKIPF:SKIPF
CLOAD
LIST
#tape-rewind
SKIPF "ONE"
CLOAD "THREE"
LIST
