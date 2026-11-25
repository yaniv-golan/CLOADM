# follow-up of bb1 review-fixes: VAL overflowing on a string in string space, and on a literal in a direct line [OWN]
10 A$="1E99"+"":B$=A$+"7"
20 X=VAL(B$)
RUN
PRINT B$;LEN(B$)
PRINT VAL("12");VAL("1E99")
PRINT "AFTER"
