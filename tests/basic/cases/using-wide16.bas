# bb-only: PRINT USING with 16 #s before ^^^^ (docs/clean-room-basic.md section 13: bb1 and bb2 found that twelve
# printed garbage and ran over the original's own memory, so each width has a case of its own, on a fresh machine).
# Ours gives ?FC ERROR. Typed as a statement with 1, then 12345 and -1, then a check that BASIC still works; then
# after NEW in a program (its run may show what the statement left behind), and LIST. A wait that times out (BASIC
# stopped answering) is the result. Syntax [UM]; the output [BB].
#timeout 20
#expect-timeout
PRINT USING "################^^^^";1
PRINT USING "################^^^^";12345;-1
PRINT 1+1;"STILL"
NEW
10 PRINT USING "################^^^^";1
20 PRINT USING "################^^^^";12345;-1
30 PRINT 1+1;"STILL"
RUN
LIST
