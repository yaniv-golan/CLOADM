# bb-only: what moves $25-26 (docs/clean-room-basic.md section 15). ram-pointers2 (2026-11-26) showed it 32767 after
# NEW and CLEAR and, in direct mode, at the newest string after A$="HELLO", B$=A$+"!" and LEFT$, but unmoved by a
# program's B$=A$+"C". Here each kind of string is made once in direct mode and once in a program, and $25-26 is
# printed with $23-24 after each: a literal (copied in direct mode, not in a program), a plain copy of a variable
# (no new string), a join, STR$, CHR$, LEFT$, a temporary in PRINT only, and an INPUT reply; then after RUN and
# CLEAR. Each value 16-bit big-endian. Syntax [UM]; the addresses' meaning [DOC] and ram-pointers2; the values [BB].
#timeout 60
NEW
CLEAR 200
PRINT "S";PEEK(37)*256+PEEK(38);PEEK(35)*256+PEEK(36)
A$="AB":PRINT "L";PEEK(37)*256+PEEK(38);PEEK(35)*256+PEEK(36)
B$=A$:PRINT "V";PEEK(37)*256+PEEK(38);PEEK(35)*256+PEEK(36)
C$=A$+A$:PRINT "J";PEEK(37)*256+PEEK(38);PEEK(35)*256+PEEK(36)
D$=STR$(5):PRINT "N";PEEK(37)*256+PEEK(38);PEEK(35)*256+PEEK(36)
E$=CHR$(65):PRINT "C";PEEK(37)*256+PEEK(38);PEEK(35)*256+PEEK(36)
F$=LEFT$(C$,3):PRINT "F";PEEK(37)*256+PEEK(38);PEEK(35)*256+PEEK(36)
PRINT A$+"Z";"T";PEEK(37)*256+PEEK(38);PEEK(35)*256+PEEK(36)
10 PRINT "R";PEEK(37)*256+PEEK(38);PEEK(35)*256+PEEK(36)
20 A$="AB":PRINT "L";PEEK(37)*256+PEEK(38);PEEK(35)*256+PEEK(36)
30 B$=A$:PRINT "V";PEEK(37)*256+PEEK(38);PEEK(35)*256+PEEK(36)
40 C$=A$+A$:PRINT "J";PEEK(37)*256+PEEK(38);PEEK(35)*256+PEEK(36)
50 D$=STR$(5):PRINT "N";PEEK(37)*256+PEEK(38);PEEK(35)*256+PEEK(36)
60 E$=CHR$(65):PRINT "C";PEEK(37)*256+PEEK(38);PEEK(35)*256+PEEK(36)
70 F$=LEFT$(C$,3):PRINT "F";PEEK(37)*256+PEEK(38);PEEK(35)*256+PEEK(36)
80 PRINT A$+"Z";"T";PEEK(37)*256+PEEK(38);PEEK(35)*256+PEEK(36)
90 INPUT G$:PRINT "I";PEEK(37)*256+PEEK(38);PEEK(35)*256+PEEK(36)
#nowait
RUN
#type QQ\n
#wait-text ^OK(?![\s\S])
PRINT "D";PEEK(37)*256+PEEK(38);PEEK(35)*256+PEEK(36)
CLEAR 100:PRINT "K";PEEK(37)*256+PEEK(38);PEEK(35)*256+PEEK(36)
