# bb-only: how decimal numbers are stored (docs/clean-room-basic.md section 5): the five bytes of each number READ
# from DATA into R (the program's first variable: its value is at the variable table's start + 2, $1B-1C [BB bb3],
# as rnd-args finds it), with the value printed. Large and small exponents, the largest and smallest values near
# the limits, decimals that are not exact in binary, nine and ten digits, and numbers that round in the last bit.
# Then some of them given as literals in a statement (R=..., after RUN 30, which finds R's place again), and the ones that may overflow or underflow, each
# READ on a line of its own (S: how many DATA items to skip), so an error stops only that line. Low RAM is PEEKed
# only at $1B-1C (literal) and at R's own five bytes through "AND 32767" (bb-only, reviewed by hand). Syntax [UM];
# the bytes [BB].
#timeout 120
10 R=0:V=PEEK(27)*256+PEEK(28)+2
20 FOR J=1 TO 30:READ R:PRINT J;R;:GOSUB 900:NEXT:END
30 R=0:V=PEEK(27)*256+PEEK(28)+2:R=1E30:GOSUB 900:R=-2.5E-10:GOSUB 900:R=12345.678:GOSUB 900
35 R=1E-30:GOSUB 900:R=1E38:GOSUB 900
40 R=.1:GOSUB 900:R=.3:GOSUB 900:R=123456789:GOSUB 900:R=1234567890:GOSUB 900:R=4294967295:GOSUB 900:END
100 DATA 1E30,-2.5E-10,12345.678,1E-30,1E38,1.7E38,1E-38,.1,.2,.3,.7,1.1,3.14159265,2.71828183,123456789
110 DATA 1234567890,999999999,9999999999,4294967295,4294967296,65535.5,1E10,1E-10,.000001,1.23456789E-20
120 DATA 9.99999999E37,-0,1E-37,5E-39,123.456789
130 DATA 1.70141183E38,2.9E-39,1E-39,1E-40,1.7014119E38,1E39
200 RESTORE:FOR J=1 TO S:READ R:NEXT:READ R:PRINT R;:GOSUB 900:END
900 FOR K=0 TO 4:PRINT MID$(STR$(PEEK(V+K AND 32767)),2);",";:NEXT:PRINT:RETURN
RUN
RUN 30
S=30:GOTO 200
S=31:GOTO 200
S=32:GOTO 200
S=33:GOTO 200
S=34:GOTO 200
S=35:GOTO 200
R=1.70141183E38:GOSUB 900
R=1E-39:GOSUB 900
R=1E39:GOSUB 900
