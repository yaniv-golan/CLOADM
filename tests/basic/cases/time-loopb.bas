# bb-only: where bb8 cas-cloadm2's span B spends its time (docs/clean-room-basic.md section 2): ours takes 23 fields
# more than the original there (2,419 against 2,396), and bb11 cas-skipf-end shows its tape parts take the original's
# time, so the difference is after the tape. Its parts in fields counted by TIMER, each loop started just after a
# field begins (300-320), as time-ops does: loop B as cas-cloadm2 types it (600 passes of S=S+PEEK(28928+I AND
# 32767)), then with S=S+PEEK(I AND 32767), S=S+1, X=28928+I AND 32767 and nothing in the loop; FOR D=1 TO 300 with
# nothing in it, as cas-cloadm2's line 10; and loop B typed in direct mode, as cas-cloadm2 runs it, with TIMER=0
# before it on the same line. Memory set aside by CLEAR is read through "AND 32767" at 28928-29527 and at 0-599
# (bb-only, reviewed by hand); nothing is written. Only the counts are compared. Syntax [UM]; the counts [BB].
#timeout 300
CLEAR 200,28671
10 DIM T(6)
20 GOSUB 300:S=0:FOR I=0 TO 599:S=S+PEEK(28928+I AND 32767):NEXT:T(0)=TIMER
21 GOSUB 300:S=0:FOR I=0 TO 599:S=S+PEEK(I AND 32767):NEXT:T(1)=TIMER
22 GOSUB 300:S=0:FOR I=0 TO 599:S=S+1:NEXT:T(2)=TIMER
23 GOSUB 300:FOR I=0 TO 599:X=28928+I AND 32767:NEXT:T(3)=TIMER
24 GOSUB 300:FOR I=0 TO 599:NEXT:T(4)=TIMER
25 GOSUB 300:FOR D=1 TO 300:NEXT:T(5)=TIMER
30 FOR K=0 TO 5:PRINT T(K);:NEXT:PRINT:END
300 W=TIMER
310 IF TIMER=W THEN 310
320 TIMER=0:RETURN
RUN
TIMER=0:S=0:FOR I=0 TO 599:S=S+PEEK(28928+I AND 32767):NEXT:PRINT TIMER
