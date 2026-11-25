# bb-only: drawing past the picture's edges (docs/clean-room-basic-p2.md section 5: clipped point by point, or an
# error, is [BB]): circles that cross each edge, DRAW moves that leave the picture on each side, and LINE and PSET
# given points just past the edge. The picture is in pages 3-6 of 8 (PCLEAR 8, PMODE 4,3), with pages 2 and 7 cleared
# first, so a point that is not clipped lands in a reserved page, never in BASIC's memory; pages 2 and 7 are then
# shown (PMODE 0) to see whether anything landed there. Every DRAW string here was checked by hand to stay within
# 40 points of the picture. Syntax [UM]; pictures and errors [BB]. A part ends by putting a marker (Q1, S1 ...) in
# the text screen's last two cells and looping.
PCLEAR 8
100 PMODE 0,2:PCLS:PMODE 0,7:PCLS:PMODE 4,3:PCLS:SCREEN 1,1
110 CIRCLE(5,96),30:CIRCLE(250,96),30:CIRCLE(128,5),30:CIRCLE(128,186),30
120 DRAW "BM240,40R30":DRAW "BM10,60;L30":DRAW "BM60,10;U30":DRAW "BM60,180;D30":DRAW "BM240,180;F30"
190 POKE 1534,81:POKE 1535,113
199 GOTO 199
200 PMODE 0,2:SCREEN 1,1
290 POKE 1534,83:POKE 1535,113
299 GOTO 299
300 PMODE 0,7:SCREEN 1,1
390 POKE 1534,84:POKE 1535,113
399 GOTO 399
400 PMODE 0,2:SCREEN 1,1
490 POKE 1534,85:POKE 1535,113
499 GOTO 499
500 PMODE 0,7:SCREEN 1,1
590 POKE 1534,86:POKE 1535,113
599 GOTO 599
#nowait
RUN 100
#wait-text Q1$|ERROR IN 1\d\d
#screenshot edges
#break
#nowait
RUN 200
#wait-text S1$|ERROR IN 2\d\d
#screenshot page2-above
#break
#nowait
RUN 300
#wait-text T1$|ERROR IN 3\d\d
#screenshot page7-below
#break
# points given past the edge: an error, or drawn somewhere
PMODE 0,2:PCLS:PMODE 0,7:PCLS:PMODE 4,3:PCLS:LINE(200,10)-(300,10),PSET
PSET(300,20)
PSET(20,250)
LINE(10,150)-(10,230),PSET
#nowait
RUN 400
#wait-text U1$|ERROR IN 4\d\d
#screenshot page2-after-points
#break
#nowait
RUN 500
#wait-text V1$|ERROR IN 5\d\d
#screenshot page7-after-points
#break
SCREEN 0,0
