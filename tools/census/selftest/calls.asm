; The census self-test program (tests/census.test.js): calls into the built-in firmware's ROM stub
; (js/machines/stub.js) the ways a program calls BASIC's ROM. Written for this project; no ROM code.
;
;   1. JSR [$A002]  CHROUT through the vector table (jsr-indirect): prints "H"; clean
;   2. JSR CHROUT   direct (jsr): prints "I"; clean
;   3. JSR NUM      the stub's decimal reader, X at "123" in RAM: D = 123, writes NUMT/NUM2 ($02D8-$02DB); clean
;   4. JSR SKIP     the stub's space skipper with X at a message IN ROM: it loads A from ROM, so A out is a
;                   ROM byte: the guard must refuse this record
;   5. JSR CHROUT   with A still holding that ROM byte: the guard must refuse this record too (what ROM left
;                   in a register is followed to the next call)
;   6. JMP [$A000]  POLCAT through the vector table (jmp-indirect), returning to RET6 by the address pushed first
;
; The stub's internal addresses (NUM, SKIP, OKMSG) are checked against its symbols by the test.
CHROUT  EQU     $B110
NUM     EQU     $B280
SKIP    EQU     $B275
OKMSG   EQU     $B2B2
        ORG     $3000
START   LDA     #'H
        JSR     [$A002]
        LDA     #'I
        JSR     CHROUT
        LDX     #DIGITS
        JSR     NUM
        STD     RESULT
        LDX     #OKMSG
        JSR     SKIP
        JSR     CHROUT
        LDA     #'J
        LDX     #RET6
        PSHS    X
        JMP     [$A000]
RET6    LDA     #1
        STA     DONE
LOOP    BRA     LOOP
DIGITS  FCC     "123"
        FCB     0
RESULT  FDB     0
DONE    FCB     0
        END     START
