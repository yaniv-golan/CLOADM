; The census self-test program (tests/census.test.js): calls into the built-in firmware's ROM stub
; (js/machines/stub.js) the ways a program calls BASIC's ROM. Written for this project; no ROM code.
;
;   1. JSR [$A002]  CHROUT through the vector table (jsr-indirect): prints "H"; clean
;   2. JSR CHROUT   direct (jsr): prints "I"; clean
;   3. JSR NUM      the stub's decimal reader, X at "123" in RAM: D = 123, writes NUMT/NUM2 ($02D8-$02DB); clean
;   4. JMP [$A000]  POLCAT through the vector table (jmp-indirect), returning to RET4 by the address pushed first
;   5. JSR SKIP     the stub's space skipper with X at a message IN ROM: it reads ROM data, so the record is
;                   refused (addresses only), and recording stops when it returns: A now holds a ROM byte
;   6. JSR CHROUT   with that byte in A: never recorded
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
        LDX     #RET4
        PSHS    X
        JMP     [$A000]
RET4    LDX     #OKMSG
        JSR     SKIP
        JSR     CHROUT
        LDA     #1
        STA     DONE
LOOP    BRA     LOOP
DIGITS  FCC     "123"
        FCB     0
RESULT  FDB     0
DONE    FCB     0
        END     START
