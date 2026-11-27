# bb-only: printing numbers of 1E17 and more (docs/clean-room-basic.md section 5, provenance item 56): bb9 rnd-args'
# seed 3 gave RND(1E38) as the bytes 254,112,189,194,29, which the original printed as 8E+37 and ours as
# 8.00000001E+37. Each value is put in R (the program's first variable: its value is at the variable table's start
# + 2, $1B-1C [BB bb3], as rnd-args finds it) and printed with its five bytes: literals from 1E17 to 1.7E38, products
# and quotients that land there, that RND(1E38) from seed 3 (POKEd at 278-281 as rnd-args does), and the same five
# bytes POKEd into R. Then PRINT USING of numbers from 2^66 (about 7.4E19) up, where ours prints % and the number
# scaled by its decimals without its sign [OWN]: one statement a line, so an error stops only its own. Low RAM is
# PEEKed only at $1B-1C (literal), and PEEKed and POKEd only at R's own five bytes and RND's seed at 278-281, through
# "AND 32767" (bb-only, reviewed by hand). Syntax [UM]; the output [BB].
#timeout 120
10 R=0:V=PEEK(27)*256+PEEK(28)+2
20 FOR J=1 TO 22:READ R:PRINT R;:GOSUB 900:NEXT
30 R=1E17*3:GOSUB 800:R=8E37/1E20*1E20:GOSUB 800:R=2^60:GOSUB 800:R=2^66:GOSUB 800:R=2^126:GOSUB 800
40 FOR K=0 TO 3:READ S:POKE 278+K AND 32767,S:NEXT:R=RND(1E38):GOSUB 800
50 FOR K=0 TO 4:READ S:POKE V+K AND 32767,S:NEXT:GOSUB 800
60 END
70 DATA 1E17,1.5E17,9.99999999E17,1E18,123456789E10,1E19,7E19,1E20,1.23456789E25,3E30,1E35
75 DATA 7E37,7.9E37,8E37,8.00000001E37,8.5E37,9E37,9.99999999E37,1E38,1.5E38,1.7E38,-8E37
80 DATA 142,195,186,195
85 DATA 254,112,189,194,29
800 PRINT R;
900 FOR K=0 TO 4:PRINT MID$(STR$(PEEK(V+K AND 32767)),2);",";:NEXT:PRINT:RETURN
RUN
PRINT USING "##";7E19
PRINT USING "##";8E19
PRINT USING "##";1E21
PRINT USING "##";-1E21
PRINT USING "##.##";1E20
PRINT USING "##.##";-1E30
PRINT USING "#####.##";-7.4E19
PRINT USING "##,###";1E25
PRINT USING "**$##.##";1E22
PRINT USING "+##";1E21
PRINT USING "##-";-1E21
