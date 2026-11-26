# bb-only: RND's argument (docs/clean-room-basic.md section 5; open question 5): each of 19 arguments from each of 9
# seeds set by POKE at $0116-$0119 (where bb8 rnd-seq found the seed), chosen (by the generator inferred from bb8) so
# the next state gives a fraction just at 1/3, 2/3, .8 and .4, all ones, and next states $00123456, 0, $00001234 and
# $00000012 (leading zero bytes, and none at all: how the fraction is normalised and rounded). Each line: seed number, argument, the result, its five bytes as stored
# (R is the program's first variable: its value is at the variable table's start + 2, $1B-1C [BB bb3]), then the five
# bytes at $0115-$0119 after the call. Whole and fractional arguments, below one, near the boundaries of whole
# numbers and of the floating-point precision: whether the argument is taken whole before scaling, the order of the
# product, INT and the +1, and whether every argument moves the seed one step. Low RAM is POKEd
# only at RND's bytes ($0115-$0119) and address 4, through "AND 32767" (bb-only, reviewed by hand). Syntax [UM]; the
# values [BB].
#timeout 600
10 R=0:V=PEEK(27)*256+PEEK(28)+2:DIM A(19),S(9,3)
20 FOR I=1 TO 19:READ A(I):NEXT:FOR J=1 TO 9:FOR K=0 TO 3:READ S(J,K):NEXT:NEXT
30 FOR J=1 TO 9:FOR I=1 TO 19:FOR K=0 TO 3:POKE 278+K AND 32767,S(J,K):NEXT
40 R=RND(A(I)):PRINT J;A(I);R:GOSUB 900:NEXT:NEXT:END
50 DATA 0,1,2,3,6,.1,.5,.999,1.1,1.5,2.5,3.9,2.999999,65535,1E9,4294967295,4294967296,1E10,1E38
60 DATA 208,20,65,94,51,182,42,93,142,195,186,195,125,155,9,145,151,88,19,92,51,128,35,97
70 DATA 108,114,88,95,142,162,146,251,104,75,50,149
900 FOR K=0 TO 4:PRINT MID$(STR$(PEEK(V+K AND 32767)),2);",";:NEXT:PRINT "/";
910 FOR K=277 TO 281:PRINT MID$(STR$(PEEK(K AND 32767)),2);",";:NEXT:PRINT:RETURN
RUN
