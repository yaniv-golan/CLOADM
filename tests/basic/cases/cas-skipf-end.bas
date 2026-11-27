# bb-only: the end of SKIPF, to the field (docs/clean-room-basic.md section 2, the bb11 timing probes; section 12).
# In bb8 cas-cloadm2 ours takes about 25 fields more than the original from its SKIPF's motor stopping to the case's
# end. On the fixture mc-big (our own machine code, never run: MCX, then BIGMC in three blocks), in a program: TIMER
# read just before and just after each SKIPF (over MCX, then over BIGMC), after the PRINT that follows it, and around
# the next line's PRINT, the differences printed at the end; with the motor's runs (#tape-blocks), the span less the
# run is the time from the motor stopping to the statement after SKIPF (if TIMER stops while the tape is read with
# interrupts off, as on ours, each SKIPF's TIMER span is that time with the time before the motor starts). Then
# cas-cloadm2's own tail with no TIMER (two SKIPFs, each followed by a PRINT, a PRINT line, the end), timed by the
# record's frames from the motor's last run to OK. Then typed: SKIPF over MCX, then over BIGMC, each to its OK (the
# top-row flags and the frames). No memory is read or written. Syntax [UM]; the timing [BB].
#timeout 120
#tape mc-big
10 T0=TIMER:SKIPF:T1=TIMER:PRINT "S1":T2=TIMER
20 T3=TIMER:SKIPF:T4=TIMER:PRINT "S2":T5=TIMER
30 T6=TIMER:PRINT "L3":T7=TIMER
40 PRINT T1-T0;T2-T1;T4-T3;T5-T4;T7-T6
RUN
#tape-blocks prog-timer
#tape-rewind
NEW
10 SKIPF:PRINT "AFTER SKIPF"
20 SKIPF:PRINT "AFTER SKIPF"
30 PRINT "LINE 30"
RUN
#tape-blocks prog-tail
#tape-rewind
SKIPF
#tape-blocks direct-mcx
SKIPF
#tape-blocks direct-bigmc
PRINT "END"
