# bb-only: RND's sequence (docs/clean-room-basic.md section 10, open question 5: whether the original's generator can
# be inferred from black-box output; it was: ours gives the same values, tests/basic-rnd.test.js). Each value is
# printed and with the five bytes R holds
# (R is the program's first variable, so its value is the 3rd to 7th bytes at the variable table, whose address is at
# $1B-1C [BB bb3 ram-pointers]): from cold start, the first 200 values of RND(0) (a fraction [UM]); 5 of RND(1) (whole
# numbers 1 to 1: whether they use up values of the sequence shows in the next RND(0)) and 5 more of RND(0); 20 each of
# RND(6), RND(100) and RND(65535); after each of RND(-1), RND(-2) and RND(-12345) (its own value too) the next 50 of
# RND(0), and after RND(-1) again 10 more (does a reseed repeat?). Then which bytes of RAM below the text screen
# ($0000-$03FF) one SIN(1) changes, and which one RND(0) changes: the addresses SIN changes too, and the others (the
# seed should be among them). Addresses only, never the bytes' values: a value read from a scratch byte could be a
# constant the function loaded. Syntax [UM]; the values [BB].
#timeout 600
10 R=0:V=PEEK(27)*256+PEEK(28)+2:DIM A(1023),C(60),S(1023)
20 FOR I=1 TO 200:R=RND(0):GOSUB 900:NEXT
30 PRINT "RND(1)":FOR I=1 TO 5:R=RND(1):GOSUB 900:NEXT:PRINT "RND(0)":FOR I=1 TO 5:R=RND(0):GOSUB 900:NEXT
40 FOR N=1 TO 3:READ M:PRINT "RND(";M;")":FOR I=1 TO 20:R=RND(M):GOSUB 900:NEXT:NEXT
50 DATA 6,100,65535
60 FOR N=1 TO 3:READ M:R=RND(M):PRINT "RND(";M;")":GOSUB 900:FOR I=1 TO 50:R=RND(0):GOSUB 900:NEXT:NEXT
70 DATA -1,-2,-12345
80 R=RND(-1):PRINT "AGAIN":GOSUB 900:FOR I=1 TO 10:R=RND(0):GOSUB 900:NEXT
90 PRINT "SIN CHANGES":GOSUB 800:R=SIN(1):GOSUB 820:FOR J=1 TO K:S(C(J))=1:PRINT C(J);:NEXT:PRINT
100 PRINT "RND, SIN TOO":GOSUB 800:R=RND(0):GOSUB 820:FOR J=1 TO K:IF S(C(J)) THEN PRINT C(J);
105 NEXT:PRINT:PRINT "RND ONLY":FOR J=1 TO K:IF S(C(J))=0 THEN PRINT C(J);
110 NEXT:PRINT:END
800 FOR J=0 TO 1023:A(J)=PEEK(J AND 32767):NEXT:RETURN
820 K=0:FOR J=0 TO 1023:IF K<60 THEN IF A(J)<>PEEK(J AND 32767) THEN K=K+1:C(K)=J
830 NEXT:RETURN
900 PRINT R;:FOR K=0 TO 4:PRINT MID$(STR$(PEEK(V+K AND 32767)),2);",";:NEXT:PRINT:RETURN
RUN
