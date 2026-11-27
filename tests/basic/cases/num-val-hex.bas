# bb-only: VAL of a string holding a hex or octal constant (docs/clean-room-basic.md section 5): ours gives 0 for
# every one of them. The five asked about (&H10, &HFFFF, &H10000, &O177777, &O200000), then their neighbours: the largest
# and smallest 16-bit values, no digits, a bad digit, a digit after a bad one, a leading space, a sign, & alone with
# digits, and an 8 in an octal string. Last, the same constants typed in a statement, for comparison. One line each,
# so an error stops only its own line. Syntax [UM]; the answers [BB].
PRINT VAL("&H10")
PRINT VAL("&HFFFF")
PRINT VAL("&H10000")
PRINT VAL("&O177777")
PRINT VAL("&O200000")
PRINT VAL("&H7FFF");VAL("&H8000");VAL("&HFF")
PRINT VAL("&H")
PRINT VAL("&HG")
PRINT VAL("&H1G")
PRINT VAL(" &H10")
PRINT VAL("-&H10")
PRINT VAL("&17")
PRINT VAL("&O17");VAL("&O8")
PRINT VAL("&H10")+1;VAL("1&H10")
PRINT &H10000
PRINT &O177777
PRINT &O200000
PRINT &17;&O8
