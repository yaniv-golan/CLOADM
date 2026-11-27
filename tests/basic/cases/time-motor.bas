# bb-only: what MOTOR ON costs (docs/clean-room-basic.md section 12): TIMER read straight after MOTOR ON (does it
# wait, and does TIMER count while it does?), MOTOR ON twice against once, MOTOR OFF when off, and ten MOTOR ON:MOTOR
# OFF in a loop; typed (each with the tape summary's motor runs, measured outside the machine in fields, beside the
# TIMER it prints) and in a program, each part started just after a field begins (300-320). The tape is the fixture
# three-progs (our own), only so the motor is measured; nothing is read. Syntax [UM]; the timing [BB].
#timeout 60
#tape three-progs
TIMER=0:MOTOR ON:PRINT TIMER
#tape-blocks on-once
MOTOR OFF
#tape-blocks off
TIMER=0:MOTOR ON:MOTOR ON:PRINT TIMER
#tape-blocks on-twice
MOTOR OFF
#tape-blocks off-2
TIMER=0:MOTOR ON:T=TIMER:MOTOR OFF:PRINT T
#tape-blocks on-off
10 GOSUB 300:MOTOR ON:A=TIMER:MOTOR OFF
20 GOSUB 300:MOTOR ON:MOTOR ON:B=TIMER:MOTOR OFF
30 GOSUB 300:MOTOR OFF:C=TIMER
40 GOSUB 300:FOR I=1 TO 10:MOTOR ON:MOTOR OFF:NEXT:D=TIMER
50 GOSUB 300:FOR I=1 TO 10:NEXT:E=TIMER
60 PRINT A;B;C;D;E:END
300 W=TIMER
310 IF TIMER=W THEN 310
320 TIMER=0:RETURN
RUN
#tape-blocks program
