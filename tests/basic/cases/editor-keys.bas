# the line editor's keys [UM]: left arrow erases a character, SHIFT-left arrow the line, BREAK drops it,
# SHIFT-0 switches to lower case (shown inverse) and back
#type 10 REM ABCD
#keys LEFT
#keys LEFT
#type X\n
LIST
#type 20 REM GONE
#keys SHIFT+LEFT
#type 20 REM KEPT\n
#type 30 REM DROPPED
#keys BREAK
LIST
#keys SHIFT+0
#type 40 rem lower\n
#keys SHIFT+0
#type 50 REM UPPER\n
LIST
