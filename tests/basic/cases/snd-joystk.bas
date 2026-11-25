# bb-only: JOYSTK (docs/clean-room-basic-p2.md section 7). The axes are set with #joy (0 right x, 1 right y, 2 left x,
# 3 left y; 0-63) and read back: every axis at the ends and the middle; whether JOYSTK(1)-(3) read the axis now or keep
# what JOYSTK(0) read (axes changed between JOYSTK(0) and JOYSTK(1) and (3)), in either order. A #wav around
# JOYSTK(0) records whether reading the axes is heard (DAC writes with sound on) and the sound switch it leaves.
# Measures only (decision 5). Syntax [UM]; the values [BB].
#joy 0 0
#joy 1 63
#joy 2 31
#joy 3 32
PRINT JOYSTK(0);JOYSTK(1);JOYSTK(2);JOYSTK(3)
#joy 0 63
#joy 1 0
#joy 2 1
#joy 3 62
PRINT JOYSTK(0);JOYSTK(1);JOYSTK(2);JOYSTK(3)
#joy 0 10
#joy 1 20
#joy 2 30
#joy 3 40
PRINT JOYSTK(1);JOYSTK(2);JOYSTK(3)
PRINT JOYSTK(0)
#joy 1 50
#joy 3 5
PRINT JOYSTK(1);JOYSTK(3)
PRINT JOYSTK(0);JOYSTK(1);JOYSTK(3)
PRINT JOYSTK(3);JOYSTK(2);JOYSTK(1);JOYSTK(0)
#wav read
X=JOYSTK(0)
#wav-stop
SOUND 100,1
#wav read-after-sound
X=JOYSTK(0)
#wav-stop
