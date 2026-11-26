# bb-only: two PRINT USING results of ours that look wrong, for the original (docs/clean-room-basic.md, PRINT USING):
# a fixed field too narrow for 100000.5 (ours prints % 1.000005E+10, the value scaled), and an exponent field with no
# digit before the point given 999999999 (ours prints .01E+11). Neighbours that fit, for comparison. Syntax [UM]; the
# output [BB].
PRINT USING "#####.#####";100000.5
PRINT USING "######.#####";100000.5
PRINT USING "#####.#####";99999.5
PRINT USING ".##^^^^";999999999
PRINT USING ".##^^^^";99999999
PRINT USING "#.##^^^^";999999999
