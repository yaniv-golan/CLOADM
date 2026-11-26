# bb-only: NOT straight after a relation or another operator, for the original (bb9): ours gives ?SN ERROR for each
# of these, where the manual's precedence would read NOT and its operand as the right side; one line each, so an
# error stops only its own line. NOT first, for comparison. Syntax [UM]; the answers [BB].
PRINT 1<NOT 0
PRINT 1=NOT 0
PRINT 5+NOT 0
PRINT 2*NOT 0
PRINT -NOT 0
PRINT 1 AND NOT 0
PRINT NOT 0<1
