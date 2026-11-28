# bb-only: what the screen's output costs, each part timed alone (docs/clean-room-basic.md section 2): bb13b cas-echo-5
# shows its passes (CLS, 15 numbers printed, a PRINT on the bottom row that moves the screen up, CLS) about 0.8 field
# faster on ours than on the original. In fields counted by TIMER, as time-int times its loops, each loop 300 passes
# started just after a field begins (300-320): the empty loop; CLS; CLS and 32 letters (no carriage return: the
# cursor ends on the second row); CLS and a number (PRINT I;); CLS and a carriage return; and, with the cursor on the
# bottom row, a carriage return alone (each moves the screen up a row). The counts are printed at the end on a
# cleared screen. Syntax [UM]; the counts [BB].
#timeout 300
10 DIM T(9):A$="ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"
20 GOSUB 300:FOR I=1 TO 300:NEXT:T(0)=TIMER
30 GOSUB 300:FOR I=1 TO 300:CLS:NEXT:T(1)=TIMER
40 GOSUB 300:FOR I=1 TO 300:CLS:PRINT A$;:NEXT:T(2)=TIMER
50 GOSUB 300:FOR I=1 TO 300:CLS:PRINT I;:NEXT:T(3)=TIMER
60 GOSUB 300:FOR I=1 TO 300:CLS:PRINT:NEXT:T(4)=TIMER
70 CLS:FOR I=1 TO 15:PRINT:NEXT
80 GOSUB 300:FOR I=1 TO 300:PRINT:NEXT:T(5)=TIMER
90 CLS:FOR J=0 TO 5:PRINT T(J);:NEXT:PRINT:END
300 W=TIMER
310 IF TIMER=W THEN 310
320 TIMER=0:RETURN
RUN
