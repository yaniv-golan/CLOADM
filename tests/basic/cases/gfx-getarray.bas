# bb-only: GET's array layout (docs/clean-room-basic-p2.md section 8; decision 6). Known bytes are POKEd into page 1
# (no PCLEAR, so the POKEs stay in the cold-start pages), copied with GET and the array's elements printed: one byte
# ($81), two rows of two bytes ($F0 $0F / $AA $55), an 8 x 8 square all set (with G and without), and a PMODE 3 row
# ($1B $E4). Then an array filled with chosen numbers is PUT (with PSET and with no action given), shown, and read
# back with GET.
# Syntax [UM]; the values and the picture [BB].
10 FOR I=0 TO 9:PRINT A(I);:NEXT:PRINT:RETURN
100 PMODE 4,1:PCLS:DIM A(20):POKE 1536,129:GET(0,0)-(7,0),A,G:GOSUB 10
110 PCLS:POKE 1536,240:POKE 1537,15:POKE 1568,170:POKE 1569,85:GET(0,0)-(15,1),A,G:GOSUB 10
120 PCLS:POKE 1536,255:POKE 1568,255:POKE 1600,255:POKE 1632,255:POKE 1664,255:POKE 1696,255:POKE 1728,255
125 POKE 1760,255:GET(0,0)-(7,7),A,G:GOSUB 10
130 GET(0,0)-(7,7),A:GOSUB 10
140 PMODE 3,1:PCLS:POKE 1536,27:POKE 1537,228:GET(0,0)-(15,0),A,G:GOSUB 10
150 END
200 PMODE 4,1:PCLS:SCREEN 1,1:DIM F(10),H(10),A(10)
210 F(0)=1:F(1)=-1:F(2)=.5:F(3)=255:F(4)=65535:F(5)=1E30:F(6)=-2.5E-10:F(7)=12345.678:F(8)=0:F(9)=3:F(10)=-32768
220 PUT(0,0)-(15,15),F,PSET:PUT(32,0)-(47,15),F
230 GET(0,0)-(15,15),H,G:GET(32,0)-(47,15),A,G
290 POKE 1534,83:POKE 1535,113
299 GOTO 299
RUN 100
#nowait
RUN 200
#wait-text S1$|ERROR IN 2\d\d
#screenshot put-numbers
#break
FOR I=0 TO 10:PRINT H(I);:NEXT
FOR I=0 TO 10:PRINT A(I);:NEXT
SCREEN 0,0
