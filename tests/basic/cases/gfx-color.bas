# bb-only: colours (docs/clean-room-basic-p2.md section 3): COLOR f,b, PCLS with and without a colour, PSET with
# colours 0-8 and PRESET, in a 4-colour mode (PMODE 3) with each colour set, in PMODE 1, and in the 2-colour PMODE 4,
# where colours outside the shown set are drawn. Nine stripes, one a colour 0-8 (COLOR I then LINE ... BF), a row of
# PSET points in each colour, and PRESET points cut out of a stripe; then a picture. Syntax [UM]; pictures [BB].
# A part ends by putting a marker (Q1, Q2 ...) in the text screen's last two cells and looping.
100 C=0:GOTO 102
101 C=1
102 PMODE 3,1:SCREEN 1,C:COLOR 1,0:PCLS
110 FOR I=0 TO 8:COLOR I,0:LINE(I*28 AND 255,0)-(I*28+20 AND 255,60),PSET,BF:NEXT
120 FOR I=0 TO 8:PSET(I*28+10 AND 255,80,I):NEXT
130 FOR I=0 TO 8:PRESET(I*28+10 AND 255,30):PRESET(I*28+11 AND 255,30):NEXT
190 POKE 1534,81:POKE 1535,113+C
199 GOTO 199
200 C=0:GOTO 202
201 C=1
202 PMODE 4,1:SCREEN 1,C:COLOR 1,0:PCLS
210 FOR I=0 TO 8:COLOR I,0:LINE(I*28 AND 255,0)-(I*28+20 AND 255,60),PSET,BF:NEXT
220 FOR I=0 TO 8:PSET(I*28+10 AND 255,80,I):NEXT
230 FOR I=0 TO 8:PRESET(I*28+10 AND 255,30):PRESET(I*28+11 AND 255,30):NEXT
290 POKE 1534,83:POKE 1535,113+C
299 GOTO 299
300 C=0:GOTO 302
301 C=1
302 PMODE 1,1:SCREEN 1,C:COLOR 1,0:PCLS
310 FOR I=0 TO 8:COLOR I,0:LINE(I*28 AND 255,0)-(I*28+20 AND 255,60),PSET,BF:NEXT
320 FOR I=0 TO 8:PSET(I*28+10 AND 255,80,I):NEXT
390 POKE 1534,84:POKE 1535,113+C
399 GOTO 399
400 PMODE 3,1:SCREEN 1,0:COLOR 3,2:PCLS:PSET(10,10):LINE(20,20)-(100,100),PSET,B
410 PRESET(60,20):PRESET(20,60):COLOR 4:PSET(30,30)
490 POKE 1534,85:POKE 1535,113
499 GOTO 499
500 PMODE 3,1:SCREEN 1,1:COLOR 6,7:PCLS:PCLS 8:LINE(20,20)-(100,100),PSET,BF:PCLS 6
590 POKE 1534,86:POKE 1535,113
599 GOTO 599
600 PMODE 3,1:SCREEN 1,0:PCLS 5
690 POKE 1534,87:POKE 1535,113
699 GOTO 699
#nowait
RUN 100
#wait-text Q1$|ERROR IN 1\d\d
#screenshot pmode3-set0-colours
#break
#nowait
RUN 101
#wait-text Q2$|ERROR IN 1\d\d
#screenshot pmode3-set1-colours
#break
#nowait
RUN 200
#wait-text S1$|ERROR IN 2\d\d
#screenshot pmode4-set0-colours
#break
#nowait
RUN 201
#wait-text S2$|ERROR IN 2\d\d
#screenshot pmode4-set1-colours
#break
#nowait
RUN 300
#wait-text T1$|ERROR IN 3\d\d
#screenshot pmode1-set0-colours
#break
#nowait
RUN 301
#wait-text T2$|ERROR IN 3\d\d
#screenshot pmode1-set1-colours
#break
# COLOR with only a foreground keeps the background; PCLS without a colour clears to the background
#nowait
RUN 400
#wait-text U1$|ERROR IN 4\d\d
#screenshot color-pcls-default
#break
# PCLS with a colour, after a box: is the whole page cleared to it
#nowait
RUN 500
#wait-text V1$|ERROR IN 5\d\d
#screenshot pcls-colour
#break
# PCLS with a colour of the other set
#nowait
RUN 600
#wait-text W1$|ERROR IN 6\d\d
#screenshot pcls-other-set
#break
SCREEN 0,0
