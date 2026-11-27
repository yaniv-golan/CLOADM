# bb-only: EDIT's edges, which bb10 stmt-edit did not try (docs/clean-room-basic.md section 4, the line editor):
# a count past the end with space and with D; a count of two digits (12D); the left arrow after 3 space, and after X
# with Z; SHIFT-up arrow after X with Z, then L (back to the commands?); a line of exactly 32 characters (an empty
# row after either copy?); EDIT 10X, and EDIT 10:PRINT 5 (does the rest of the line run?); EDIT with no number when
# there is a line 0; EDIT in a program with more after it (does the program go on?), then CONT; and last BREAK after
# 2D. A wait that times out (still in edit mode) is the result. Syntax [UM]; the answers [BB].
#timeout 15
#expect-timeout
10 PRINT "ABC"
#nowait
EDIT 10
#type 99 \n
LIST
#nowait
EDIT 10
#type 99D\n
LIST
10 PRINT "ABCDEFGHIJKLMN"
#nowait
EDIT 10
#type 12D\n
LIST
10 PRINT "ABC"
#nowait
EDIT 10
#type 3
#keys SPACE
#keys LEFT
#type \n
LIST
#nowait
EDIT 10
#type XZ
#keys LEFT
#type \n
LIST
#nowait
EDIT 10
#type XZ
#keys SHIFT+UP
#type L\n
LIST
10 PRINT "ABCDEFGHIJKLMNOPQRSTU"
#nowait
EDIT 10
#type \n
10 PRINT "ABC"
#nowait
EDIT 10X
#type \n
#nowait
EDIT 10:PRINT 5
#type \n
0 PRINT 0
#nowait
EDIT
#type \n
NEW
10 EDIT 30:PRINT 5
20 PRINT 6
30 PRINT 7
#nowait
RUN
#type \n
CONT
#nowait
EDIT 10
#type 2D
#keys BREAK
LIST
