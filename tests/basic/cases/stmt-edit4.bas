# bb-only: EDIT's edges, one per case so a wait that times out ends only its own (docs/clean-room-basic.md section 4,
# the line editor; bb11 stmt-edit3 reached none of these: its #timeout fired at one, before the rest). Variant 1 of 5:
# 2D then BREAK, the one stmt-edit3 listed last and never reached. After 2D deletes two characters the edit goes on;
# BREAK is pressed there, and LIST shows what was stored: whether BREAK leaves edit mode, and with what line. A wait
# that times out (BREAK ignored, still in edit mode) is the result. Syntax [UM]; the answers [BB].
#timeout 20
#expect-timeout
10 PRINT "ABC"
#nowait
EDIT 10
#type 2D
#keys BREAK
LIST
