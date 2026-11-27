# bb-only: EDIT's edges, one per case so a wait that times out ends only its own (docs/clean-room-basic.md section 4;
# bb11 stmt-edit3 reached none of these). Variant 3 of 5: `EDIT 10X`, the trailing character, on its own: does the X
# count as an edit command, end the edit, or make a syntax error, and is line 10 left as it was? LIST says what was
# stored either way. A wait that times out (still in edit mode) is the result. Syntax [UM]; the answers [BB].
#timeout 20
#expect-timeout
10 PRINT "ABC"
#nowait
EDIT 10X
#type \n
LIST
