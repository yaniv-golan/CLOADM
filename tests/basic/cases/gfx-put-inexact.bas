# bb-only: PUT of a numeric array whose numbers are not exact in binary (docs/clean-room-basic-p2.md section 8;
# decision 6; bb2 gfx-getarray): F holds .1, .2, .3, ... 1 and, last, .1+.2 (decimals, inexact), G holds 1, 2, 3, ...
# 11 (whole), E holds F times ten (whole numbers computed from inexact ones). Each is PUT into a 16 x 16 area of
# PMODE 4 with PSET and shown: does PUT take the numbers' values or their stored bytes? No GET back (bb2 found an
# array read by GET then gives ?BS ERROR). After BREAK the arrays are printed (PUT left them as they were?), and E less
# G. "PUT DONE" is printed on the text screen behind the picture once the PUTs are done. Syntax [UM]; the picture and
# the values [BB].
#timeout 60
10 PMODE 4,1:PCLS:SCREEN 1,1:DIM F(10),G(10),E(10)
20 FOR I=0 TO 10:F(I)=(I+1)/10:G(I)=I+1:E(I)=F(I)*10:NEXT:F(10)=.1+.2
30 PUT(0,0)-(15,15),F,PSET:PUT(32,0)-(47,15),G,PSET:PUT(64,0)-(79,15),E,PSET
90 PRINT "PUT DONE"
99 GOTO 99
#nowait
RUN
#wait-text ^PUT DONE|ERROR IN \d+
#screenshot put-inexact
#break
SCREEN 0,0
FOR I=0 TO 10:PRINT F(I);:NEXT
FOR I=0 TO 10:PRINT G(I);:NEXT
FOR I=0 TO 10:PRINT E(I);:NEXT
FOR I=0 TO 10:PRINT E(I)-G(I);:NEXT
