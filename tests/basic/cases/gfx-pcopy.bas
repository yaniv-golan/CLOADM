# bb-only: pages (docs/clean-room-basic-p2.md section 3): with PCLEAR 8, a picture drawn on pages 1-4 (PMODE 4,1) is
# copied with PCOPY to pages 5-8 and shown from page 5; single pages shown with PMODE 0 at pages 1, 2 and 8; PCOPY of
# a page to itself; and drawing on one page while another is shown (PMODE 4,5 drawn, PMODE 4,1 shown). Syntax [UM];
# pictures [BB]. A part ends by putting a marker (Q1, S1 ...) in the text screen's last two cells and looping.
PCLEAR 8
10 PMODE 4,1:PCLS:LINE(0,0)-(255,191),PSET:CIRCLE(128,96),60:LINE(10,10)-(60,40),PSET,BF:RETURN
100 GOSUB 10:PMODE 4,5:PCLS:PCOPY 1 TO 5:PCOPY 2 TO 6:PCOPY 3 TO 7:PCOPY 4 TO 8:PCOPY 1 TO 1:SCREEN 1,1
190 POKE 1534,81:POKE 1535,113
199 GOTO 199
200 PMODE 0,2:SCREEN 1,1
290 POKE 1534,83:POKE 1535,113
299 GOTO 299
300 PMODE 0,8:SCREEN 1,1
390 POKE 1534,84:POKE 1535,113
399 GOTO 399
400 GOSUB 10:SCREEN 1,1:PMODE 4,5:PCLS:CIRCLE(128,96),20
490 POKE 1534,85:POKE 1535,113
499 GOTO 499
500 PMODE 4,5:SCREEN 1,1
590 POKE 1534,86:POKE 1535,113
599 GOTO 599
#nowait
RUN 100
#wait-text Q1$|ERROR IN \d+
#screenshot copied-pages-5-8
#break
#nowait
RUN 200
#wait-text S1$|ERROR IN 2\d\d
#screenshot page2
#break
#nowait
RUN 300
#wait-text T1$|ERROR IN 3\d\d
#screenshot page8
#break
#nowait
RUN 400
#wait-text U1$|ERROR IN \d+
#screenshot drawn-on-5-shown-1
#break
#nowait
RUN 500
#wait-text V1$|ERROR IN 5\d\d
#screenshot page5
#break
SCREEN 0,0
