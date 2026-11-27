# bb-only: what the screen shows when CLOAD or SKIPF runs inside a program (docs/clean-room-basic.md section 12; bb8
# cas-in-program): eight lines are printed first, then SKIPF "TWO" (the fixture three-progs, our own: ONE, TWO,
# THREE), and pictures while it skips ONE, while it skips TWO and when it is done; then the same with CLOAD "TWO".
# The record's clears keep a screen a clear wiped. Then SKIPF "THREE" typed as a statement, with pictures while it
# skips. Syntax [UM]; the display [BB].
#timeout 120
#tape three-progs
NEW
10 FOR I=1 TO 8:PRINT "LINE";I:NEXT
20 SKIPF "TWO"
30 PRINT "AFTER SKIPF"
#nowait
RUN
#frames 30
#screenshot skipf-one
#frames 120
#screenshot skipf-two
#wait-text ^OK(?![\s\S])
#screenshot skipf-done
#tape-rewind
20 CLOAD "TWO"
30 PRINT "AFTER CLOAD"
#nowait
RUN
#frames 30
#screenshot cload-one
#frames 120
#screenshot cload-two
#wait-text ^OK(?![\s\S])
#screenshot cload-done
LIST
#tape-rewind
#nowait
SKIPF "THREE"
#frames 30
#screenshot direct-one
#frames 120
#screenshot direct-two
#frames 120
#screenshot direct-three
#wait-text ^OK(?![\s\S])
#screenshot direct-done
