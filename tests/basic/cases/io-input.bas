# INPUT and LINE INPUT [UM]
10 INPUT A:PRINT A*2
20 INPUT "TWO";B,C$:PRINT B;C$
30 INPUT D,E:PRINT D;E
40 INPUT F:PRINT F
50 LINE INPUT "LINE ";L$:PRINT "[";L$;"]"
60 INPUT G:PRINT G
#nowait
RUN
#type 21\n
#type 3,HI THERE\n
#type 4\n
#type 5\n
#type ABC\n
#type 6\n
#type HELLO, WORLD: X\n
#type 7,8\n
#wait-text ^OK$
INPUT X
