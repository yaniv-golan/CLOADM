# bb-only: how long some operations take (docs/clean-room-basic.md section 4), in fields counted by TIMER, as
# ram-pointers2 times its loops: pairs of loops the same but for the item under test, each started just after a field
# begins (300-320). 1000 passes of: nothing; X=I; X=PEEK(I AND 32767) (reading RAM at 1-1000); X=(I AND 32767);
# X=I AND 1; X=I+1; 500 passes of A$=STR$(I) and L=LEN(STR$(I)); 1000 passes of X=VAL(A$) with A$ "32767" and
# "1"; then, in two programs that differ only in their first line's DATA (32767 or 1), 1000 passes of RESTORE:READ X.
# Low RAM is PEEKed only through "AND 32767", at addresses 1-1000 (bb-only, reviewed by hand). Only the counts are
# compared. Syntax [UM]; the counts [BB].
#timeout 300
10 DIM T(12)
20 GOSUB 300:FOR I=1 TO 1000:NEXT:T(0)=TIMER
21 GOSUB 300:FOR I=1 TO 1000:X=I:NEXT:T(1)=TIMER
22 GOSUB 300:FOR I=1 TO 1000:X=PEEK(I AND 32767):NEXT:T(2)=TIMER
23 GOSUB 300:FOR I=1 TO 1000:X=(I AND 32767):NEXT:T(3)=TIMER
24 GOSUB 300:FOR I=1 TO 1000:X=I AND 1:NEXT:T(4)=TIMER
25 GOSUB 300:FOR I=1 TO 1000:X=I+1:NEXT:T(5)=TIMER
26 GOSUB 300:FOR I=1 TO 500:A$=STR$(I):NEXT:T(6)=TIMER
27 GOSUB 300:FOR I=1 TO 500:L=LEN(STR$(I)):NEXT:T(7)=TIMER
28 A$="32767":GOSUB 300:FOR I=1 TO 1000:X=VAL(A$):NEXT:T(8)=TIMER
29 A$="1":GOSUB 300:FOR I=1 TO 1000:X=VAL(A$):NEXT:T(9)=TIMER
40 FOR J=0 TO 9:PRINT T(J);:NEXT:PRINT:END
300 W=TIMER
310 IF TIMER=W THEN 310
320 TIMER=0:RETURN
RUN
NEW
1 DATA 32767
10 GOSUB 300:FOR I=1 TO 1000:RESTORE:READ X:NEXT:T=TIMER:PRINT "DATA 32767";T:END
300 W=TIMER
310 IF TIMER=W THEN 310
320 TIMER=0:RETURN
RUN
1 DATA 1
10 GOSUB 300:FOR I=1 TO 1000:RESTORE:READ X:NEXT:T=TIMER:PRINT "DATA 1";T:END
RUN
