# bb-only: PCLEAR as a program sees it (docs/clean-room-basic-p2.md section 3): MEM at cold start and after PCLEAR 1,
# 8 and 4; a program typed before PCLEAR still lists and runs; whether variables survive a PCLEAR typed directly; a
# PCLEAR inside a program (does it go on from the next statement, and do variables survive); PCLEAR 0 and 9 (errors
# in the manual's range 1-8). No graphics mode is shown, so no PMODE here (PCLEAR 0 leaves no pages for one).
# Syntax [UM]; results [BB].
PRINT MEM
10 A=5:PRINT "RUNNING";A
RUN
PCLEAR 1
PRINT MEM
LIST
RUN
A=7:PCLEAR 8:PRINT A;MEM
20 B=3:PCLEAR 2:PRINT "AFTER";A;B
RUN
PRINT MEM
LIST
PCLEAR 4
PRINT MEM
PCLEAR 0
PRINT MEM
PCLEAR 9
PRINT MEM
RUN
