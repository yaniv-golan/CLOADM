# bb-only: what the cassette shows while it works (docs/clean-room-basic.md section 12): the bb4 records show CLOAD
# clearing the screen and writing to its top row while it searches, skips and loads (their top-row flags). Pictures
# of a named CLOAD on three-progs (our fixture: ONE, TWO, THREE) while it searches, while it skips ONE and TWO, and
# when it is done; then a plain CLOAD, while it loads ONE. Syntax [UM]; the display [BB].
#timeout 120
#tape three-progs
#nowait
CLOAD "THREE"
#frames 20
#screenshot searching
#frames 200
#screenshot skipping
#wait-text ^OK(?![\s\S])
#screenshot found
#tape-rewind
#nowait
CLOAD
#frames 120
#screenshot loading
#wait-text ^OK(?![\s\S])
#screenshot loaded
