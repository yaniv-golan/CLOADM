# bb-only: how long RND takes (docs/clean-room-basic.md section 5; ours is never to be faster): 500 passes each of
# R=RND(0), RND(6), RND(1E9), RND(.5), and RND(-1), RND(-3) and RND(-1.99999999) (each a fixed seed, $80000000,
# $C0000000 and about $FFFFFFFF, so the seed's bits are the same every pass), each started just after a field begins
# (as ram-pointers2), counted in fields by TIMER. Syntax [UM]; the counts [BB].
#timeout 300
10 DIM T(7):FOR J=1 TO 7:READ A:GOSUB 300:FOR I=1 TO 500:R=RND(A):NEXT:T(J)=TIMER:NEXT
20 FOR J=1 TO 7:PRINT T(J);:NEXT:PRINT:END
30 DATA 0,6,1E9,.5,-1,-3,-1.99999999
300 W=TIMER
310 IF TIMER=W THEN 310
320 TIMER=0:RETURN
RUN
