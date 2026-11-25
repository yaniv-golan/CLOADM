# bb-only: PLAY's note lengths (docs/clean-room-basic-p2.md section 6; decision 4, timing matched to the cycle): the
# default length and tempo (the first PLAY), L1-L64, tempos T1-T255, dots after a note and after a length (one and
# two), pauses P4, P8, P16 and a dotted one between two notes of different pitch, and two lengths in one string. Each
# is recorded with #wav: measures only (decision 5); a note's length and the silence before the next are what W is
# fitted to. Syntax [UM]; the measures [BB].
#timeout 60
#wav default
PLAY "A"
#wav-stop
#wav l1
PLAY "L1A"
#wav-stop
#wav l2
PLAY "L2A"
#wav-stop
#wav l4
PLAY "L4A"
#wav-stop
#wav l8
PLAY "L8A"
#wav-stop
#wav l16
PLAY "L16A"
#wav-stop
#wav l32
PLAY "L32A"
#wav-stop
#wav l64
PLAY "L64A"
#wav-stop
#wav t1
PLAY "T1L4A"
#wav-stop
#wav t4
PLAY "T4L4A"
#wav-stop
#wav t8
PLAY "T8L4A"
#wav-stop
#wav t16
PLAY "T16L4A"
#wav-stop
#wav t64
PLAY "T64L4A"
#wav-stop
#wav t255
PLAY "T255L4A"
#wav-stop
#wav dot-note
PLAY "T2L4A."
#wav-stop
#wav dot-dot-note
PLAY "L4A.."
#wav-stop
#wav dot-length
PLAY "L4.A"
#wav-stop
#wav dot-both
PLAY "L4.A."
#wav-stop
#wav pause4
PLAY "L4AP4C"
#wav-stop
#wav pause8
PLAY "AP8C"
#wav-stop
#wav pause16
PLAY "AP16C"
#wav-stop
#wav pause-dot
PLAY "AP8.C"
#wav-stop
#wav two-lengths
PLAY "L4AL8CL16E"
#wav-stop
