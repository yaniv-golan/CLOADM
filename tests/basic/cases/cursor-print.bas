# bb-only: the cursor's countdown at $008F (decimal 143) while a program writes to the screen (docs/clean-room-basic.md,
# "The cursor"; a black-box run of 2026-11-25 saw it count down then, and stay put in loops that print nothing). Each
# test reads PEEK(143) before and after one kind of output and prints how far it counted down: CLS, ten characters, a
# carriage return, PRINT @, a semigraphics block, an empty PRINT; then from 3, ten characters (does it wrap to 255,
# or reload at 0, and to what) and three characters (CELL: the byte at the cursor's address, $0088-$0089, after it
# reached 0: 96 if untouched, 32 if bit 6 was toggled). Ours: one per character put on the screen, none for a
# carriage return, CLS or PRINT @'s move, reloaded with 50 at 0 and the cell never toggled. Syntax [UM]; results [BB].
10 T$="CLS":A=PEEK(143):CLS:B=PEEK(143):GOSUB 900
20 T$="TEN CHARACTERS":A=PEEK(143):PRINT "ABCDEFGHIJ";:B=PEEK(143):GOSUB 900
30 T$="A CARRIAGE RETURN":A=PEEK(143):PRINT:B=PEEK(143):GOSUB 900
40 T$="PRINT @":A=PEEK(143):PRINT @416,"X";:B=PEEK(143):GOSUB 900
50 T$="A BLOCK":A=PEEK(143):PRINT CHR$(143);:B=PEEK(143):GOSUB 900
60 T$="EMPTY PRINT":A=PEEK(143):PRINT "";:B=PEEK(143):GOSUB 900
70 T$="FROM 3, TEN":POKE 143 AND 32767,3:PRINT "ABCDEFGHIJ";:B=PEEK(143):GOSUB 910
80 T$="FROM 3, THREE":POKE 143 AND 32767,3:PRINT "ABC";:C=PEEK((PEEK(136)*256+PEEK(137)) AND 32767):B=PEEK(143):GOSUB 910:PRINT "CELL";C
90 END
900 D=A-B:IF D<0 THEN D=D+256
905 PRINT:PRINT T$;D:RETURN
910 PRINT:PRINT T$;B:RETURN
RUN
