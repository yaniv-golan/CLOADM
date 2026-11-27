# bb-only: PRINT USING with 12 #s before ^^^^ (docs/clean-room-basic.md section 13: bb1 and bb2 found that twelve
# printed garbage and ran over the original's own memory, so this case runs on a fresh machine of its own).
# Ours gives ?FC ERROR. Typed as a statement with 1, then 12345 and -1, then a check that BASIC still works, and
# nothing after it: once the overrun may have spoilt BASIC's pointers, no LIST or RUN (either could walk into the ROM
# and show it as text), and no program form of the overrun. A wait that times out (BASIC stopped answering) is the
# result. Syntax [UM]; the output [BB].
#timeout 20
#expect-timeout
PRINT USING "############^^^^";1
PRINT USING "############^^^^";12345;-1
PRINT 1+1;"STILL"
