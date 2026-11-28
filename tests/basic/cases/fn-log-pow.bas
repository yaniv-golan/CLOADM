# bb-only: LOG's reduction and ^ with a whole exponent, by their bytes (docs/clean-room-basic.md section 5, open
# question 12): LOG at 1, 4, 8, .25 and .125 (ours gives LOG(1) as ln 2 x 2^-32, from the reduction that gives the
# original's LOG(.5) and LOG(2) one unit either side of ln 2: is the original's LOG(1) 0?); LOG of .5 to 1 in steps
# of 1/16 and at 1.0001, .9999, 1.01, .99; then X^Y for X = 2, 3, 10 and Y = 2, 3, 10, 20, 30, 60, 66, -1, -2, .5,
# 0^0, 0^2 and (-2)^3, (-2)^2 (is a whole power ever exact, and which: bb10 num-print-big has 2^60 exact and 2^66
# not). Each value is stored in R, the program's first variable, and its five bytes read from the variable table
# (PEEK(27), PEEK(28): its start), as fn-last-bit does. Syntax [UM]; the bytes [BB].
#timeout 120
10 R=0:V=PEEK(27)*256+PEEK(28)+2
20 READ A:IF A=-9 THEN 40
30 R=LOG(A):PRINT "L";A;:GOSUB 900:GOTO 20
40 READ A,B:IF A=-9 THEN END
50 R=A^B:PRINT A;B;:GOSUB 900:GOTO 40
100 DATA 1,4,8,.25,.125,.5,.5625,.625,.6875,.75,.8125,.875,.9375,1.0001,.9999,1.01,.99,-9
110 DATA 2,2,2,3,2,10,2,20,2,30,2,60,2,66,2,-1,2,-2,2,.5
120 DATA 3,2,3,3,3,10,3,20,3,30,3,-1,3,-2,3,.5
130 DATA 10,2,10,3,10,10,10,20,10,30,10,-1,10,-2,10,.5
140 DATA 0,0,0,2,-2,3,-2,2,-9,0
900 FOR K=0 TO 4:PRINT MID$(STR$(PEEK(V+K AND 32767)),2);",";:NEXT:PRINT:RETURN
RUN
