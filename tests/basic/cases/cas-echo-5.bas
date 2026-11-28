# bb-only: is the line that bb10 cas-ascii-save showed twice (rows 8-9 of its screen before CLOAD "X" cleared it) a
# picture taken during a scroll? The harness keeps the screen as it was at the last field before a clear (`clears`);
# a field that ends while the screen is being moved up a row holds the rows above the move's progress moved and those
# below not yet, so one row shows twice. Ours shows that in this case at some delays. A program fills the screen with
# 15 numbers, waits a loop of N+1 passes, prints END and N on the bottom row (the screen moves up), and clears at
# once; N from 0 to 47 moves the moment of the move through the field. If the original's pictures also show a row
# twice at some N, the echo is the move caught mid-way, not a line typed twice. No memory is read or written.
# Syntax [UM]; the screens [BB].
#timeout 60
10 FOR N=0 TO 47
20 CLS:FOR I=1 TO 15:PRINT I:NEXT
30 FOR D=0 TO N:NEXT:PRINT "END";N:CLS
40 NEXT
RUN
