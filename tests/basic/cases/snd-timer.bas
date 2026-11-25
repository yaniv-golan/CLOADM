# bb-only: timing around sound (docs/clean-room-basic-p2.md sections 6 and 7; decision 4): whether TIMER counts while
# SOUND and PLAY play (TIMER read before and after, against a delay loop that plays nothing), typed directly and in a
# program; and whether BREAK stops a long SOUND or PLAY (pressed a second in, with the sound's measures showing where
# it stopped). Sounds are recorded with #wav: measures only (decision 5). Syntax [UM]; the values and measures [BB].
#timeout 120
TIMER=0:FOR I=1 TO 500:NEXT:PRINT TIMER
#wav sound
TIMER=0:SOUND 100,20:PRINT TIMER
#wav-stop
#wav play
TIMER=0:PLAY "L4CDEF":PRINT TIMER
#wav-stop
10 TIMER=0:SOUND 100,20:T=TIMER:PLAY "L4CDEF":PRINT T;TIMER
#wav program
RUN
#wav-stop
#wav break-sound
#nowait
SOUND 1,255
#frames 50
#break
#wav-stop
#wav break-play
#nowait
PLAY "T1L1CDEFGAB"
#frames 50
#break
#wav-stop
PRINT TIMER
