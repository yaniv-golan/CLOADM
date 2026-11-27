# bb-only: EDIT's edges, one per case so a wait that times out ends only its own (docs/clean-room-basic.md section 4;
# bb11 stmt-edit3 reached none of these). Variant 4 of 5: `EDIT 10:PRINT 5`, the rest of the line after EDIT, on its
# own: does the `:PRINT 5` run after the edit, or wait for the editor's ENTER, and if it runs, is it before or after
# the edited line is stored? The typed value and LIST both show. A wait that times out (still in edit mode) is the
# result. Syntax [UM]; the answers [BB].
#timeout 20
#expect-timeout
10 PRINT "ABC"
#nowait
EDIT 10:PRINT 5
#type \n
LIST
