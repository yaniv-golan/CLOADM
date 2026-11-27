# bb-only: DLOAD and DLOADM with nothing on the serial port (docs/clean-room-basic.md section 4): ours gives ?FC
# ERROR at once. Each is typed and left for 250 fields, the screen as it is then is recorded, and BREAK is pressed:
# whether it stopped at once with an error, is still waiting, or comes back to OK on BREAK. A wait that times out
# (no OK after BREAK) is the result, and ends the case. Syntax [UM]; the answers [BB].
#timeout 15
#expect-timeout
#nowait
DLOAD
#frames 250
#break
#nowait
DLOADM
#frames 250
#break
PRINT "AFTER"
