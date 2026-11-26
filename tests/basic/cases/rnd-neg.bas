# bb-only: RND with a negative or zero argument (docs/clean-room-basic.md section 5; open question 5). From one seed
# set by POKE each time, RND(x) for negative x of different mantissas, exponents and repeats (-1, -2, -4 and -.5 differ
# only by powers of two; -3 and -1.5 likewise; -12345 twice), then two RND(0). Each line: the argument, the result
# and its five bytes, the seed bytes $0115-$0119 after it, then the two RND(0) results and bytes. Then zero in its
# forms: 0, -0, 1-1, and a variable whose exponent byte is POKEd to 0 (its mantissa left as 5's, and also with its
# sign bit set): whether RND treats each as zero. R and Z are the program's first two variables, so their values are
# at the variable table's start + 2 and + 9 [BB bb3]. Low RAM is POKEd
# only at RND's bytes ($0115-$0119) and address 4, through "AND 32767" (bb-only, reviewed by hand). Syntax [UM]; the
# values [BB].
#timeout 300
10 R=0:Z=0:V=PEEK(27)*256+PEEK(28)+2:DIM A(16)
20 FOR I=1 TO 16:READ A(I):NEXT
30 FOR I=1 TO 16:GOSUB 800:R=RND(A(I)):PRINT A(I);R:GOSUB 900:GOSUB 950:NEXT
40 GOSUB 800:R=RND(0):PRINT "0";R:GOSUB 900:GOSUB 950
50 GOSUB 800:R=RND(-0):PRINT "-0";R:GOSUB 900:GOSUB 950
60 GOSUB 800:R=RND(1-1):PRINT "1-1";R:GOSUB 900:GOSUB 950
70 Z=5:POKE V+7 AND 32767,0:GOSUB 800:R=RND(Z):PRINT "E0";R:GOSUB 900:GOSUB 950
80 Z=-5:POKE V+7 AND 32767,0:GOSUB 800:R=RND(Z):PRINT "-E0";R:GOSUB 900:GOSUB 950
90 END
100 DATA -1,-2,-4,-.5,-3,-1.5,-6,-12345,-12345,-24690,-1E-30,-1E30,-1.00000001,-65535,-4294967295,-.999999999
800 POKE 278 AND 32767,208:POKE 279 AND 32767,20:POKE 280 AND 32767,65:POKE 281 AND 32767,94:RETURN
900 FOR K=0 TO 4:PRINT MID$(STR$(PEEK(V+K AND 32767)),2);",";:NEXT:PRINT "/";
910 FOR K=277 TO 281:PRINT MID$(STR$(PEEK(K AND 32767)),2);",";:NEXT:PRINT:RETURN
950 FOR N=1 TO 2:R=RND(0):PRINT R;:GOSUB 900:NEXT:RETURN
RUN
