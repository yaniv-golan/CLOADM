# words that are not statements at the start of a line; hex constants with letters; DATA spacing; VAL overflow leaves the program alone
OR
=5
THEN
TO 3
PRINT &HDEF;&HA0
10 DATA "A" ,"B"
20 DATA "D"
30 READ A$,B$:PRINT A$;B$
40 X=VAL("1E99")
RUN
LIST 40
10 DIM A(2),B(5):B(1)=2
20 DIM C(B(1)):C(2)=5:PRINT C(2)
30 FOR A(1)=1 TO 3:NEXT
40 PRINT USING "############^^^^";1
RUN
RUN 40
