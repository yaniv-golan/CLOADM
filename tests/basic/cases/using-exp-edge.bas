# bb-only: PRINT USING at the edges of its fields (docs/clean-room-basic.md, PRINT USING; bb9 print-using-odd): an
# exponent field with one # before the point given -999999999 (the sign and the rounding up to ten digits), one with
# a + and no # before the point given 999999999, and a two-place field given 1E20 (wider than the field, and wider
# than nine digits). Neighbours for comparison. One line each. Syntax [UM]; the output [BB].
PRINT USING "#.##^^^^";-999999999
PRINT USING "#.##^^^^";-99999999
PRINT USING "+.##^^^^";999999999
PRINT USING "+.##^^^^";-999999999
PRINT USING "+.##^^^^";99999999
PRINT USING "##";1E20
PRINT USING "##";-1E20
PRINT USING "##";1E9
