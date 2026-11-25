* ---------------- the command strings of DRAW and PLAY ----------------
* docs/clean-room-basic-p2.md section 6 [OWN]. The string is evaluated once and read in place: MSPTR is the next
* character, MSCNT how many are left. Nothing here makes a string, so the garbage collector cannot move it during
* the statement. =var; and X var$; borrow the text pointer: it is pointed into the string so PTRGET reads the name,
* then put back. An X substring's outer place (pointer and count, 3 bytes) goes on the 6809 stack and comes back at
* the substring's end; MSDEP counts them, and CHKSTK limits them (?OM ERROR).
* The interface, for DRAW (draw.inc) and PLAY:
*   MSSTR   a string expression at the text pointer becomes the command string (?TM ERROR for a number)
*   MSCMD   the next command: A = its character, C set at the end of the whole string. Spaces and ';' are skipped,
*           X var$; is run here. It keeps X substrings on the stack: the caller keeps nothing of its own there
*           between two calls.
*   MSGET   the next character as it is: A, C set if there is none (keeps U, Y)
*   MSBACK  put the character MSGET just gave back
*   MSNUM   a number: =var; or decimal digits, 0-255 (?FC ERROR beyond) [OWN; BB]: D, C set if there was none (D 0)
* Errors: anything wrong in the string (a ';' missing after a name, too long a number): ?FC ERROR [BB].

* MSSTR: the string expression at the text pointer as the command string
MSSTR   JSR     EVSTR
        JSR     FRESTR
        STX     <MSPTR
        STB     <MSCNT
        CLR     <MSDEP
        RTS

* MSGET: the next character into A; C set if there is none (keeps B)
MSGET   LDA     <MSCNT
        SUBA    #1
        BCS     MG1
        STA     <MSCNT
        LDX     <MSPTR
        LDA     ,X+
        STX     <MSPTR
MG1     RTS

* MSBACK: the character MSGET gave goes back
MSBACK  INC     <MSCNT
        LDX     <MSPTR
        LEAX    -1,X
        STX     <MSPTR
        RTS

* MSVAR: the variable named at MSPTR, and the ';' after it: X = its value (PTRGET), VALTYP its type
MSVAR   LDD     <TXTPTR
        PSHS    D
        LDX     <MSPTR
        STX     <TXTPTR
        JSR     PTRGET
        LDU     <TXTPTR
        LDA     ,U+
        CMPA    #';'
        BNE     MSFC
        TFR     U,D
        SUBD    <MSPTR          ; the characters it took
        TSTA
        BNE     MSFC
        PSHS    B
        LDB     <MSCNT
        SUBB    ,S+
        BCS     MSFC            ; (past the string's end)
        STB     <MSCNT
        STU     <MSPTR
        PULS    D
        STD     <TXTPTR
        RTS
MSFC    JMP     FCERR

* MSNUM: a number (see above)
MSNUM   BSR     MSGET
        BCS     MN8
        CMPA    #'='
        BNE     MN2
        BSR     MSVAR
        JSR     CHKNUM
        JSR     MOVFM
        JSR     CNVBYT
        BRA     MN5
MN2     CLRB                    ; the value so far
        SUBA    #'0'
        CMPA    #9
        BHI     MN6             ; not a digit: no number
MN3     PSHS    A
        LDA     #10
        MUL
        ADDB    ,S+
        ADCA    #0
        BNE     MSFC
        BSR     MSGET
        BCS     MN5
        SUBA    #'0'
        CMPA    #9
        BLS     MN3
        BSR     MSBACK
MN5     CLRA                    ; (C clear: a number)
        RTS
MN6     BSR     MSBACK
MN8     CLRA
        CLRB
        ORCC    #1              ; (C set: none)
        RTS

* MSCMD: the next command character (see above). The return address is kept in Y while substrings go on the stack.
MSCMD   PULS    Y
MC1     JSR     MSGET
        BCS     MC3
        CMPA    #' '
        BEQ     MC1
        CMPA    #';'
        BEQ     MC1
        CMPA    #'X'
        BNE     MC8
        PSHS    Y
        JSR     MSVAR           ; X var$; : the substring
        JSR     CHKSTR
        JSR     CHKSTK
        PULS    Y
        LDB     <MSCNT
        LDU     <MSPTR
        PSHS    B,U
        INC     <MSDEP
        LDB     ,X
        LDX     2,X
        STX     <MSPTR
        STB     <MSCNT
        BRA     MC1
MC3     TST     <MSDEP          ; the end of a substring: back to the string around it
        BEQ     MC9             ; (C still set: the end)
        PULS    B,U
        STU     <MSPTR
        STB     <MSCNT
        DEC     <MSDEP
        BRA     MC1
MC8     ANDCC   #$FE            ; (C clear: a command)
MC9     JMP     ,Y
