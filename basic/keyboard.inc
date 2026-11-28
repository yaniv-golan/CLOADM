* ---------------- the keyboard ----------------
* The matrix [HW, js/machines/keyboards.js]: PIA 0 port B drives a column low, port A reads the rows (a
* pressed key reads 0). A key's code is row * 8 + column. SHIFT is column 7, row 6.

* KEYIN: scan the keyboard once. A = the character of a key newly pressed (Z clear), or A = 0 (Z set).
* Keeps B, X, U.
KEYIN   PSHS    B,X,U
        LDU     #ROLLTB
        LDA     #$FF
        STA     <KEYTMP         ; no new key yet
        CLR     <KEYTMP+1       ; the column
        LDB     #$FE
KI1     STB     PIA0B
        LDA     PIA0A
        COMA
        ANDA    #$7F            ; bit 7 is the joystick comparator
        CMPB    #$7F
        BNE     KI2
        ANDA    #$BF            ; SHIFT is not a key of its own
KI2     PSHS    A
        EORA    ,U
        ANDA    ,S              ; the keys newly down in this column
        BEQ     KI4
        TST     <KEYTMP
        BPL     KI4             ; one new key per scan
        PSHS    B
        CLRB
KI3     LSRA
        BCS     KI3A
        INCB
        BRA     KI3
KI3A    LSLB
        LSLB
        LSLB
        ADDB    <KEYTMP+1
        STB     <KEYTMP
        PULS    B
KI4     PULS    A
        STA     ,U+
        INC     <KEYTMP+1
        ORCC    #1
        ROLB
        CMPB    #$FF
        BNE     KI1
        LDB     <KEYTMP
        BMI     KINONE
* debounce: after a wait of 300 passes (2,400 cycles [OWN]) the key must still be down
        LDX     #300
        BSR     DELAYX
        LDA     <KEYTMP
        ANDA    #7
        LDX     #BITTAB
        LDA     A,X
        COMA
        STA     PIA0B
        LDA     PIA0A
        COMA
        LDX     #BITTAB
        LSRB
        LSRB
        LSRB
        ANDA    B,X
        BNE     KI6
        LDB     <KEYTMP         ; it bounced: forget it, so it counts as new when it is really down
        ANDB    #7
        LDU     #ROLLTB
        LEAU    B,U
        LDB     <KEYTMP
        LSRB
        LSRB
        LSRB
        LDA     B,X
        COMA
        ANDA    ,U
        STA     ,U
        BRA     KINONE
* translate: the shifted table while SHIFT is down
KI6     LDX     #KEYTB
        LDA     #$7F
        STA     PIA0B
        LDA     PIA0A
        BITA    #$40
        BNE     KI7
        LDX     #KEYTBS
KI7     LDB     <KEYTMP
        LDA     B,X
        BEQ     KINONE
        CMPA    #$FE            ; SHIFT-0: lower case on or off [UM]
        BNE     KI8
        COM     CASEFL
        BRA     KINONE
KI8     CMPA    #'A'
        BLO     KIOK
        CMPA    #'Z'
        BHI     KIOK
        CMPX    #KEYTB          ; a letter: lower case in lower-case mode unless shifted
        BNE     KIOK
        TST     CASEFL          ; (0: lower case; 255, or anything else, upper case [BB bb6; OWN])
        BNE     KIOK
        ORA     #$20
KIOK    LDB     #$FF
        STB     PIA0B
        TSTA
        PULS    B,X,U,PC
KINONE  LDB     #$FF
        STB     PIA0B
        CLRA
        PULS    B,X,U,PC

* DELAYX: X passes of a countdown (8 cycles each; X = 0 is 65,536). X ends 0.
DELAYX  LEAX    -1,X
        BNE     DELAYX
        RTS

BITTAB  FCB     $01,$02,$04,$08,$10,$20,$40,$80

