# bb-only: products and printing at the smallest exponents (docs/clean-room-basic.md section 5, provenance item 57).
# bb10 num-literal-bytes: the original prints the bytes 1,89,199,220,238 as 5.00000001E-39, ours as 5E-39, and no
# scaling by steps of ten gives that together with its .333333333 and rnd-seq's .903043481, so a product at the
# smallest exponents may round as ours does not. Each value is put in R (the program's first variable: its value is
# at the variable table's start + 2, $1B-1C [BB bb3], as num-print-big finds it) by POKE, copied to X, and printed
# with its five bytes; then R=X*1E9, X*10, X*1E8 and X*1E4, each printed with its bytes. The values: exponent byte 1
# with the mantissas 89,199,220,238 (the 5E-39), 0,0,0,0, 127,255,255,255 and 0,0,0,1; exponent bytes 2, 3, 4 and 10
# with 89,199,220,238. Low RAM is PEEKed only at $1B-1C (literal), and PEEKed and POKEd only at R's own five bytes,
# through "AND 32767" (bb-only, reviewed by hand). Syntax [UM]; the output [BB].
#timeout 120
10 R=0:V=PEEK(27)*256+PEEK(28)+2:X=0
20 FOR J=1 TO 8:FOR K=0 TO 4:READ S:POKE V+K AND 32767,S:NEXT:X=R
30 GOSUB 800:R=X*1E9:GOSUB 800:R=X*10:GOSUB 800:R=X*1E8:GOSUB 800:R=X*1E4:GOSUB 800:PRINT:NEXT:END
40 DATA 1,89,199,220,238,1,0,0,0,0,1,127,255,255,255,1,0,0,0,1
50 DATA 2,89,199,220,238,3,89,199,220,238,4,89,199,220,238,10,89,199,220,238
800 PRINT R;:FOR K=0 TO 4:PRINT MID$(STR$(PEEK(V+K AND 32767)),2);",";:NEXT:PRINT:RETURN
RUN
