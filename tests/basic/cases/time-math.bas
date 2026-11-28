# bb-only: what EXP, LOG, SQR and ^ cost on the original (docs/clean-room-basic.md section 5), so that ours can be
# made never faster by the original's own numbers (ours works ^ as EXP(y LOG |x|), as bb13c fn-log-pow showed the
# original's does, and SQR through it). In fields counted by TIMER, as time-screen times its loops, each loop
# started just after a field begins (300-320): the empty loop (A=X) for its own cost, then A=EXP(X) with X=2,
# A=LOG(Y) with Y=.625, A=SQR(Z) with Z=3, A=Z^H with H=.5 and A=X^N with N=10, each loop of P passes. The counts
# are printed at the end on a cleared screen. Syntax [UM]; the counts [BB].
#timeout 300
10 DIM T(9):X=2:Y=.625:Z=3:H=.5:N=10:P=120
20 GOSUB 300:FOR I=1 TO P:A=X:NEXT:T(0)=TIMER
30 GOSUB 300:FOR I=1 TO P:A=EXP(X):NEXT:T(1)=TIMER
40 GOSUB 300:FOR I=1 TO P:A=LOG(Y):NEXT:T(2)=TIMER
50 GOSUB 300:FOR I=1 TO P:A=SQR(Z):NEXT:T(3)=TIMER
60 GOSUB 300:FOR I=1 TO P:A=Z^H:NEXT:T(4)=TIMER
70 GOSUB 300:FOR I=1 TO P:A=X^N:NEXT:T(5)=TIMER
80 CLS:FOR J=0 TO 5:PRINT T(J);:NEXT:PRINT:END
300 W=TIMER
310 IF TIMER=W THEN 310
320 TIMER=0:RETURN
RUN
