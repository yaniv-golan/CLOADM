# bb-only: DRAW (docs/clean-room-basic-p2.md section 6): where DRAW starts at cold start (the first part runs before
# any other drawing), the eight directions with N, moves with no length, B, M absolute and relative, the angles A0-A3
# and whether an angle lasts into the next DRAW, the scales S1-S62 (S3: rounding) and whether a scale lasts, colours
# with C in PMODE 3, X with a substring, and =var; for a length. Every DRAW string here was checked by hand to stay
# on the picture. Syntax [UM]; pictures [BB]. A part ends by putting a marker (Q1, S1 ...) in the text screen's last
# two cells and looping.
100 PMODE 4,1:PCLS:SCREEN 1,1:DRAW "U20L20D20"
190 POKE 1534,81:POKE 1535,113
199 GOTO 199
200 PMODE 4,1:PCLS:SCREEN 1,1:DRAW "BM128,96NU40NE40NR40NF40ND40NG40NL40NH40"
210 DRAW "BM20,20RRRRDDDDLLLLUUUU":DRAW "BM20,40R10BR10R10":DRAW "BM20,60E5F5G5H5"
220 DRAW "BM20,100M60,140M+20,-20M-10,+30BM+10,+10D10"
290 POKE 1534,83:POKE 1535,113
299 GOTO 299
300 PMODE 4,1:PCLS:SCREEN 1,1
310 DRAW "BM40,96A0U20R10D5":DRAW "BM100,96A1U20R10D5":DRAW "BM160,96A2U20R10D5":DRAW "BM220,96A3U20R10D5"
320 DRAW "BM40,170U20R10":DRAW "A0"
330 DRAW "A1":DRAW "BM100,170U20R10":DRAW "A0"
340 DRAW "BM160,40A1E10F10":DRAW "A0"
390 POKE 1534,84:POKE 1535,113
399 GOTO 399
400 PMODE 4,1:PCLS:SCREEN 1,1
410 DRAW "BM10,40S1U8R8D8L8":DRAW "BM30,40S2U8R8D8L8":DRAW "BM60,40S4U8R8D8L8":DRAW "BM100,40S8U8R8D8L8"
420 DRAW "BM150,40S16U8R8D8L8":DRAW "BM200,40S62U1R1D1L1":DRAW "BM10,100S3U5R5D5L5":DRAW "BM40,100S5U5R5D5L5"
430 DRAW "S8":DRAW "BM80,120U5R5D5L5":DRAW "S4"
490 POKE 1534,85:POKE 1535,113
499 GOTO 499
500 PMODE 3,1:PCLS:SCREEN 1,0
510 DRAW "BM20,20C2R20C3D20C4L20C1U20":DRAW "BM60,20R20D20L20U20":DRAW "C0BM100,20R20D20"
520 A$="U10R10D10L10":DRAW "BM50,150XA$;BM80,150XA$;BM110,150XA$;"
530 N=25:DRAW "C3BM150,150R=N;D=N;":X=200:Y=100:DRAW "BM=X;,=Y;U10"
590 POKE 1534,86:POKE 1535,113
599 GOTO 599
#nowait
RUN 100
#wait-text Q1$|ERROR IN 1\d\d
#screenshot cold-start
#break
#nowait
RUN 200
#wait-text S1$|ERROR IN 2\d\d
#screenshot directions-moves
#break
#nowait
RUN 300
#wait-text T1$|ERROR IN 3\d\d
#screenshot angles
#break
#nowait
RUN 400
#wait-text U1$|ERROR IN 4\d\d
#screenshot scales
#break
#nowait
RUN 500
#wait-text V1$|ERROR IN 5\d\d
#screenshot colours-substrings
#break
SCREEN 0,0
