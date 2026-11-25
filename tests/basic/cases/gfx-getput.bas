# bb-only: GET and PUT (docs/clean-room-basic-p2.md section 8): a 16 x 16 pattern (a box, a diagonal, a filled corner)
# copied with GET ... ,G and put back with each action (PSET, PRESET, AND, OR, NOT, and none given) over a striped
# background; the same without G from a rectangle that starts and ends inside a byte (the coarse rule); and in PMODE 3
# with colours. Syntax [UM]; pictures [BB]. A part ends by putting a marker (Q1, S1 ...) in the text screen's last two
# cells and looping.
10 LINE(16,16)-(31,31),PSET,B:LINE(16,16)-(31,31),PSET:LINE(18,26)-(22,30),PSET,BF:RETURN
20 FOR I=0 TO 15:LINE(I*16 AND 255,100)-(I*16 AND 255,180),PSET:NEXT:LINE(0,140)-(255,140),PSET:RETURN
100 PMODE 4,1:PCLS:SCREEN 1,1:DIM A(40):GOSUB 10:GOSUB 20
110 GET(16,16)-(31,31),A,G
120 PUT(48,16)-(63,31),A,PSET:PUT(80,16)-(95,31),A,PRESET:PUT(112,16)-(127,31),A
130 PUT(16,110)-(31,125),A,PSET:PUT(48,110)-(63,125),A,PRESET:PUT(80,110)-(95,125),A,AND
140 PUT(112,110)-(127,125),A,OR:PUT(144,110)-(159,125),A,NOT:PUT(179,110)-(194,125),A,PSET
150 PUT(213,147)-(228,162),A,OR
190 POKE 1534,81:POKE 1535,113
199 GOTO 199
200 PMODE 4,1:PCLS:SCREEN 1,1:DIM A(40):GOSUB 10:GOSUB 20
210 GET(19,17)-(28,30),A
220 PUT(48,16)-(57,29),A,PSET:PUT(83,17)-(92,30),A,PSET:PUT(112,110)-(121,123),A,OR:PUT(150,113)-(159,126),A,AND
290 POKE 1534,83:POKE 1535,113
299 GOTO 299
300 PMODE 3,1:PCLS:SCREEN 1,0:DIM A(40)
310 COLOR 2,1:LINE(16,16)-(31,31),PSET,BF:COLOR 3:LINE(18,18)-(29,29),PSET,B:COLOR 4:LINE(16,16)-(31,31),PSET
320 COLOR 3:GOSUB 20:GET(16,16)-(31,31),A,G
330 PUT(48,16)-(63,31),A,PSET:PUT(80,16)-(95,31),A,PRESET:PUT(18,110)-(33,125),A,PSET:PUT(50,110)-(65,125),A,AND
340 PUT(82,110)-(97,125),A,OR:PUT(114,110)-(129,125),A,NOT:PUT(146,111)-(161,126),A,PSET
390 POKE 1534,84:POKE 1535,113
399 GOTO 399
#nowait
RUN 100
#wait-text Q1$|ERROR IN \d+
#screenshot pmode4-actions
#break
#nowait
RUN 200
#wait-text S1$|ERROR IN \d+
#screenshot pmode4-coarse
#break
#nowait
RUN 300
#wait-text T1$|ERROR IN \d+
#screenshot pmode3-actions
#break
SCREEN 0,0
