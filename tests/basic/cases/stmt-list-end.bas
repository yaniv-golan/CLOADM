# bb-only: whether LIST and LLIST end the line they are on (docs/clean-room-basic.md section 13): bb13a stmt-printer
# shows TIMER=0:LLIST:PRINT TIMER printing no number, on the screen or the printer, so the PRINT after LLIST did not
# run there. Typed: LIST:PRINT 1 and LLIST:PRINT 2; then in a program, 10 LIST:PRINT 2 with 20 PRINT 3 after it,
# and the same with LLIST (whether the program goes on after it, and with which line). The printer is ready (its
# bytes are the record's printer). Syntax [UM]; the answers [BB].
#timeout 30
10 PRINT "A"
LIST:PRINT 1
LLIST:PRINT 2
NEW
10 LIST:PRINT 2
20 PRINT 3
RUN
NEW
10 LLIST:PRINT 4
20 PRINT 5
RUN
