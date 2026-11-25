# CONT after BREAK and STOP keeps FOR and GOSUB loops; BREAK in INPUT; CONT after END and after the end; RUN n; TRON [UM]
10 FOR I=1 TO 3000:NEXT:PRINT "LOOP DONE"
20 GOSUB 100:PRINT "BACK"
30 INPUT A:PRINT "A=";A
40 END:PRINT "AFTER END":GOTO 200
100 PRINT "IN SUB":STOP:PRINT "SUB CONT":RETURN
200 REM THE END
#nowait
RUN
#frames 20
#break
CONT
#nowait
CONT
#break
#nowait
CONT
#type 7\n
#wait-text ^OK$
CONT
CONT
RUN 20
#nowait
CONT
#type 8\n
#wait-text ^OK$
TRON
RUN 40
TROFF
