# bb-only: the motor's runs and the leaders (docs/clean-room-basic.md section 12), timing measures only: on a blank
# tape, CSAVE of a one-line program, the same saved as text (,A), a program of over 255 bytes (two data blocks: the
# leader and the motor between them), and a data file of 660 bytes written in one program line (three data blocks:
# does the motor stop between them?), each summary its leaders and motor runs. Then from the recording's start: SKIPF
# (over A), SKIPF "C" (over B and C), the data file read back in one program line, and from the start again CLOAD "C",
# each summary its motor runs. Syntax [UM]; the leaders and the timing [BB].
#timeout 300
#tape-blank
NEW
10 PRINT "T"
CSAVE "A"
#tape-blocks csave
CSAVE "B",A
#tape-blocks csave-ascii
NEW
10 REM AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
20 REM BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB
30 REM CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC
CSAVE "C"
#tape-blocks csave-long
NEW
10 OPEN "O",#-1,"D":FOR I=1 TO 60:PRINT #-1,"0123456789":NEXT:CLOSE #-1
RUN
#tape-blocks data-write
#tape-rewind
SKIPF
#tape-blocks skipf
SKIPF "C"
#tape-blocks skipf-c
NEW
10 OPEN "I",#-1,"D":N=0:FOR I=1 TO 60:INPUT #-1,A$:N=N+LEN(A$):NEXT:CLOSE #-1:PRINT N
RUN
#tape-blocks data-read
#tape-rewind
CLOAD "C"
#tape-blocks cload-c
LIST 10
