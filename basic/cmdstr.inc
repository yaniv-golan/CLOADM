* ---------------- command strings: the reader DRAW and PLAY share ----------------
* docs/clean-room-basic-p2.md section 6 [OWN]. A statement's commands are a string expression, read one character
* at a time: CSPTR is the next character, CSEND one past the last. Spaces and ';' between commands are skipped. Nothing
* here allocates a string, so the garbage collector cannot move the string while it is read.
*
* The interface (a statement's loop calls CSTART once, then CSGET until it reports the end, then CSPOP):
*   CSTART  the string expression at the text pointer becomes the command string (?TM ERROR for a number); an end
*           mark is pushed under the caller's return address, so the caller's stack then holds it
*   CSGET   A = the next command character, Z clear; at the end of the current string A = 0, Z set
*   CSUNG   give back the character CSGET just returned (nothing at the end), so it is read again. Keeps B.
*   CSNUM   a number: decimal digits (0-255, ?FC ERROR above), or =var; (a numeric variable's value, -32768 to
*           32767): D = it, C set. C clear (the character left to be read again) if neither is there.
*   CSSUB   X var$; : the string variable's text is read next, then the rest after the ';'. The outer string's place
*           is pushed under the caller's return address (?OM ERROR when the stack is full).
*   CSPOP   at the end of a string: the outer string's place back, Z clear; Z set when the statement's own string
*           has ended (its end mark taken off the stack)
* CSSUB and CSPOP move the stack under their return address, so both are called from the statement's loop itself,
* at the stack level CSTART left, never from inside a subroutine. =var; and X var$; read the name with the expression
* evaluator: the text pointer is pointed into the string, the value read, a ';' required (?SN ERROR) and the text
* pointer put back.

CSGET   LDX     CSPTR
CSG1    CMPX    CSEND
        BHS     CSGE
        LDA     ,X+
        CMPA    #' '
        BEQ     CSG1
        CMPA    #';'
        BEQ     CSG1
        STX     CSPTR
        TSTA
        RTS
CSGE    CLRA
        RTS

CSUNG   TSTA
        BEQ     CSU1
        LDX     CSPTR
        LEAX    -1,X
        STX     CSPTR
CSU1    RTS

CSNUM   BSR     CSGET
        CMPA    #'='
        BEQ     CSVAR
        JSR     CGFLAG          ; C set for a digit, A kept
        BCC     CSUNG
        BSR     CSUNG           ; the digits are read again from the first, as they are
        CLRB
CSN1    LDX     CSPTR           ; the next digits as they are: nothing skipped
        CMPX    CSEND
        BHS     CSN2
        LDA     ,X+
        JSR     CGFLAG
        BCC     CSN2
        STX     CSPTR
        SUBA    #'0'
        PSHS    A
        LDA     #10
        MUL
        TSTA
        BNE     CSFC
        ADDB    ,S+
        BCS     CSFC
        BRA     CSN1
CSN2    CLRA
        ORCC    #1
        RTS
CSVAR   BSR     CSEVAL
        JSR     INTCNV
        ORCC    #1
        RTS
CSFC    JMP     FCERR

* CSEVAL: the expression at CSPTR, which must end in ';' (?SN ERROR), the ';' taken
CSEVAL  LDX     <TXTPTR
        PSHS    X
        LDX     CSPTR
        STX     <TXTPTR
        JSR     EVAL
        LDB     #';'
        JSR     SYNCHR          ; (the text pointer then on the character after it)
        LDX     <TXTPTR
        STX     CSPTR
        PULS    X
        STX     <TXTPTR
        RTS

CSSUB   BSR     CSEVAL
        JSR     FRESTR          ; (?TM ERROR for a number) X, B the substring
        PULS    U
        JSR     CHKSP
        LDY     CSPTR
        PSHS    Y
        LDY     CSEND
        PSHS    Y               ; the outer string's place: CSEND below CSPTR
        BSR     CSSET
        JMP     ,U

CSTART  JSR     EVSTR
        JSR     FRESTR          ; X = the text, B = its length
        BSR     CSSET
        PULS    U
        CLRA
        CLRB
        PSHS    D,X             ; the end mark: a place whose end is 0
        JMP     ,U
* CSSET: the B characters at X are the string read now
CSSET   STX     CSPTR
        ABX
        STX     CSEND
        RTS

CSPOP   PULS    U
        PULS    D,X
        STX     CSPTR
        STD     CSEND           ; Z set for the end mark
        JMP     ,U
