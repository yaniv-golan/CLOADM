# an operand or a NOT straight after a relation, and an operator after a NOT's operand: each level of the expression
# evaluator hands the character after its operand to the level above (basic/expr.inc), so the next operator is seen
# after a signed operand, a relation's right side and a NOT [UM for the precedence and the values]
A=-2:PRINT A<-1;A>-3;A=-2;A<=+5;A<>-A;"A"<"B"
PRINT 2>-(1);3<-1 OR -1<3;1<-1 OR 4
PRINT NOT 0 AND 5;NOT 5 OR 1;NOT 0=0 OR 4;NOT -1<3
PRINT NOT NOT 3 AND 7;1 OR NOT 0 AND 2;-1<3 AND NOT -1>-2
PRINT "A"+"B"<"AC";1+2*3^2-4/2;-2^2;2^-1;1=1=-1;3>2>1
PRINT NOT 1=2 AND "A"<>"B";(1<2)+-(2<1)*-3
PRINT 1<
PRINT NOT
