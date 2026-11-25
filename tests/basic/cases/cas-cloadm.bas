# bb-only: CLOADM (docs/clean-room-basic.md section 12) of our own machine code (the fixture mc: six bytes at $7000,
# eight at $7010), into memory set aside with CLEAR: what it says while it searches, the bytes it put there (PEEK), and
# CLOADM "NAME" passing over the file before. The code never runs: EXEC is refused in a case, and the lint allows
# CLOADM only from such a fixture with no offset. Syntax [UM]; the messages [BB].
CLEAR 200,28672
#tape mc
CLOADM
FOR I=0 TO 5:PRINT PEEK(28672+I AND 32767);:NEXT
#tape-rewind
CLOADM "MC2"
FOR I=0 TO 7:PRINT PEEK(28688+I AND 32767);:NEXT
