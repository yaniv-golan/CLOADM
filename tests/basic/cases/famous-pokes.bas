# bb-only: POKEs a web answer names for the Dragon [DOC-grade leads, unverified], asked of the original [BB]. The
# speed POKEs (SAM rate bits: 65495/65494 the address-dependent rate, 65497/65496 the fast rate) against a loop
# timed with TIMER; then the RAM bytes the answer names, read before and after the statement that should set them,
# and written: 175 TRON's flag, 329 lower case (a key typed to INPUT while it is 0; the program puts 255 back), 25
# the program's start page (POKE 25,6:NEW in place of PCLEAR 0), 274-275 TIMER, 113 the cold-start flag (read
# only: a reset cannot be pressed here), and 111 the output device (254 the printer: last, as a printer that never
# says ready may hold it). Low RAM is POKEd through "AND 32767" (bb-only,
# reviewed by hand: none of these addresses holds a pointer to code). Syntax [UM]; results [BB].
#timeout 60
10 TIMER=0:FOR I=1 TO 2000:NEXT:A=TIMER
20 POKE 65495,0:TIMER=0:FOR I=1 TO 2000:NEXT:B=TIMER:POKE 65494,0
30 POKE 65497,0:TIMER=0:FOR I=1 TO 2000:NEXT:C=TIMER:POKE 65496,0
40 PRINT "NORMAL";A;"FAST";B;"MAX";C
RUN
NEW
PRINT "71";PEEK(113);"AF";PEEK(175);"149";PEEK(329);"6F";PEEK(111);"19";PEEK(25)
TRON:PRINT PEEK(175):TROFF:PRINT PEEK(175)
10 A=1
20 B=2
POKE 175 AND 32767,79:RUN:POKE 175 AND 32767,0
RUN
TIMER=500:POKE 274 AND 32767,0:POKE 275 AND 32767,0:PRINT TIMER
PRINT MEM:POKE 25 AND 32767,6:NEW
PRINT MEM;PEEK(25)
10 REM HERE
LIST
POKE 25 AND 32767,30:NEW
PRINT MEM;PEEK(25)
NEW
10 POKE 329 AND 32767,0:INPUT A$:POKE 329 AND 32767,255:PRINT ASC(A$);PEEK(329)
#nowait
RUN
A
#timeout 10
#expect-timeout
POKE 111 AND 32767,254:PRINT "TO THE PRINTER":POKE 111 AND 32767,0:PRINT "BACK"
PRINT "AFTER"
