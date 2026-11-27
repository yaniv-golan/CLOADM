# bb-only: how long the interpreter takes to read a number written in a statement (docs/clean-room-basic.md section
# 5), in fields counted by TIMER, as ram-pointers2 times its loops: 1000 passes of X= each literal (1, 11, 10, 111,
# 11111, 105, 1005, 655361, 1.1, 11.1), every loop the same but for the literal, and an empty loop first, each started
# just after a field begins (300-320), so where in a field it starts cannot move its count. Only the counts are
# compared, to tell where ours is faster or slower than the original. Syntax [UM]; the counts [BB].
#timeout 300
10 DIM T(10)
20 GOSUB 300:FOR I=1 TO 1000:NEXT:T(0)=TIMER
21 GOSUB 300:FOR I=1 TO 1000:X=1:NEXT:T(1)=TIMER
22 GOSUB 300:FOR I=1 TO 1000:X=11:NEXT:T(2)=TIMER
23 GOSUB 300:FOR I=1 TO 1000:X=10:NEXT:T(3)=TIMER
24 GOSUB 300:FOR I=1 TO 1000:X=111:NEXT:T(4)=TIMER
25 GOSUB 300:FOR I=1 TO 1000:X=11111:NEXT:T(5)=TIMER
26 GOSUB 300:FOR I=1 TO 1000:X=105:NEXT:T(6)=TIMER
27 GOSUB 300:FOR I=1 TO 1000:X=1005:NEXT:T(7)=TIMER
28 GOSUB 300:FOR I=1 TO 1000:X=655361:NEXT:T(8)=TIMER
29 GOSUB 300:FOR I=1 TO 1000:X=1.1:NEXT:T(9)=TIMER
30 GOSUB 300:FOR I=1 TO 1000:X=11.1:NEXT:T(10)=TIMER
40 FOR J=0 TO 10:PRINT T(J);:NEXT:PRINT:END
300 W=TIMER
310 IF TIMER=W THEN 310
320 TIMER=0:RETURN
RUN
