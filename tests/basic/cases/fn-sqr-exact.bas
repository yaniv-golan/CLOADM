# which square roots come out exact: of the squares to 400, SQR gives a whole number for only 1, 4, 9, 16, 64, 81,
# 121 and 256 on the original; through VAL(STR$()) all twenty; SQR(25)-5 is 1.86264515E-09 [BB typed-in, 2026-11-25]
#timeout 120
10 FOR N=1 TO 400:S=SQR(N):IF S=INT(S) THEN PRINT N;
20 NEXT:PRINT
RUN
10 FOR N=1 TO 400:S=VAL(STR$(SQR(N))):IF S=INT(S) THEN PRINT N;
RUN
PRINT SQR(25)-5;SQR(16)-4;SQR(64)-8
