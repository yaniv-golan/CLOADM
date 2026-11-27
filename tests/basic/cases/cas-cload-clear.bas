# bb-only: when CLOAD clears the screen after passing over a file (docs/clean-room-basic.md section 12). In bb4
# cas-display ours clears it 6 fields later than the original after ONE (from the name to the clear, 72 fields
# against 66), and searches 6 fields sooner after the clear, so each file takes 210 fields on both. CLOAD "TWO" on
# three-progs (our fixture: ONE, TWO, THREE): the top-row flags give the frames of the name and the clear, the
# motor's runs (#tape-blocks) where the tape is, and a picture every 2 fields from 50 to 82 fields after ONE's name
# is due (each picture the whole screen: which letter, normal or inverse, and when the row goes). Then the same
# typed as SKIPF "TWO" (a search that passes ONE the same way). Syntax [UM]; the display and the timing [BB].
#timeout 120
#tape three-progs
#nowait
CLOAD "TWO"
#frames 240
#frames 2
#screenshot c00
#frames 2
#screenshot c02
#frames 2
#screenshot c04
#frames 2
#screenshot c06
#frames 2
#screenshot c08
#frames 2
#screenshot c10
#frames 2
#screenshot c12
#frames 2
#screenshot c14
#frames 2
#screenshot c16
#frames 2
#screenshot c18
#frames 2
#screenshot c20
#frames 2
#screenshot c22
#frames 2
#screenshot c24
#frames 2
#screenshot c26
#frames 2
#screenshot c28
#frames 2
#screenshot c30
#frames 2
#screenshot c32
#wait-text ^OK(?![\s\S])
#tape-blocks cload-two
#tape-rewind
SKIPF "TWO"
#tape-blocks skipf-two
