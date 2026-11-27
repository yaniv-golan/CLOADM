# bb-only: how PLAY drives the DAC per note (docs/clean-room-basic-p2.md section 6): for each tone the record's
# measures give how many distinct levels it used and how many writes it made (not compared: decision 3; read by
# hand), its period and its lowest and highest level. One A at the default volume and V31, typed and in a program
# (does a note in a program start the same way?), notes alternating in pitch, the pitch edges (O1C, O1C-, O5B, O5B+,
# N1 and N12 in O1 and O5), the shortest and longest notes (L255, L1 at T255), and one note at V1. Each recorded with
# #wav: measures only (decision 5). Syntax [UM]; the measures [BB].
#timeout 60
#wav a-typed
PLAY "A"
#wav-stop
#wav v31-typed
PLAY "V31A"
#wav-stop
10 PLAY "A"
#wav a-program
RUN
#wav-stop
10 PLAY "V31A"
#wav v31-program
RUN
#wav-stop
#wav alternating
PLAY "V15ACACAC"
#wav-stop
#wav o1c
PLAY "O1C"
#wav-stop
#wav o1c-flat
PLAY "O1C-"
#wav-stop
#wav o5b
PLAY "O5B"
#wav-stop
#wav o5b-sharp
PLAY "O5B+"
#wav-stop
#wav n-edges
PLAY "O1N1O5N12"
#wav-stop
#wav short
PLAY "T255L255A"
#wav-stop
#wav long
PLAY "T255L1A"
#wav-stop
#wav v1
PLAY "V1A"
#wav-stop
