; What does a real HD6309 do with the four opcodes the hardware documentation says do not exist?
;
; $1020, $1050, $1057 and $1058 are where our core and Atkinson part company. Atkinson leaves them blank
; in the opcode map (printed p. 152) and says in words that NEGW, ASRW and ASLW are not provided (printed
; pp. 16, 18 and 101), and note 4 on printed p. 153 calls $1020 illegal on a 6309 while a 6809 runs it as
; LBRA. This firmware runs each of the four and records whether the $FFF0 Illegal Instruction handler ran,
; which is the only thing that distinguishes the two possibilities from the outside.
;
; Each case sets RESUME to its continuation and executes the opcode as raw bytes (FCB: no assembler should
; emit them). A trap vectors through $FFF0 to TRAP, which records the case number in TRAPRUN and jumps to
; that case's continuation, so one run covers all four.
;
; Our own firmware, installed in place of the BASIC ROM, laid out like gen-sweep.js: 16K window at $8000,
; vectors in its last 32 bytes. tools/mame-diff/6309/illegal-probe.js runs it.
CASEN   EQU     $00                     ; direct page: the case now running
TRAPRUN EQU     $01                     ; 0 if nothing trapped, else the case that did
RESUME  EQU     $02                     ; two bytes: where the trap handler returns to
MARK    EQU     $04                     ; the "did not trap" marker
        ORG     $6000
BUF     RMB     $20                     ; per-case results: trapped flag and marker
        ORG     $8000
RESET   LDS     #$2000
        CLRA
        STA     <TRAPRUN
        STA     <CASEN
        LDMD    #$00                    ; emulation mode, FIRQ not as IRQ

; ---------------- case 1: $10 $20 ----------------
        LDA     #1
        STA     <CASEN
        LDD     #RESUME1
        STD     <RESUME
        LDD     #$1111
        FCB     $10,$20
RESUME1 LDD     #$1112                  ; reached only if $10 $20 did not trap
        BRA     CASE2

; ---------------- case 2: $10 $50 ----------------
CASE2   LDA     #2
        STA     <CASEN
        LDD     #RESUME2
        STD     <RESUME
        LDD     #$2222
        FCB     $10,$50
RESUME2 LDD     #$2223
        BRA     CASE3

; ---------------- case 3: $10 $57 ----------------
CASE3   LDA     #3
        STA     <CASEN
        LDD     #RESUME3
        STD     <RESUME
        LDD     #$3333
        FCB     $10,$57
RESUME3 LDD     #$3334
        BRA     CASE4

; ---------------- case 4: $10 $58 ----------------
CASE4   LDA     #4
        STA     <CASEN
        LDD     #RESUME4
        STD     <RESUME
        LDD     #$4444
        FCB     $10,$58
RESUME4 LDD     #$4445
        BRA     CASE5

; ---------------- case 5: DIVD #$00 ----------------
; Not one of the four, but it takes the same trap through the same vector, so it isolates whether any
; cycle difference belongs to the illegal-opcode path or to the trap sequence itself.
CASE5   LDA     #5
        STA     <CASEN
        LDD     #RESUME5
        STD     <RESUME
        LDD     #$0064
        DIVD    #$00
RESUME5 LDD     #$5555
        BRA     CASE6

; ---------------- case 6: SWI3 ----------------
; The instruction that shares the trap's vector and its whole-state push, and whose cycle count the core
; already has: it says whether the discrepancy belongs to the illegal path or to the push sequence.
CASE6   LDA     #6
        STA     <CASEN
        LDD     #RESUME6
        STD     <RESUME
        SWI3
RESUME6 LDD     #$6666
        BRA     CASE7

; ---------------- case 7: DIVD #$02 (no trap) ----------------
; The divide's own cycle count with no trap, to separate "the instruction's cost" from "the trap's".
CASE7   LDA     #7
        STA     <CASEN
        LDD     #RESUME7
        STD     <RESUME
        LDD     #$0064
        DIVD    #$02
RESUME7 LDD     #$7777
        BRA     CASE8

; ---------------- case 8: $15, an undefined page-1 opcode ----------------
; One byte instead of two: with case 1 it says whether the illegal path's overhead differs from the
; trap sequence SWI3 and DIVD already agree on.
CASE8   LDA     #8
        STA     <CASEN
        LDD     #RESUME8
        STD     <RESUME
        FCB     $15
RESUME8 LDD     #$8888
        BRA     CASE9

; ---------------- case 9: $15 in native mode ----------------
; The trap in native mode, where the whole-state frame is wider, so the sequence's cost is measured
; there too. LDMD #$01 switches on native mode, and the case switches back at the end.
CASE9   LDA     #9
        STA     <CASEN
        LDD     #RESUME9
        STD     <RESUME
        LDMD    #$01
        FCB     $15
RESUME9 LDMD    #$00
        LDD     #$9999

; ---------------- done: publish the results and stop ----------------
        LDA     <TRAPRUN
        STA     >BUF+0                  ; 0 = none trapped; 1-4 = that illegal opcode did, 5 = DIVD #0
        LDD     <MARK
        STD     >BUF+1
        BRA     HALT

; ---- the Illegal Instruction handler ($FFF0) ----
; Records the case number, then continues at that case's RESUME so the run measures all four. A, X and
; Y are the only registers it touches, and it saves them: the trap stacks the whole state, but this
; handler returns with JMP rather than RTI, so the firmware's own values must survive.
TRAP    LDA     <CASEN
        STA     <TRAPRUN
        LDX     <RESUME
        JMP     ,X

HALT    BRA     HALT

; ---- the vectors in the last 32 bytes of the 16K window ----
        ORG     $BFF0
        FDB     TRAP                    ; $FFF0: illegal instruction / divide by zero
        FDB     TRAP                    ; $FFF2: SWI3 -> the same handler, for case 6
        FDB     HALT                    ; $FFF4: SWI2
        FDB     HALT                    ; $FFF6: FIRQ
        FDB     HALT                    ; $FFF8: IRQ
        FDB     HALT                    ; $FFFA: SWI
        FDB     HALT                    ; $FFFC: NMI
        FDB     RESET                   ; $FFFE: reset
        END
