# bb-only: EDIT's commands at their edges (docs/clean-room-basic.md section 4, the line editor), after bb11 stmt-edit2
# showed I, C, S, K, A, E and Q on a short line: S for a character the line does not hold (SZ), K for one it does
# not hold (KZ), 9C past the line's end (nine Zs typed), and A after an insertion (IZ, SHIFT-up arrow to leave it,
# then A: is the insertion kept?). The line is typed afresh before each, each edit ends with ENTER, and LIST shows
# what was stored. A wait that times out (still in edit mode) is the result. Syntax [UM]; the answers [BB].
#timeout 15
#expect-timeout
10 PRINT "ABC"
#nowait
EDIT 10
#type SZ\n
LIST
10 PRINT "ABC"
#nowait
EDIT 10
#type KZ\n
LIST
10 PRINT "ABC"
#nowait
EDIT 10
#type 9CZZZZZZZZZ\n
LIST
10 PRINT "ABC"
#nowait
EDIT 10
#type IZ
#keys SHIFT+UP
#type A\n
LIST
