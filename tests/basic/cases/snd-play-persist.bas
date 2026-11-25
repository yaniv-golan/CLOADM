# bb-only: what PLAY keeps (docs/clean-room-basic-p2.md section 6): whether the octave, length, tempo and volume set
# by one PLAY last into the next PLAY, through RUN and inside a program; the octave modifiers + (>) and - (<) [UM]; X
# with a substring; =var; for a value. Each is recorded with #wav: measures only (decision 5). Syntax [UM]; the
# measures [BB].
#wav set
PLAY "O4L8T4V5A"
#wav-stop
#wav next-play
PLAY "A"
#wav-stop
10 PLAY "A"
#wav after-run
RUN
#wav-stop
20 PLAY "O3L2T2V20":PLAY "C"
#wav in-program
RUN 20
#wav-stop
#wav octave-modifiers
PLAY "O2A O+A O-A >A <A"
#wav-stop
A$="CDE"
#wav substring
PLAY "O2XA$;G"
#wav-stop
N=4:L=16
#wav variables
PLAY "O=N;L=L;AO2A"
#wav-stop
