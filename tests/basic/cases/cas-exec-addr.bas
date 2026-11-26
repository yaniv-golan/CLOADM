# bb-only: CLOADM's exec address (docs/clean-room-basic.md section 12, open question 10): bb8 cas-cloadm2 found it at
# $9D-9E (157) on the original. Read there after CLOADM "MCX" (exec $7005) and after CLOADM "MCX",512: whether the
# offset moves it by 512. The fixture mc-big (our own machine code, never run), loaded into memory CLEAR set aside.
# Syntax [UM]; the addresses [BB].
CLEAR 200,28671
#tape mc-big
CLOADM "MCX"
PRINT PEEK(157)*256+PEEK(158)
#tape-rewind
CLOADM "MCX",512
PRINT PEEK(157)*256+PEEK(158)
