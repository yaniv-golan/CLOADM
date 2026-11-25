# bb-only: CLS with a colour [UM: CLS c, c 0-8], found in most corpus programs. A picture of each colour; and text
# printed after a coloured CLS (does a carriage return blank the rest of its line, or keep the colour?). Colours
# past 8 are in screen-cls-range, a local-only case: on the original they print ROM text.
CLS
#screenshot cls
CLS 0
#screenshot cls0
CLS 1
#screenshot cls1
CLS 2
#screenshot cls2
CLS 3
#screenshot cls3
CLS 4
#screenshot cls4
CLS 5
#screenshot cls5
CLS 6
#screenshot cls6
CLS 7
#screenshot cls7
CLS 8
#screenshot cls8
CLS 3:PRINT "HI":PRINT "THERE";
#screenshot cls3-text
CLS
PRINT "DONE"
