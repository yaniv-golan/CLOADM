# bb-only: PLAY's pitch (docs/clean-room-basic-p2.md section 6): the default octave (the first PLAY, before any O),
# the seven naturals in each octave 1-5, sharps (# and +) and flats (-), and N1-N12 (with and without the N). Within
# one #wav, adjacent notes always differ in pitch, so each note is one tone of the measures (the harness splits a run
# where the period changes). Each is recorded with #wav: measures only (decision 5). Syntax [UM]; the periods [BB],
# from which the anchor pitch comes.
#timeout 60
#wav default-a
PLAY "A"
#wav-stop
#wav o1
PLAY "O1CDEFGAB"
#wav-stop
#wav o2
PLAY "O2CDEFGAB"
#wav-stop
#wav o3
PLAY "O3CDEFGAB"
#wav-stop
#wav o4
PLAY "O4CDEFGAB"
#wav-stop
#wav o5
PLAY "O5CDEFGAB"
#wav-stop
#wav accidentals
PLAY "O2CC#DD+EFF#GG#AA#B"
#wav-stop
#wav flats
PLAY "O3D-DE-EG-GA-AB-B"
#wav-stop
#wav numbers
PLAY "O2N1N2N3N4N5N6N7N8N9N10N11N12"
#wav-stop
#wav bare-numbers
PLAY "O2;1;3;5;12"
#wav-stop
#wav edges
PLAY "O1C-O5B+"
#wav-stop
