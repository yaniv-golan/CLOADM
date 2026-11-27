# bb-only: EDIT on a stored line (docs/clean-room-basic.md section 4, the line editor): ours gives ?FC ERROR. The
# keys are bounded: each EDIT is given a few edit-mode keys from the manual's list and ENTER, and LIST shows what
# was stored. EDIT 10 then ENTER alone (the line kept as it was?); X (to the end, inserting) with :PRINT 2; L (the
# line listed); 6, space, H (delete the rest, inserting) with 7; 2D (delete two characters); then EDIT of a line
# that is not there, EDIT with no number, and EDIT in a program. A wait that times out (still in edit mode) is the
# result. Syntax [UM]; the answers [BB].
#timeout 15
#expect-timeout
10 PRINT "ABC"
#nowait
EDIT 10
#type \n
LIST
#nowait
EDIT 10
#type X:PRINT 2\n
LIST
#nowait
EDIT 10
#type L
#type \n
LIST
#nowait
EDIT 10
#type 6 H7\n
LIST
#nowait
EDIT 10
#type 2D\n
LIST
#nowait
EDIT 99
#type \n
#nowait
EDIT
#type \n
NEW
10 PRINT "ABC"
20 EDIT 10
#nowait
RUN
#type \n
LIST
