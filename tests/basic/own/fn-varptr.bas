# VARPTR (our own suite only: the black-box lint refuses it, since a found descriptor could be pointed into the ROM)
A=1:PRINT VARPTR(A)>7680;VARPTR(A)<32768
B$="XY":V=VARPTR(B$):PRINT PEEK(V);PEEK(V+1)
DIM C(3):PRINT VARPTR(C(1))-VARPTR(C(0))
