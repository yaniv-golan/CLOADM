# bb-only: how long the printer's bytes take, the printer ready (docs/clean-room-basic.md section 13): bb13a
# stmt-printer's TIMER=0:PRINT #-2,"0123456789":PRINT TIMER counts 1 field on the original and 0 on ours. In fields
# counted by TIMER, each started just after a field begins (300-320): the empty loop of ten for its own cost, then
# 300 bytes through PRINT #-2 (ten lines of 29 letters and a carriage return). Then LLIST 1-9 typed after TIMER=0
# (nine lines of 28 bytes as LIST shows them and a carriage return: 261 bytes), and TIMER printed by the next typed
# line, as LLIST ends its own line (bb13c stmt-list-end): that count holds the typing of PRINT TIMER too. The
# printer's bytes are the record's printer. Syntax [UM]; the counts and bytes [BB].
#timeout 120
1 REM AAAAAAAAAAAAAAAAAAAAAA
2 REM AAAAAAAAAAAAAAAAAAAAAA
3 REM AAAAAAAAAAAAAAAAAAAAAA
4 REM AAAAAAAAAAAAAAAAAAAAAA
5 REM AAAAAAAAAAAAAAAAAAAAAA
6 REM AAAAAAAAAAAAAAAAAAAAAA
7 REM AAAAAAAAAAAAAAAAAAAAAA
8 REM AAAAAAAAAAAAAAAAAAAAAA
9 REM AAAAAAAAAAAAAAAAAAAAAA
10 A$="ABCDEFGHIJKLMNOPQRSTUVWXYZABC":GOSUB 300:FOR I=1 TO 10:NEXT:E=TIMER
20 GOSUB 300:FOR I=1 TO 10:PRINT #-2,A$:NEXT:P=TIMER
30 PRINT E;P:END
300 W=TIMER
310 IF TIMER=W THEN 310
320 TIMER=0:RETURN
RUN
TIMER=0:LLIST 1-9
PRINT TIMER
