# bb-only: the second probe of BASIC's RAM where programs see it (docs/clean-room-basic.md section 15), for what
# ram-pointers (bb3) left open. $25-26: its value at several states (after NEW; after strings made in direct mode
# and in a program, a temporary string in an expression, CLEAR; inside a FOR loop; after a numeric assignment), each
# beside $21-22 and $23-24, to see what it follows. The input buffers' places: the text pointer ($A6-A7) in direct
# mode at three known places in the typed line, and a search of RAM below the text screen ($0000-$03FF) for a marker
# in a typed line (QZ, in a REM; the line prints each address where it starts, with no IF, which would skip
# the NEXT) and in a reply to INPUT (QJ). TIMER's bytes, phase-proof: read until no field
# passed while the bytes were read (TD, the bytes less TIMER: 0), and after POKEing 1 and 2 (TP: the high byte, and
# whether TIMER is then 258 to 307). Last, how fast the interpreter runs typical loops, in fields counted by TIMER:
# an empty FOR loop (2000 passes, as famous-pokes times it), an addition, a product and a quotient with a constant,
# STR$, GOSUB and RETURN, an IF ... THEN back to its own line, and MID$ joined to a literal, each started just
# after a field begins (300-320), so where in a field it starts cannot move its count (only the counts are
# compared, to tell where ours is faster or slower than the original). Low RAM is POKEd only at TIMER's two bytes,
# through "AND 32767" (bb-only, reviewed by hand). Syntax [UM]; the addresses' meaning [DOC] and bb3; the values [BB].
#timeout 120
NEW
PRINT "25";PEEK(37)*256+PEEK(38);"21";PEEK(33)*256+PEEK(34);"23";PEEK(35)*256+PEEK(36)
A$="HELLO"
PRINT "25";PEEK(37)*256+PEEK(38);"21";PEEK(33)*256+PEEK(34);"23";PEEK(35)*256+PEEK(36)
B$=A$+"!"
PRINT "25";PEEK(37)*256+PEEK(38);"21";PEEK(33)*256+PEEK(34);"23";PEEK(35)*256+PEEK(36)
C$=LEFT$(B$,3)
PRINT "25";PEEK(37)*256+PEEK(38);"21";PEEK(33)*256+PEEK(34);"23";PEEK(35)*256+PEEK(36)
PRINT LEN(A$+B$);"25";PEEK(37)*256+PEEK(38)
FOR I=1 TO 2:PRINT "25";PEEK(37)*256+PEEK(38):NEXT
X=5:PRINT "25";PEEK(37)*256+PEEK(38)
CLEAR 300
PRINT "25";PEEK(37)*256+PEEK(38);"21";PEEK(33)*256+PEEK(34);"23";PEEK(35)*256+PEEK(36)
10 A$="AB":B$=A$+"C"
20 PRINT "25";PEEK(37)*256+PEEK(38);"21";PEEK(33)*256+PEEK(34);"23";PEEK(35)*256+PEEK(36)
RUN
NEW
PRINT "T";PEEK(166)*256+PEEK(167)
X=0:PRINT "T";PEEK(166)*256+PEEK(167)
X=0:Y=0:PRINT "T";PEEK(166)*256+PEEK(167)
FOR I=0 TO 1022:P=(PEEK(I AND 32767)=81)AND(PEEK(I+1 AND 32767)=90):PRINT LEFT$(STR$(I),-6*P);:NEXT:REM QZ
PRINT "DONE"
10 INPUT A$
20 FOR I=0 TO 1022:IF PEEK(I AND 32767)=81 THEN IF PEEK(I+1 AND 32767)=74 THEN PRINT I;
30 NEXT:PRINT "DONE"
#nowait
RUN
#type QJ\n
#wait-text ^OK(?![\s\S])
NEW
10 T=TIMER:H=PEEK(274):L=PEEK(275):U=TIMER:IF T<>U THEN 10
20 PRINT "TD";H*256+L-T
30 POKE 274 AND 32767,1:POKE 275 AND 32767,2:T=TIMER:H=PEEK(274):PRINT "TP";H;T>=258 AND T<308
RUN
NEW
10 GOSUB 300:FOR I=1 TO 2000:NEXT:A=TIMER
20 GOSUB 300:FOR I=1 TO 500:X=I+2.5:NEXT:B=TIMER
30 GOSUB 300:FOR I=1 TO 500:X=I*2.5:NEXT:C=TIMER
40 GOSUB 300:FOR I=1 TO 500:X=I/3:NEXT:D=TIMER
50 GOSUB 300:FOR I=1 TO 300:A$=STR$(I):NEXT:E=TIMER
60 GOSUB 300:FOR I=1 TO 500:GOSUB 200:NEXT:F=TIMER
70 GOSUB 300:I=0
80 I=I+1:IF I<1000 THEN 80
90 G=TIMER:GOSUB 300:FOR I=1 TO 300:B$=MID$("HELLO",2,2)+"X":NEXT:H=TIMER
100 PRINT "FOR";A;"ADD";B;"MUL";C;"DIV";D
110 PRINT "STR";E;"GOSUB";F;"IF";G;"MID";H
120 END
200 RETURN
300 W=TIMER
310 IF TIMER=W THEN 310
320 TIMER=0:RETURN
RUN
