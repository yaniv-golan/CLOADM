# VARPTR of a variable that does not exist is ?FC ERROR (making it would move the arrays); EXEC with no address ever given
10 DIM A(3):A(1)=7
20 A(0)=VARPTR(Z)
RUN
PRINT A(1)
EXEC
