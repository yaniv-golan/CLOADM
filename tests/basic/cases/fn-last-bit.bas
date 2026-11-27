# bb-only: the last bits of SIN, COS, TAN, LOG, EXP and SQR, with ATN as a control (docs/clean-room-basic.md section
# 5): for each function a spread of arguments, the result put in R (the program's first variable: its value is at
# the variable table's start + 2, $1B-1C [BB bb3]) and its five bytes printed, after the function's number (1 SIN,
# 2 COS, 3 TAN, 4 LOG, 5 EXP, 6 SQR, 7 ATN) and the argument. Low RAM is PEEKed only at $1B-1C (literal) and at R's
# own five bytes through "AND 32767" (bb-only, reviewed by hand). Syntax [UM]; the bytes [BB].
#timeout 300
10 R=0:V=PEEK(27)*256+PEEK(28)+2
20 READ F,N:IF F=0 THEN END
30 FOR J=1 TO N:READ A:ON F GOSUB 101,102,103,104,105,106,107:PRINT F;A;:GOSUB 900:NEXT:GOTO 20
101 R=SIN(A):RETURN
102 R=COS(A):RETURN
103 R=TAN(A):RETURN
104 R=LOG(A):RETURN
105 R=EXP(A):RETURN
106 R=SQR(A):RETURN
107 R=ATN(A):RETURN
200 DATA 1,13,.001,.1,.5,1,1.5,2,3,3.14159265,4,6,10,100,-.7
210 DATA 2,13,.001,.1,.5,1,1.5,2,3,3.14159265,4,6,10,100,-.7
220 DATA 3,13,.001,.1,.5,1,1.5,2,3,3.14159265,4,6,10,100,-.7
230 DATA 4,13,.001,.1,.5,.9,1.1,2,3,10,100,1E10,1E-10,1E30,12345
240 DATA 5,13,-50,-10,-1,-.5,.001,.1,.5,1,2,10,50,80,-80
250 DATA 6,13,.001,.1,.5,2,3,5,10,99,12345,1E10,1E-10,1E30,2.25
260 DATA 7,13,.001,.1,.5,1,2,3,10,100,-1,1E10,1E-10,.7,-.7
270 DATA 0,0
900 FOR K=0 TO 4:PRINT MID$(STR$(PEEK(V+K AND 32767)),2);",";:NEXT:PRINT:RETURN
RUN
