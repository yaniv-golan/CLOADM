# bb-only: PAINT (docs/clean-room-basic-p2.md section 5; decision 1): a box, a circle, a U, a box split by a
# diagonal line (a fill that crosses it where only corners touch is 8-connected; one that stops is 4-connected), a
# fill that meets pixels already of the paint colour inside the region, a border colour different from the paint
# colour, a fill with no border in reach (it stops at the picture's edges), and colours of the other colour set, in
# PMODE 4 and PMODE 3. Syntax [UM]; pictures [BB]. A part ends by putting a marker (Q1, S1 ...) in the text screen's
# last two cells and looping.
100 PMODE 4,1:PCLS:SCREEN 1,1
110 LINE(10,10)-(70,60),PSET,B:PAINT(40,30),1,1
120 CIRCLE(128,40),30:PAINT(128,40),1,1
130 LINE(180,10)-(195,10),PSET:LINE-(195,55),PSET:LINE-(225,55),PSET:LINE-(225,10),PSET:LINE-(240,10),PSET
135 LINE-(240,70),PSET:LINE-(180,70),PSET:LINE-(180,10),PSET:PAINT(185,60),1,1
140 LINE(10,100)-(90,180),PSET,B:LINE(10,100)-(90,180),PSET:PAINT(60,120),1,1
150 LINE(120,100)-(200,180),PSET,B:LINE(200,100)-(120,180),PSET:PAINT(160,110),1,1
190 POKE 1534,81:POKE 1535,113
199 GOTO 199
200 PMODE 3,1:PCLS:SCREEN 1,0:COLOR 4,1
210 LINE(10,10)-(90,80),PSET,B:PSET(30,30,3):LINE(50,20)-(50,70),PSET:PAINT(20,20),3,4
220 LINE(110,10)-(190,80),PSET,B:PAINT(150,40),2,3
230 CIRCLE(60,140),40,4:LINE(30,140)-(90,140),PSET:PAINT(60,120),3,4
240 LINE(130,110)-(230,180),PSET,BF:LINE(150,130)-(210,160),PRESET,B:PAINT(180,145),2,4
290 POKE 1534,83:POKE 1535,113
299 GOTO 299
300 PMODE 3,1:PCLS:SCREEN 1,1:COLOR 5,1
310 LINE(10,10)-(90,80),PSET,B:PAINT(50,40),7,5
320 LINE(110,10)-(190,80),PSET,B:PAINT(150,40),3,5
330 LINE(10,110)-(90,180),PSET,B:PAINT(50,140),6,2
390 POKE 1534,84:POKE 1535,113
399 GOTO 399
400 PMODE 4,1:PCLS:SCREEN 1,1:CIRCLE(128,96),40:PAINT(10,10),1,1
490 POKE 1534,85:POKE 1535,113
499 GOTO 499
500 PMODE 4,1:PCLS:SCREEN 1,1:LINE(20,20)-(100,100),PSET,B:PAINT(60,60)
590 POKE 1534,86:POKE 1535,113
599 GOTO 599
#nowait
RUN 100
#wait-text Q1$|ERROR IN 1\d\d
#screenshot pmode4-shapes
#break
#nowait
RUN 200
#wait-text S1$|ERROR IN 2\d\d
#screenshot pmode3-set0
#break
#nowait
RUN 300
#wait-text T1$|ERROR IN 3\d\d
#screenshot pmode3-set1
#break
#nowait
RUN 400
#wait-text U1$|ERROR IN 4\d\d
#screenshot outside-a-circle
#break
#nowait
RUN 500
#wait-text V1$|ERROR IN 5\d\d
#screenshot defaults
#break
SCREEN 0,0
