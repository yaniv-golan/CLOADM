# bb-only: what printing a number costs by its digits (docs/clean-room-basic.md section 2): bb13b cas-echo-5's passes
# print 1 to 15 with a carriage return and are about 0.6 field faster on ours than the original's, beyond CLS, while
# bb13c time-screen's PRINT I; for I from 1 to 300 is slower on ours. In fields counted by TIMER, as time-screen times
# its loops, each loop 300 passes started just after a field begins (300-320), each pass a CLS first (so nothing
# scrolls; bb13c timed CLS alone): PRINT N; and PRINT N for N = 5, 55, 555, 5555 and -5, and PRINT alone (a carriage
# return). The counts are printed at the end on a cleared screen. Syntax [UM]; the counts [BB].
#timeout 400
10 DIM T(12):K=0
20 READ N:IF N=0 THEN 60
30 GOSUB 300:FOR I=1 TO 300:CLS:PRINT N;:NEXT:T(K)=TIMER:K=K+1
40 GOSUB 300:FOR I=1 TO 300:CLS:PRINT N:NEXT:T(K)=TIMER:K=K+1
50 GOTO 20
60 GOSUB 300:FOR I=1 TO 300:CLS:PRINT:NEXT:T(K)=TIMER:K=K+1
70 CLS:FOR J=0 TO K-1:PRINT T(J);:NEXT:PRINT:END
100 DATA 5,55,555,5555,-5,0
300 W=TIMER
310 IF TIMER=W THEN 310
320 TIMER=0:RETURN
RUN
