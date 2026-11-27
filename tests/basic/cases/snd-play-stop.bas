# bb-only: where a PLAY note stops (docs/clean-room-basic.md section 12; docs/clean-room-basic-p2.md section 6).
# bb10 snd-play-dac's notes end after any of the four DAC writes of a period, and the next sound starts from that
# level: each tone's writes, less the one event that turns the sound on, give the write it stopped after (1098 high,
# 1094 high, 1099 middle, 1092 low), and the next tone's first level is that one (46, 62, 31, 0). Notes whose lengths
# in fields differ by a fraction (T2 with L8 to L20, about 16 to 6 fields; a tempo stays from one PLAY to the next,
# so each sets T2), then L16 at three pitches, typed one a line and then L8 to L20 in a program one after another,
# each followed by another note so its first level shows where the last one stopped. Recorded with #wav: measures
# only (decision 5). Syntax [UM]; the measures [BB].
#timeout 120
#wav typed
PLAY "T2L8A"
PLAY "T2L9A"
PLAY "T2L10A"
PLAY "T2L11A"
PLAY "T2L12A"
PLAY "T2L13A"
PLAY "T2L14A"
PLAY "T2L15A"
PLAY "T2L16A"
PLAY "T2L17A"
PLAY "T2L18A"
PLAY "T2L19A"
PLAY "T2L20A"
PLAY "T2L16O1C"
PLAY "T2L16O3E"
PLAY "T2L16O5B"
PLAY "T2A"
#wav-stop
10 FOR N=8 TO 20:PLAY "T2L"+MID$(STR$(N),2)+"A":NEXT:PLAY "T2A":END
#wav program
RUN
#wav-stop
