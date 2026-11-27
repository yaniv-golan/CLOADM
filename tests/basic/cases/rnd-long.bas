# bb-only: 10,000 consecutive RND(0) from cold start's seed, then 2,000 each from the seeds 0 and $FFFFFFFF set by
# POKE (docs/clean-room-basic.md section 5; open question 5): every result's five bytes folded into a checksum
# (S=S*7+byte, mod 65521), printed with the seed bytes $0115-$0119 each 2,000 calls. R is the program's first variable [BB bb3].
# Low RAM is POKEd
# only at RND's seed bytes (278-281, $0116-$0119), and PEEKed only there, at $0115, $1B-1C and R's own bytes, through
# "AND 32767" (bb-only, reviewed by hand). Syntax [UM]; the
# values [BB]. bb9's run reached the #timeout (then 2700) after the first block: 10,000 calls take about 2,700
# seconds on the original, and 12,000 more than 2,700, so the whole run 3,800 or more; ours takes about 3,110.
#timeout 6000
10 R=0:S=0:V=PEEK(27)*256+PEEK(28)+2
20 FOR J=1 TO 3:S=0:IF J=2 THEN FOR K=278 TO 281:POKE K AND 32767,0:NEXT
30 IF J=3 THEN FOR K=278 TO 281:POKE K AND 32767,255:NEXT
40 N=10000:IF J>1 THEN N=2000
45 FOR I=1 TO N:R=RND(0):FOR K=0 TO 4:S=S*7+PEEK(V+K AND 32767):S=S-INT(S/65521)*65521:NEXT
50 IF I/2000=INT(I/2000) THEN PRINT J;I;S;PEEK(277);PEEK(278);PEEK(279);PEEK(280);PEEK(281)
60 NEXT:NEXT
RUN
