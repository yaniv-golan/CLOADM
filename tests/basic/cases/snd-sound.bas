# bb-only: SOUND (docs/clean-room-basic-p2.md section 7): the pitch of tones 1, 50, 100, 150, 200 and 255 (for the
# period's dependence on t), the length of 1, 2, 5, 10 and 20 units (for the unit), and two SOUNDs in one program
# line (the gap between them). Each is recorded with #wav: measures only (period and length in cycles, the level
# range), never the samples (decision 5). Syntax [UM]; the measures [BB].
#wav t1
SOUND 1,4
#wav-stop
#wav t50
SOUND 50,4
#wav-stop
#wav t100
SOUND 100,4
#wav-stop
#wav t150
SOUND 150,4
#wav-stop
#wav t200
SOUND 200,4
#wav-stop
#wav t255
SOUND 255,4
#wav-stop
#wav d1
SOUND 100,1
#wav-stop
#wav d2
SOUND 100,2
#wav-stop
#wav d5
SOUND 100,5
#wav-stop
#wav d10
SOUND 100,10
#wav-stop
#wav d20
SOUND 100,20
#wav-stop
10 SOUND 100,2:SOUND 200,2:SOUND 100,2
#wav program
RUN
#wav-stop
