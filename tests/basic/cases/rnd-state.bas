# bb-only: RND's state in RAM (docs/clean-room-basic.md sections 5 and 15; open question 5). At cold start, before
# anything runs: $0115-$0119 (bb8 rnd-seq saw RND change 278-281 and 4) and whether address 4 is 0. Then from one seed
# set by POKE, each of $0115-$0119 changed alone before an RND(0): the result's five bytes and the five bytes after
# (which bytes take part, and which RND writes). Address 4 set to 77 before RND(0): whether RND changes it, and
# whether it is then 0 (only that, not its value). And the seed bytes after NEW, after CLEAR, and as RUN starts a
# program. R is the program's first variable [BB bb3]. Low RAM is POKEd
# only at RND's bytes ($0115-$0119) and address 4, through "AND 32767" (bb-only, reviewed by hand). Syntax [UM]; the
# values [BB].
#timeout 120
PRINT PEEK(277);PEEK(278);PEEK(279);PEEK(280);PEEK(281);PEEK(4)=0
10 R=0:V=PEEK(27)*256+PEEK(28)+2
20 FOR J=277 TO 281:GOSUB 800:POKE J AND 32767,(PEEK(J AND 32767)+85) AND 255:R=RND(0):PRINT J;R:GOSUB 900:NEXT
30 GOSUB 800:R=RND(0):PRINT "BASE";R:GOSUB 900
40 POKE 4 AND 32767,77:R=RND(0):PRINT "ADDR 4";PEEK(4)=77;PEEK(4)=0
50 END
800 POKE 277 AND 32767,0:POKE 278 AND 32767,208:POKE 279 AND 32767,20:POKE 280 AND 32767,65:POKE 281 AND 32767,94:RETURN
900 FOR K=0 TO 4:PRINT MID$(STR$(PEEK(V+K AND 32767)),2);",";:NEXT:PRINT "/";
910 FOR K=277 TO 281:PRINT MID$(STR$(PEEK(K AND 32767)),2);",";:NEXT:PRINT:RETURN
RUN
POKE 278 AND 32767,1:POKE 279 AND 32767,2:POKE 280 AND 32767,3:POKE 281 AND 32767,4
NEW
PRINT PEEK(277);PEEK(278);PEEK(279);PEEK(280);PEEK(281)
CLEAR 300
PRINT PEEK(277);PEEK(278);PEEK(279);PEEK(280);PEEK(281)
10 PRINT PEEK(277);PEEK(278);PEEK(279);PEEK(280);PEEK(281)
RUN
