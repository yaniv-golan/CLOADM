# bb-only: BASIC's pointers in low RAM as a program reads them (docs/clean-room-basic.md section 15), to confirm the
# [DOC] leads from published memory maps (which may contain errors): $19-1A the program's start, $1B-1C the simple
# variables', $1D-1E the arrays', $1F-20 the end of the arrays, $21-22 and $23-24 string space's bottom and its
# next free string, $27-28 the top of BASIC's memory (CLEAR), $68-69 the line running ($FFFF direct), $A6-A7 the
# text pointer, $0112-0113 TIMER, $71 the restart flag. Each value 16-bit big-endian, printed with its address as
# a label, at several states: after NEW, a 3-line program typed, variables and an array, strings, CLEAR 500 and
# PCLEAR 2; then the line and text pointer from inside a running program on known lines, TIMER against its bytes,
# and $71 at the prompt. Syntax [UM]; the addresses' meaning [DOC]; the values [BB].
#timeout 60
NEW
PRINT "19";PEEK(25)*256+PEEK(26);"1B";PEEK(27)*256+PEEK(28);"1D";PEEK(29)*256+PEEK(30)
PRINT "1F";PEEK(31)*256+PEEK(32);"21";PEEK(33)*256+PEEK(34);"23";PEEK(35)*256+PEEK(36)
PRINT "27";PEEK(39)*256+PEEK(40);"MEM";MEM
10 A=1
20 B$="X"
30 PRINT A
PRINT "19";PEEK(25)*256+PEEK(26);"1B";PEEK(27)*256+PEEK(28);"1D";PEEK(29)*256+PEEK(30)
PRINT "1F";PEEK(31)*256+PEEK(32);"21";PEEK(33)*256+PEEK(34);"23";PEEK(35)*256+PEEK(36)
PRINT "27";PEEK(39)*256+PEEK(40);"MEM";MEM
A=5:B=6:DIM C(10)
PRINT "19";PEEK(25)*256+PEEK(26);"1B";PEEK(27)*256+PEEK(28);"1D";PEEK(29)*256+PEEK(30)
PRINT "1F";PEEK(31)*256+PEEK(32);"21";PEEK(33)*256+PEEK(34);"23";PEEK(35)*256+PEEK(36)
PRINT "27";PEEK(39)*256+PEEK(40);"MEM";MEM
A$="HELLO":B$=A$+"!"
PRINT "19";PEEK(25)*256+PEEK(26);"1B";PEEK(27)*256+PEEK(28);"1D";PEEK(29)*256+PEEK(30)
PRINT "1F";PEEK(31)*256+PEEK(32);"21";PEEK(33)*256+PEEK(34);"23";PEEK(35)*256+PEEK(36)
PRINT "27";PEEK(39)*256+PEEK(40);"MEM";MEM
CLEAR 500
PRINT "19";PEEK(25)*256+PEEK(26);"1B";PEEK(27)*256+PEEK(28);"1D";PEEK(29)*256+PEEK(30)
PRINT "1F";PEEK(31)*256+PEEK(32);"21";PEEK(33)*256+PEEK(34);"23";PEEK(35)*256+PEEK(36)
PRINT "27";PEEK(39)*256+PEEK(40);"MEM";MEM
PCLEAR 2
PRINT "19";PEEK(25)*256+PEEK(26);"1B";PEEK(27)*256+PEEK(28);"1D";PEEK(29)*256+PEEK(30)
PRINT "1F";PEEK(31)*256+PEEK(32);"21";PEEK(33)*256+PEEK(34);"23";PEEK(35)*256+PEEK(36)
PRINT "27";PEEK(39)*256+PEEK(40);"MEM";MEM
NEW
100 PRINT "L";PEEK(104)*256+PEEK(105);"T";PEEK(166)*256+PEEK(167)
200 PRINT "L";PEEK(104)*256+PEEK(105):PRINT "T";PEEK(166)*256+PEEK(167)
300 GOSUB 1000:PRINT "L";PEEK(104)*256+PEEK(105);"19";PEEK(25)*256+PEEK(26)
400 H=PEEK(274):L=PEEK(275):T=TIMER:PRINT "TI";T;"112";H*256+L
500 TIMER=1000:H=PEEK(274):L=PEEK(275):PRINT "TI";TIMER;"112";H*256+L
600 END
1000 PRINT "L";PEEK(104)*256+PEEK(105):RETURN
RUN
PRINT "L";PEEK(104)*256+PEEK(105);"T";PEEK(166)*256+PEEK(167)
PRINT "71";PEEK(113)
