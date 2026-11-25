# bb-only: LINE (docs/clean-room-basic-p2.md section 5; decision 1, pixel-exact): lines from the centre to sixteen
# points (every octant, both axes and the exact diagonals), the same lines drawn the other way, lines of length 0
# and 1, nearly flat and nearly upright lines; boxes (B), filled boxes (BF, corners in either order), PRESET lines
# and boxes, and LINE -(x,y) from the last point; in PMODE 4, PMODE 0 and PMODE 3. Syntax [UM]; pictures [BB].
# A part ends by putting a marker (Q1, S1 ...) in the text screen's last two cells and looping.
10 READ X,Y:IF X<0 THEN RETURN
20 IF D=0 THEN LINE(128,96)-(X AND 255,Y AND 255),PSET ELSE LINE(X AND 255,Y AND 255)-(128,96),PSET
30 GOTO 10
40 DATA 200,96,200,120,200,168,160,168,128,168,96,168,56,168,56,120
50 DATA 56,96,56,72,56,24,96,24,128,24,160,24,200,24,200,72,-1,-1
60 LINE(10,10)-(10,10),PSET:LINE(20,10)-(21,10),PSET:LINE(30,10)-(31,11),PSET:LINE(40,10)-(40,11),PSET
70 LINE(10,180)-(250,183),PSET:LINE(240,20)-(243,90),PSET:LINE(5,40)-(25,47),PSET:LINE(5,60)-(12,80),PSET
80 RETURN
100 PMODE 4,1:PCLS:SCREEN 1,1:D=0:RESTORE:GOSUB 10:GOSUB 60
190 POKE 1534,81:POKE 1535,113
199 GOTO 199
200 PMODE 4,1:PCLS:SCREEN 1,1:D=1:RESTORE:GOSUB 10:GOSUB 60
290 POKE 1534,83:POKE 1535,113
299 GOTO 299
300 PMODE 4,1:PCLS:SCREEN 1,1
310 LINE(20,20)-(80,60),PSET,B:LINE(100,20)-(160,60),PSET,BF:LINE(230,60)-(180,20),PSET,BF
320 LINE(30,100)-(90,150),PSET,BF:LINE(40,110)-(80,140),PRESET,B:LINE(40,110)-(80,140),PRESET
330 LINE(100,100)-(140,150),PSET,BF:LINE(110,110)-(130,140),PRESET,BF
340 PSET(150,100):LINE-(200,100),PSET:LINE-(200,150),PSET:LINE-(150,150),PSET:LINE-(150,100),PSET:LINE-(250,180),PSET
350 LINE(5,170)-(5,170),PSET,B:LINE(10,170)-(11,171),PSET,BF:LINE(20,170)-(30,171),PSET,B
390 POKE 1534,84:POKE 1535,113
399 GOTO 399
400 PMODE 0,1:PCLS:SCREEN 1,1:D=0:RESTORE:GOSUB 10:GOSUB 60:LINE(20,20)-(80,60),PSET,B:LINE(100,20)-(161,61),PSET,BF
490 POKE 1534,85:POKE 1535,113
499 GOTO 499
500 PMODE 3,1:PCLS:SCREEN 1,0:COLOR 2,1:D=0:RESTORE:GOSUB 10:COLOR 3:GOSUB 60
510 COLOR 4:LINE(20,20)-(80,60),PSET,B:LINE(100,20)-(161,61),PSET,BF:LINE(101,21)-(159,59),PRESET,BF
590 POKE 1534,86:POKE 1535,113
599 GOTO 599
#nowait
RUN 100
#wait-text Q1$|ERROR IN \d+
#screenshot pmode4-from-centre
#break
#nowait
RUN 200
#wait-text S1$|ERROR IN \d+
#screenshot pmode4-to-centre
#break
#nowait
RUN 300
#wait-text T1$|ERROR IN 3\d\d
#screenshot pmode4-boxes
#break
#nowait
RUN 400
#wait-text U1$|ERROR IN \d+
#screenshot pmode0-lines
#break
#nowait
RUN 500
#wait-text V1$|ERROR IN \d+
#screenshot pmode3-lines
#break
SCREEN 0,0
