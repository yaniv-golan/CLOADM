# bb-only: MOTOR and AUDIO with a tape playing (docs/clean-room-basic.md section 12; docs/clean-room-basic-p2.md
# section 7): MOTOR ON and MOTOR OFF on one line with a pause between (the tape summary's motor run, in fields); the
# motor left running past OK, then stopped by the next line; AUDIO ON with the motor running (the sound switch at
# #wav-stop: whether sound is on, the multiplexer) and AUDIO OFF; MOTOR without ON or OFF. The tape is the fixture
# three-progs (our own). A tape summary covers one typed line, so how fast a line is typed never counts. Syntax [UM];
# the timing and the sound switch [BB].
#tape three-progs
MOTOR ON:FOR I=1 TO 500:NEXT:MOTOR OFF
#tape-blocks loop
MOTOR ON
#tape-blocks left-on
MOTOR OFF
#tape-blocks off
#wav audio-on
MOTOR ON:AUDIO ON
#wav-stop
#wav audio-off
AUDIO OFF:MOTOR OFF
#wav-stop
MOTOR
MOTOR 1