* KEYWT: wait for a key with the cursor blinking at CURPOS. A = the key. Keeps the other registers.
* [OWNER-SPEC, BB; docs/clean-room-basic.md, "The cursor"] The cursor is the screen byte itself: each pass is a
* cursor update, then a scan. An update counts BLINK down (unsigned: 0 goes to 255); when it reaches 0 it is
* reloaded with 50 and bit 6 of the byte at the address in CURPOS (read from RAM every time) is toggled; then a
* delay of KEYDLY ($0097-$0098) passes less 55 (1,063 at a cold start), so that a whole pass takes the 9,177 cycles
* or so the original's does [BB] (ours scans the keyboard more slowly). A key accepted: $60 is written where the cursor is, and BLINK is left as it is.
KEYWT   PSHS    B,X
KW1     DEC     <BLINK
        BNE     KW2
        LDB     #50             ; (B, which KEYWT keeps: each instruction the cycles A's would take, each write at
        STB     <BLINK          ; the same cycle)
        LDX     <CURPOS
        LDB     ,X
        EORB    #$40
        STB     ,X
KW2     LDX     <KEYDLY         ; 1,118 at a cold start [OWNER-SPEC: the delay; BB bb10 scr-prompt-idle: 4, 94]
        LEAX    -55,X           ; (55 passes fewer: our scan is slower)
        BSR     DELAYX
        JSR     KEYIN
        BEQ     KW1
        LDB     #$60
        LDX     <CURPOS
        STB     ,X
        PULS    B,X,PC

* the characters of the keys, row by row; 0 = no character [HW, UM]
KEYTB   FCC     "01234567"
        FCC     "89:;,-./"
        FCC     "@ABCDEFG"
        FCC     "HIJKLMNO"
        FCC     "PQRSTUVW"
        FCC     "XYZ"
        FCB     $5E,$0A,$08,$09,$20      ; up, down, left, right, space
        FCB     $0D,$0C,$03,0,0,0,0,0    ; ENTER, CLEAR, BREAK
KEYTBS  FCB     $FE
        FCC     "!"
        FCB     $22
        FCC     "#$%&'"
        FCC     "()*+<=>?"
        FCB     $13                      ; SHIFT-@
        FCC     "ABCDEFG"
        FCC     "HIJKLMNO"
        FCC     "PQRSTUVW"
        FCC     "XYZ"
        FCB     $5F,$5B,$15,$5D,$20      ; shifted arrows: _ [ (erase line) ] and space
        FCB     $0D,$5C,$03,0,0,0,0,0    ; ENTER, \ , BREAK

* BRKCHK: between statements: BREAK stops the program
BRKCHK  BSR     BRKTST
        BCS     BRKSTP
        RTS
BRKSTP  JMP     STOPBK
* BRKTST: C set if BREAK is down; SHIFT-@ pauses here until another key is pressed [UM]. Keeps A, X.
BRKTST  PSHS    A
        LDA     #$FB            ; column 2: BREAK is row 6
        STA     PIA0B
        LDA     PIA0A
        BITA    #$40
        BEQ     BRKDN
        LDA     #$FE            ; column 0: @ is row 2
        STA     PIA0B
        LDA     PIA0A
        BITA    #$04
        BNE     BRKNO
        LDA     #$7F            ; with SHIFT?
        STA     PIA0B
        LDA     PIA0A
        BITA    #$40
        BNE     BRKNO
BRKP1   JSR     KEYIN           ; wait for SHIFT-@ to be let go and another key pressed
        BEQ     BRKP1
        CMPA    #$13
        BEQ     BRKP1
        CMPA    #3
        BEQ     BRKYES
BRKNO   ANDCC   #$FE
BRKX    LDA     #$FF            ; (the keyboard's columns back up; LDA and STA leave C as it is)
        STA     PIA0B
        PULS    A,PC
BRKDN   LDA     ROLLTB+2        ; BREAK counts as already down, so the editor does not see it again
        ORA     #$40
        STA     ROLLTB+2
BRKYES  ORCC    #1
        BRA     BRKX
