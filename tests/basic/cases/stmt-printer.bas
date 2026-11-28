# bb-only: LLIST and PRINT #-2 with the printer ready (docs/clean-room-basic.md section 13). The record holds the
# screen (what each prints there, whether it comes back to OK, how long it takes in fields by TIMER) and the bytes
# the printer port received (the record's printer: this case's own program and output, as BASIC sends them to a
# printer).
# LLIST of a two-line program, LLIST with a line range, PRINT #-2 with ; and , and with nothing, then PRINT #-2 in a
# program. Syntax [UM]; the answers [BB].
#timeout 20
10 PRINT "HELLO"
20 REM PRINTER
LLIST
LLIST 20
TIMER=0:LLIST:PRINT TIMER
PRINT #-2,"ABC";1
PRINT #-2,"X",
PRINT #-2
TIMER=0:PRINT #-2,"0123456789":PRINT TIMER
NEW
10 PRINT #-2,"IN PROGRAM":PRINT "DONE"
RUN
