# bb-only: EDIT's other edit-mode commands, which bb10 stmt-edit did not try (docs/clean-room-basic.md section 4,
# the line editor). The line is typed afresh before each, then EDIT 10 is given one command with a key or two and
# ENTER, and LIST shows what was stored: I (insert) with Z; C (change) with Z; 2C with ZY; S (search) for A; 2S for
# the second quote; K (kill up to) A; 2K up to the second quote; 2D then A (start again?); 2D then E (end?); 2D then
# Q (quit?). After E and Q an ENTER follows in case the edit has ended (an empty line at OK then). A wait that times
# out (still in edit mode) is the result. Syntax [UM]; the answers [BB].
#timeout 15
#expect-timeout
10 PRINT "ABC"
#nowait
EDIT 10
#type IZ\n
LIST
10 PRINT "ABC"
#nowait
EDIT 10
#type CZ\n
LIST
10 PRINT "ABC"
#nowait
EDIT 10
#type 2CZY\n
LIST
10 PRINT "ABC"
#nowait
EDIT 10
#type SA\n
LIST
10 PRINT "ABC"
#nowait
EDIT 10
#type 2S"\n
LIST
10 PRINT "ABC"
#nowait
EDIT 10
#type KA\n
LIST
10 PRINT "ABC"
#nowait
EDIT 10
#type 2K"\n
LIST
10 PRINT "ABC"
#nowait
EDIT 10
#type 2DA\n
LIST
10 PRINT "ABC"
#nowait
EDIT 10
#type 2DE
#type \n
LIST
10 PRINT "ABC"
#nowait
EDIT 10
#type 2DQ
#type \n
LIST
