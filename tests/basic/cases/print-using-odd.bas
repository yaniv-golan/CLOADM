# a fixed field too narrow for 100000.5 (FOUT's nine digits and zeros after them, after a %), and an exponent field
# whose rounding carries out (999999999 with one or two digits kept: the 1 takes the sign's place and the exponent
# stays). Neighbours that fit, for comparison. Syntax [UM]; the output [BB bb9].
PRINT USING "#####.#####";100000.5
PRINT USING "######.#####";100000.5
PRINT USING "#####.#####";99999.5
PRINT USING ".##^^^^";999999999
PRINT USING ".##^^^^";99999999
PRINT USING "#.##^^^^";999999999
