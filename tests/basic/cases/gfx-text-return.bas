# bb-only: when the screen goes back to text (docs/clean-room-basic-p2.md section 3; decision 7). A picture is shown
# (PMODE 4, SCREEN 1,1, a line and a circle), then the program PRINTs, waits in INPUT, loops on INKEY$ (before and
# after a key), clears the text screen with CLS, ENDs, STOPs, is stopped with BREAK, stops on an error, or runs off
# its last line; and the same picture made by a line typed directly, at the OK prompt. Each is a picture: text or
# graphics. Syntax [UM]; pictures [BB]. A part puts a marker (Q1, S1 ...) in the text screen's last two cells where
# the picture is to be taken, then waits there.
10 PMODE 4,1:PCLS:SCREEN 1,1:LINE(0,0)-(255,191),PSET:CIRCLE(128,96),50:RETURN
100 GOSUB 10:PRINT "PRINTED"
190 POKE 1534,81:POKE 1535,113
199 GOTO 199
200 GOSUB 10:POKE 1534,83:POKE 1535,113:INPUT A:PRINT A:END
300 GOSUB 10:POKE 1534,84:POKE 1535,113
310 IF INKEY$="" THEN 310
320 POKE 1534,84:POKE 1535,114
330 GOTO 330
400 GOSUB 10:END
500 GOSUB 10:STOP
600 GOSUB 10:POKE 1534,85:POKE 1535,113
610 GOTO 610
700 GOSUB 10:X=1/0
800 GOSUB 10:CLS:POKE 1534,86:POKE 1535,113
810 GOTO 810
900 GOSUB 10
#nowait
RUN 100
#wait-text Q1$|ERROR IN \d+
#screenshot print
#break
#nowait
RUN 200
#wait-text S1$|ERROR IN \d+
#frames 10
#screenshot input
#type 5\n
#screenshot after-input-end
#nowait
RUN 300
#wait-text T1$|ERROR IN \d+
#frames 10
#screenshot inkey-waiting
#type \n
#wait-text T2$|ERROR IN \d+
#frames 10
#screenshot inkey-after-key
#break
RUN 400
#screenshot end
RUN 500
#screenshot stop
#nowait
RUN 600
#wait-text U1$|ERROR IN \d+
#screenshot running
#break
#screenshot after-break
RUN 700
#screenshot error
#nowait
RUN 800
#wait-text V1$|ERROR IN 8\d\d
#screenshot cls
# after CLS the BREAK message and OK print at the top while the marker stays on the last row: so BREAK as a key, and
# a CLS to clear the marker before the next part
#keys BREAK
CLS
RUN 900
#screenshot ran-off-the-end
PMODE 4,1:PCLS:SCREEN 1,1:LINE(0,0)-(255,191),PSET:CIRCLE(128,96),50
#screenshot direct-ok
SCREEN 0,0
