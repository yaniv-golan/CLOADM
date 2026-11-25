# bb-only: PMODE 0-4 with both colour sets (docs/clean-room-basic-p2.md sections 3 and 11). Each mode is drawn
# twice, SCREEN 1,0 and SCREEN 1,1, after PCLS: the four corners and the centre, eight neighbouring points along a
# row and a column (which merge in the low-resolution modes), a diagonal, colours 0-8 (two rows), and points at
# odd coordinates; then a picture. The syntax is [UM]; what the pictures show is the black-box result.
# A part ends by putting a marker (Q1, Q2, S1 ...) in the text screen's last two cells and looping, so the picture
# is taken while it is shown; "ERROR IN" lets the case go on when a part stops with an error.
100 C=0:GOTO 102
101 C=1
102 PMODE 0,1:PCLS:SCREEN 1,C
110 PSET(0,0):PSET(255,0):PSET(0,191):PSET(255,191):PSET(128,96)
120 FOR I=0 TO 7:PSET(I+16 AND 255,8):PSET(8,I+16 AND 255):NEXT
130 FOR I=0 TO 7:PSET(I*4+32 AND 255,I*4+32 AND 255):NEXT
140 FOR I=0 TO 8:PSET(I*8+80 AND 255,100,I):PSET(I*8+81 AND 255,103,I):NEXT
150 PSET(1,1):PSET(3,3):PSET(5,4)
190 POKE 1534,81:POKE 1535,113+C
199 GOTO 199
200 C=0:GOTO 202
201 C=1
202 PMODE 1,1:PCLS:SCREEN 1,C
210 PSET(0,0):PSET(255,0):PSET(0,191):PSET(255,191):PSET(128,96)
220 FOR I=0 TO 7:PSET(I+16 AND 255,8):PSET(8,I+16 AND 255):NEXT
230 FOR I=0 TO 7:PSET(I*4+32 AND 255,I*4+32 AND 255):NEXT
240 FOR I=0 TO 8:PSET(I*8+80 AND 255,100,I):PSET(I*8+81 AND 255,103,I):NEXT
250 PSET(1,1):PSET(3,3):PSET(5,4)
290 POKE 1534,83:POKE 1535,113+C
299 GOTO 299
300 C=0:GOTO 302
301 C=1
302 PMODE 2,1:PCLS:SCREEN 1,C
310 PSET(0,0):PSET(255,0):PSET(0,191):PSET(255,191):PSET(128,96)
320 FOR I=0 TO 7:PSET(I+16 AND 255,8):PSET(8,I+16 AND 255):NEXT
330 FOR I=0 TO 7:PSET(I*4+32 AND 255,I*4+32 AND 255):NEXT
340 FOR I=0 TO 8:PSET(I*8+80 AND 255,100,I):PSET(I*8+81 AND 255,103,I):NEXT
350 PSET(1,1):PSET(3,3):PSET(5,4)
390 POKE 1534,84:POKE 1535,113+C
399 GOTO 399
400 C=0:GOTO 402
401 C=1
402 PMODE 3,1:PCLS:SCREEN 1,C
410 PSET(0,0):PSET(255,0):PSET(0,191):PSET(255,191):PSET(128,96)
420 FOR I=0 TO 7:PSET(I+16 AND 255,8):PSET(8,I+16 AND 255):NEXT
430 FOR I=0 TO 7:PSET(I*4+32 AND 255,I*4+32 AND 255):NEXT
440 FOR I=0 TO 8:PSET(I*8+80 AND 255,100,I):PSET(I*8+81 AND 255,103,I):NEXT
450 PSET(1,1):PSET(3,3):PSET(5,4)
490 POKE 1534,85:POKE 1535,113+C
499 GOTO 499
500 C=0:GOTO 502
501 C=1
502 PMODE 4,1:PCLS:SCREEN 1,C
510 PSET(0,0):PSET(255,0):PSET(0,191):PSET(255,191):PSET(128,96)
520 FOR I=0 TO 7:PSET(I+16 AND 255,8):PSET(8,I+16 AND 255):NEXT
530 FOR I=0 TO 7:PSET(I*4+32 AND 255,I*4+32 AND 255):NEXT
540 FOR I=0 TO 8:PSET(I*8+80 AND 255,100,I):PSET(I*8+81 AND 255,103,I):NEXT
550 PSET(1,1):PSET(3,3):PSET(5,4)
590 POKE 1534,86:POKE 1535,113+C
599 GOTO 599
#nowait
RUN 100
#wait-text Q1$|ERROR IN 1\d\d
#screenshot pmode0-set0
#break
#nowait
RUN 101
#wait-text Q2$|ERROR IN 1\d\d
#screenshot pmode0-set1
#break
#nowait
RUN 200
#wait-text S1$|ERROR IN 2\d\d
#screenshot pmode1-set0
#break
#nowait
RUN 201
#wait-text S2$|ERROR IN 2\d\d
#screenshot pmode1-set1
#break
#nowait
RUN 300
#wait-text T1$|ERROR IN 3\d\d
#screenshot pmode2-set0
#break
#nowait
RUN 301
#wait-text T2$|ERROR IN 3\d\d
#screenshot pmode2-set1
#break
#nowait
RUN 400
#wait-text U1$|ERROR IN 4\d\d
#screenshot pmode3-set0
#break
#nowait
RUN 401
#wait-text U2$|ERROR IN 4\d\d
#screenshot pmode3-set1
#break
#nowait
RUN 500
#wait-text V1$|ERROR IN 5\d\d
#screenshot pmode4-set0
#break
#nowait
RUN 501
#wait-text V2$|ERROR IN 5\d\d
#screenshot pmode4-set1
#break
SCREEN 0,0
