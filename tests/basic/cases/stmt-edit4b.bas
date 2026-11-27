# bb-only: EDIT's edges, one per case so a wait that times out ends only its own (docs/clean-room-basic.md section 4;
# bb11 stmt-edit3 reached none of these). Variant 2 of 5: an in-program EDIT, then CONT after it, on its own. stmt-edit3
# ran `10 EDIT 30:PRINT 5 / 20 PRINT 6 / 30 PRINT 7` and CONT gave ?CN ERROR there, but that run had already timed out
# at an earlier step, so the reading needs its own case. LIST after CONT shows whether the program is intact. A wait
# that times out (still in edit mode) is the result. Syntax [UM]; the answers [BB].
#timeout 30
#expect-timeout
10 EDIT 30:PRINT 5
20 PRINT 6
30 PRINT 7
RUN
CONT
LIST
