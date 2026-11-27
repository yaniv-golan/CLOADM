# bb-only: whether multiplying takes longer for some operands (docs/clean-room-basic.md section 5), in fields counted
# by TIMER, as ram-pointers2 times its loops: 1000 passes of X=Y*Z, every loop the same, with Y and Z set before it
# to values whose mantissas have one bit set (2: $80 00 00 00), one byte all set (255: $FF 00 00 00), every bit set
# (4294967295: $FF FF FF FF), alternate bits (.333333333: about $AA AA AA AB), and the first and last bits
# (2147483649: $80 00 00 01); each pair both ways round, to see which operand is scanned. X=Y first, for the loop's
# own cost. Each started just after a field begins (300-320). Only the counts are compared. Syntax [UM]; the counts
# [BB].
#timeout 300
10 DIM T(20):N=0
20 READ Y,Z:IF Y<0 THEN 40
30 GOSUB 300:FOR I=1 TO 1000:X=Y*Z:NEXT:T(N)=TIMER:N=N+1:GOTO 20
40 GOSUB 300:FOR I=1 TO 1000:X=Y:NEXT:PRINT "Y";TIMER
50 FOR J=0 TO N-1:PRINT T(J);:NEXT:PRINT:END
100 DATA 2,2,255,255,4294967295,4294967295,.333333333,.333333333,2147483649,2147483649
110 DATA 2,4294967295,4294967295,2,255,4294967295,4294967295,255
120 DATA 2,.333333333,.333333333,2,255,.333333333,.333333333,255
130 DATA 2,2147483649,2147483649,2,4294967295,2147483649,2147483649,4294967295,-1,-1
300 W=TIMER
310 IF TIMER=W THEN 310
320 TIMER=0:RETURN
RUN
