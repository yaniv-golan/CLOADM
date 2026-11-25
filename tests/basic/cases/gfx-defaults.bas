# bb-only: graphics defaults (docs/clean-room-basic-p2.md section 3): the mode, page, colours and last point at cold
# start (the first part runs before any PMODE or COLOR: SCREEN 1,1, PCLS with no colour, LINE from the last point
# with none given), the colours after PMODE, whether PMODE undoes COLOR, whether COLOR lasts through RUN, and the
# colour set of SCREEN 1 with none given. Each part: a picture, then PPOINT values printed after BREAK.
# Syntax [UM]; results [BB]. A part ends by putting a marker (Q1, S1 ...) in the text screen's last two cells and
# looping.
100 SCREEN 1,1:PCLS:LINE -(0,0),PSET
190 POKE 1534,81:POKE 1535,113
199 GOTO 199
200 PMODE 3,1:SCREEN 1,0:PCLS:PSET(10,10):LINE(20,20)-(60,60),PSET,BF:CIRCLE(128,96),40
290 POKE 1534,83:POKE 1535,113
299 GOTO 299
300 COLOR 2,3:PMODE 4,1:PCLS:SCREEN 1,0:PSET(10,10):LINE(20,20)-(60,60),PSET,BF
390 POKE 1534,84:POKE 1535,113
399 GOTO 399
400 SCREEN 1,0:PCLS:PSET(10,10):LINE(20,20)-(60,60),PSET,BF
490 POKE 1534,85:POKE 1535,113
499 GOTO 499
500 PMODE 3,1:PCLS:LINE(20,20)-(60,60),PSET,BF:SCREEN 1
590 POKE 1534,86:POKE 1535,113
599 GOTO 599
#nowait
RUN 100
#wait-text Q1$|ERROR IN 1\d\d
#screenshot cold-start
#break
PRINT PPOINT(0,0);PPOINT(128,96);PPOINT(64,48);PPOINT(1,1)
#nowait
RUN 200
#wait-text S1$|ERROR IN 2\d\d
#screenshot after-pmode3
#break
PRINT PPOINT(10,10);PPOINT(30,30);PPOINT(0,0)
#nowait
RUN 300
#wait-text T1$|ERROR IN 3\d\d
#screenshot color-then-pmode4
#break
PRINT PPOINT(10,10);PPOINT(30,30);PPOINT(0,0)
# PMODE and COLOR typed directly, then RUN of a part with no PMODE: does the colour last
PMODE 3,1:COLOR 4,2
#nowait
RUN 400
#wait-text U1$|ERROR IN 4\d\d
#screenshot color-through-run
#break
PRINT PPOINT(10,10);PPOINT(30,30);PPOINT(0,0)
#nowait
RUN 500
#wait-text V1$|ERROR IN 5\d\d
#screenshot screen1-no-set
#break
SCREEN 0,0
