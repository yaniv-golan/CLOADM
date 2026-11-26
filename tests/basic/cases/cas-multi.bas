# bb-only: files of several data blocks (docs/clean-room-basic.md section 10, open question 10; section 12), on the
# fixture multi-text (our own: LONG, a program as text in three data blocks; NONUM, a program as text whose second
# line has no line number, in the first of its three data blocks; BIGDATA, a data file of three blocks; GOOD, a short
# program). What the top-left letter ends as after a file of three data blocks (the final screen; the top-row flags
# give the frame of each blink), and the motor's runs while it loads; whether NONUM's line without a number is
# ?DS ERROR at once or once its last block is read (the motor's runs, the letter, and where the next search starts:
# CLOAD "GOOD" shows each file it passes over), and what is left of the program; SKIPF over the data file (its runs),
# before NONUM, so that a file NONUM's error might leave open cannot stop it. Syntax [UM]; the display, the errors
# and the timing [BB].
#timeout 120
#tape multi-text
CLOAD "LONG"
#tape-blocks cload-long
LIST 100-120
SKIPF "BIGDATA"
#tape-blocks skipf-data
CLOAD
LIST
#tape-rewind
CLOAD "NONUM"
#tape-blocks cload-nonum
LIST
CLOAD "GOOD"
#tape-blocks cload-good
LIST
