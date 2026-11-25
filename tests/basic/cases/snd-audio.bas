# bb-only: AUDIO and the sound switch (docs/clean-room-basic-p2.md section 7): the sound enable and the multiplexer
# left by AUDIO ON, AUDIO OFF, SOUND, PLAY and a SOUND after AUDIO ON (with no tape), each from its #wav's end state;
# the DAC writes (if any) of AUDIO itself. Measures only (decision 5). Syntax [UM]; the measures [BB].
#wav cold-start
PRINT "IDLE"
#wav-stop
#wav audio-on
AUDIO ON
#wav-stop
#wav sound-after-audio-on
SOUND 100,2
#wav-stop
#wav audio-on-again
AUDIO ON
#wav-stop
#wav audio-off
AUDIO OFF
#wav-stop
#wav play
PLAY "A"
#wav-stop
#wav audio-off-after-play
AUDIO OFF
#wav-stop
