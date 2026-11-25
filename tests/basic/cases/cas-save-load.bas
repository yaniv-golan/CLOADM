# bb-only: CSAVE and CLOAD (docs/clean-room-basic.md section 12): a program saved with CSAVE "NAME" and as text with
# CSAVE "NAME",A onto a blank tape, the tape rewound, then CLOAD (the first file), CLOAD "NAME" (the next one by
# name), CLOAD "NAME" from the start again (the file before it passed over), and what each says while it searches;
# each program LISTed and RUN after. The tape summaries: the blocks each CSAVE wrote (types, lengths, the namefile's
# name, type, flags and addresses, the data's hash, the leaders) and the motor's runs. Syntax [UM]; the messages, the
# blocks and the timing [BB].
#timeout 120
#tape-blank
10 PRINT "SAVED"
20 A=6:B=7:PRINT A*B
CSAVE "PROG"
#tape-blocks csave
NEW
10 REM AS TEXT
20 PRINT "TEXT";3+4
CSAVE "TEXT",A
#tape-blocks csave-a
#tape-rewind
NEW
CLOAD
LIST
RUN
NEW
CLOAD "TEXT"
LIST
RUN
#tape-rewind
NEW
CLOAD "TEXT"
LIST
#tape-blocks cload-motor
