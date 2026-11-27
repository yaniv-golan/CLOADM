# bb-only: EDIT's edges, one per case so a wait that times out ends only its own (docs/clean-room-basic.md section 4;
# bb11 stmt-edit3 reached none of these). Variant 5 of 5: a bare `EDIT` with a line 0 present, on its own: with no
# number, does it open line 0 (the lowest line) or ask for a number, and what does its ENTER store? LIST shows. A wait
# that times out (still in edit mode) is the result. Syntax [UM]; the answers [BB].
#timeout 20
#expect-timeout
0 PRINT 0
#nowait
EDIT
#type \n
LIST
