# bb-only: CIRCLE (docs/clean-room-basic-p2.md section 5; decision 1, pixel-exact): circles of radius 0-95 about one
# centre and apart, ratios (h) 0, 0.25, 0.5, 1, 2 and 4, arcs with start and end (each quarter, a wrap past 0, start
# equal to end, a short arc), a colour, and circles in PMODE 0 and PMODE 3. Every circle stays on the picture (off
# the edge: gfx-clip). Syntax [UM]; pictures [BB]. A part ends by putting a marker (Q1, S1 ...) in the text screen's
# last two cells and looping.
100 PMODE 4,1:PCLS:SCREEN 1,1
110 FOR I=0 TO 9:READ R:CIRCLE(128,96),R AND 127:NEXT
120 DATA 0,1,2,3,5,10,20,40,70,95
130 CIRCLE(20,20),1:CIRCLE(40,20),2:CIRCLE(60,20),3:CIRCLE(80,20),4:CIRCLE(20,170),6:CIRCLE(40,170),7
190 POKE 1534,81:POKE 1535,113
199 GOTO 199
200 PMODE 4,1:PCLS:SCREEN 1,1
210 CIRCLE(40,40),30,1,0:CIRCLE(120,40),30,1,.25:CIRCLE(200,40),30,1,.5
220 CIRCLE(40,130),20,1,2:CIRCLE(120,130),15,1,4:CIRCLE(200,130),40,1,.75
230 CIRCLE(200,130),40,1,1.5
290 POKE 1534,83:POKE 1535,113
299 GOTO 299
300 PMODE 4,1:PCLS:SCREEN 1,1
310 CIRCLE(40,40),30,1,1,0,.25:CIRCLE(120,40),30,1,1,.25,.5:CIRCLE(200,40),30,1,1,.5,.75
320 CIRCLE(40,120),30,1,1,.75,1:CIRCLE(120,120),30,1,1,.9,.1:CIRCLE(200,120),30,1,1,.3,.3
330 CIRCLE(40,170),15,1,1,0,.01:CIRCLE(120,170),15,1,.5,.125,.625:CIRCLE(200,170),15,1,1.2,.6,.4
390 POKE 1534,84:POKE 1535,113
399 GOTO 399
400 PMODE 0,1:PCLS:SCREEN 1,1:FOR I=0 TO 9:READ R:CIRCLE(128,96),R AND 127:NEXT:CIRCLE(40,40),30,1,.5
490 POKE 1534,85:POKE 1535,113
499 GOTO 499
500 PMODE 3,1:PCLS:SCREEN 1,0:COLOR 3,1:CIRCLE(60,60),40:CIRCLE(60,60),30,2:CIRCLE(60,60),20,4
510 CIRCLE(180,60),40,0:CIRCLE(180,140),40,7:CIRCLE(60,150),30,2,.5,.25,.75
590 POKE 1534,86:POKE 1535,113
599 GOTO 599
#nowait
RUN 100
#wait-text Q1$|ERROR IN 1\d\d
#screenshot radii
#break
#nowait
RUN 200
#wait-text S1$|ERROR IN 2\d\d
#screenshot ratios
#break
#nowait
RUN 300
#wait-text T1$|ERROR IN 3\d\d
#screenshot arcs
#break
#nowait
RUN 400
#wait-text U1$|ERROR IN 4\d\d
#screenshot pmode0
#break
#nowait
RUN 500
#wait-text V1$|ERROR IN 5\d\d
#screenshot pmode3-colours
#break
SCREEN 0,0
