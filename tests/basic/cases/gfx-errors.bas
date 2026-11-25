# bb-only: the errors of graphics and sound (docs/clean-room-basic-p2.md section 9): points past the picture, colours,
# modes and colour sets out of range, LINE, CIRCLE, PAINT, DRAW, GET, PUT, PLAY, SOUND and JOYSTK with a missing or
# wrong argument, typed directly; then five of them inside a program that has a picture shown, each with a picture
# of the screen after the error (text or graphics). Not here, because the lint keeps every page in RAM: PMODE past
# the reserved pages, PCOPY to a page not reserved, a negative point (gfx-pclear has PCLEAR 0 and 9).
# Syntax [UM]; the error each gives [BB].
PSET(256,0)
PSET(0,192)
PRESET(300,10)
PRINT PPOINT(256,0)
PRINT PPOINT(0,192)
COLOR 9
COLOR 1,9
PCLS 9
PMODE 5,1
SCREEN 2
SCREEN 1,2
SCREEN 0,0
LINE(0,0)(10,10),PSET
LINE(0,0)-(10,10)
LINE(0,0)-(10,10),XSET
LINE(0,0)-(10,10),PSET,X
CIRCLE(128,96)
CIRCLE(128,96),10,9
CIRCLE(128,96),10,1,5
CIRCLE(128,96),10,1,1,1.5,.5
PAINT(128,96),9
PAINT(128,96),1,9
DRAW "Q"
DRAW 5
DRAW "A4"
DRAW "S63"
DRAW "C9"
DRAW "XZ$;"
DIM S(1):GET(0,0)-(63,63),S,G
GET(0,0)-(7,7),U,G
PUT(0,0)-(7,7),S,XOR
PLAY "Z"
PLAY "O6C"
PLAY "O0C"
PLAY "V32C"
PLAY "T0C"
PLAY "L0C"
PLAY "N13"
PLAY 5
SOUND 0,1
SOUND 256,1
SOUND 1,0
SOUND 1,256
PRINT JOYSTK(4)
PRINT JOYSTK(-1)
SCREEN 0,0
10 PMODE 4,1:PCLS:SCREEN 1,1:LINE(0,0)-(255,191),PSET:CIRCLE(128,96),50:RETURN
100 GOSUB 10:PSET(256,0):END
200 GOSUB 10:COLOR 9:END
300 GOSUB 10:DRAW "Q":END
400 GOSUB 10:PLAY "Z":END
500 GOSUB 10:SOUND 0,1:END
RUN 100
#screenshot pset-past-edge
RUN 200
#screenshot color-9
RUN 300
#screenshot draw-q
RUN 400
#screenshot play-z
RUN 500
#screenshot sound-0
SCREEN 0,0
