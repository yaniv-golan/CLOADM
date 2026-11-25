# string functions [UM]
A$="HELLO WORLD"
PRINT LEN(A$);LEN("");ASC("A");CHR$(66);"/"
PRINT LEFT$(A$,5);"/";RIGHT$(A$,5);"/";MID$(A$,7,3);"/";MID$(A$,7)
PRINT LEFT$(A$,0);"/";LEFT$(A$,99);"/";MID$(A$,20);"/";RIGHT$("AB",5)
PRINT STR$(12.5);"/";STR$(-3);"/";VAL("123");VAL(" -4.5E2");VAL("X");VAL("12AB")
PRINT INSTR(A$,"O");INSTR(5,A$,"O");INSTR(6,A$,"O");INSTR(A$,"Z");INSTR(A$,"")
PRINT STRING$(5,"*");STRING$(3,65);"/";HEX$(255);" ";HEX$(0);" ";HEX$(4096);" ";HEX$(65535)
B$=A$+"!":PRINT B$;LEN(B$)
PRINT ASC("")
PRINT MID$(A$,0)
PRINT CHR$(256)
C$=STRING$(150,"A"):D$=C$+C$
PRINT "A"+"B"+"C"+"D"
