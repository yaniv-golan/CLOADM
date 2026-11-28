# bb-only: PRINT USING with a format string longer than 127 characters (docs/clean-room-basic.md section 2): ours
# compares the format's length unsigned but indexes it with a signed byte, so at offset 128 it reads before the
# string. Formats of 126 to 131 characters, letters then a field, so the field lies on each side of 128: what the
# original prints, and whether it comes back to OK. Each format is built with STRING$ in a fresh string space.
# Syntax [UM]; the answers [BB].
#timeout 30
CLEAR 1000
FOR N=124 TO 129:F$=STRING$(N,"A")+"##":PRINT USING F$;7:PRINT LEN(F$):NEXT
PRINT "END"
