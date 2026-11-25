# the string space: garbage collected when it fills, ?OS ERROR when the strings in use need more; CLEAR [UM]
10 CLEAR 200
20 FOR I=1 TO 200:A$=STRING$(40,"X"):B$=STR$(I):NEXT
30 PRINT LEN(A$);B$
40 DIM S$(3):FOR I=0 TO 3:S$(I)=STRING$(20,CHR$(65+I)):NEXT
50 FOR I=1 TO 50:T$=STRING$(30,"Z"):NEXT
60 PRINT S$(0);S$(3)
70 X$=STRING$(40,"Q"):PRINT "FITS"
80 Y$=X$+X$
RUN
CLEAR 300:A$=STRING$(250,"W"):PRINT LEN(A$)
