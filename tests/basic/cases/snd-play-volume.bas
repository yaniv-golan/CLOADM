# bb-only: PLAY's volume (docs/clean-room-basic-p2.md section 6): the default volume (the first PLAY), V1, V5, V10,
# V15, V20, V31 and V0, and volumes changing within one string. The level range of each tone (lowest and highest DAC
# level) is the loudness to match; the wave's shape is ours (decision 3). Each is recorded with #wav: measures only
# (decision 5). Syntax [UM]; the measures [BB].
#wav default
PLAY "A"
#wav-stop
#wav v1
PLAY "V1A"
#wav-stop
#wav v5
PLAY "V5A"
#wav-stop
#wav v10
PLAY "V10A"
#wav-stop
#wav v15
PLAY "V15A"
#wav-stop
#wav v20
PLAY "V20A"
#wav-stop
#wav v31
PLAY "V31A"
#wav-stop
#wav v0
PLAY "V0A"
#wav-stop
#wav changing
PLAY "V31AV15CV5E"
#wav-stop
