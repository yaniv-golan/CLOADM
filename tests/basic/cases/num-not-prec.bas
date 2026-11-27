# bb-only: NOT after a relation and after an operator, the follow-up of bb9 expr-not: NOT 0+1 on the right of a
# relation (NOT taking 0+1, or 0 alone), and 5+NOT 0<1 (NOT taking 0<1, or 0 alone). Ours gives ?SN ERROR for both.
# One line each, so an error stops only its own line; NOT first, and the parts on their own, for comparison. Syntax
# [UM]; the answers [BB].
PRINT 1<NOT 0+1
PRINT 5+NOT 0<1
PRINT NOT 0+1;NOT 0<1
PRINT 1<(NOT 0+1);5+(NOT 0<1)
PRINT 1<(NOT 0)+1;5+(NOT 0)<1
