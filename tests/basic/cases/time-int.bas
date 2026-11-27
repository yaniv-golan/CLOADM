# bb-only: whether INT takes longer for some exponents (docs/clean-room-basic.md section 5), in fields counted by
# TIMER, as ram-pointers2 times its loops: 1000 passes of X=INT(Y), every loop the same, with Y .5, 3.5, 1000.5,
# 1E6+.5, 1E9+.5 (set before the loop), and -1000.5; X=Y first, for the loop's own cost. Each started just after a
# field begins (300-320). Only the counts are compared. Syntax [UM]; the counts [BB].
#timeout 300
10 DIM T(10):N=0:Y=3.5
20 GOSUB 300:FOR I=1 TO 1000:X=Y:NEXT:PRINT "Y";TIMER
30 READ Y:IF Y=0 THEN 50
40 GOSUB 300:FOR I=1 TO 1000:X=INT(Y):NEXT:T(N)=TIMER:N=N+1:GOTO 30
50 FOR J=0 TO N-1:PRINT T(J);:NEXT:PRINT:END
100 DATA .5,3.5,1000.5,1000000.5,1000000000.5,-1000.5,0
300 W=TIMER
310 IF TIMER=W THEN 310
320 TIMER=0:RETURN
RUN
