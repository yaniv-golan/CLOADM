# bb-only: a negative base to a whole power of 32768 and over (docs/clean-room-basic.md section 5): the sign follows
# the power's parity, and ours reads the parity from the power as a 16-bit integer, so it takes 32769 as even. The
# original's answers for (-1) to 32767, 32768, 32769 and 65537 with SGN of each, and (-1)^3 and (-1)^4, one PRINT a
# line. Syntax [UM]; the answers [BB].
#timeout 20
PRINT (-1)^32767;SGN((-1)^32767)
PRINT (-1)^32768;SGN((-1)^32768)
PRINT (-1)^32769;SGN((-1)^32769)
PRINT (-1)^65537;SGN((-1)^65537)
PRINT (-1)^3;(-1)^4
