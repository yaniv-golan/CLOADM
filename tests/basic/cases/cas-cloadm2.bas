# bb-only: CLOADM's addresses (docs/clean-room-basic.md section 12, open question 10), with the fixture mc-big (our
# own machine code, never run: MCX, six bytes loading at $7000 whose exec address is $7005; BIGMC, 600 bytes at
# $7100 in three blocks). Where BASIC keeps the exec address is not known, so the program searches RAM below the text
# screen ($0000-$03FF) for its two bytes, $70 $05, and for $72 $05 ($7005 moved by the offset 512), printing each
# address and its first byte: before any CLOADM, after CLOADM "MCX", after CLOADM "MCX",512 (does the offset move the
# exec address too?), with where the bytes went (PEEK). BIGMC: the sum of its bytes, its motor runs and the letter it
# leaves. CLOADM and SKIPF inside a program, each followed by a PRINT on its line (a pause before the SKIPF keeps
# the line before it on the screen for the record). The lint allows CLOADM here only of these fixture files, into
# the memory CLEAR set aside, offset included; EXEC stays refused. Syntax [UM]; the addresses, the bytes and the
# timing [BB].
CLEAR 200,28671
#timeout 120
#tape mc-big
10 FOR I=0 TO 1022:P=PEEK(I AND 32767):IF P=112 OR P=114 THEN IF PEEK(I+1 AND 32767)=5 THEN PRINT I;P;
20 NEXT:PRINT "DONE"
RUN
CLOADM "MCX"
RUN
FOR I=0 TO 5:PRINT PEEK(28672+I AND 32767);:NEXT
#tape-rewind
CLOADM "MCX",512
RUN
FOR I=0 TO 5:PRINT PEEK(29184+I AND 32767);:NEXT
CLOADM "BIGMC"
#tape-blocks cloadm-big
S=0:FOR I=0 TO 599:S=S+PEEK(28928+I AND 32767):NEXT:PRINT S
#tape-rewind
NEW
10 CLOADM "MCX":PRINT "AFTER CLOADM":FOR D=1 TO 300:NEXT
20 SKIPF:PRINT "AFTER SKIPF"
30 PRINT "LINE 30"
RUN
