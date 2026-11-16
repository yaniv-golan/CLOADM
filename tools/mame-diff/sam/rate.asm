* SAM MPU rate diagnostic (tools/mame-diff, written for CLOADM).
*
* For each rate setting it measures, against the VDG field sync (PIA0 CB1, polled at $FF03), how many times
* loops run in one field: a loop in ROM, the same loop copied to RAM, and a loop mixing every kind of address
* (RAM, ROM, I/O at $FF00 and $FF20, VMA cycles). Counts go to RES ($0100 up) and through X, so a lockstep
* comparison sees every one. It switches rate mid-frame, uses the datasheet's sequence for leaving the
* address-dependent rate, runs map type 1 (RAM at $8000) at the address-dependent rate, and ends in HALT.
*
* SAM rate bits (MC6883 data sheet, p. 16): R0 clear $FFD6 / set $FFD7, R1 clear $FFD8 / set $FFD9.
RES     EQU     $0100
RAMLP   EQU     $3000
        ORG     $8000
RESET   ORCC    #$50
        STA     $FFDD           ; M1: 64K dynamic RAM
        LDS     #$7F00
        CLRA
        TFR     A,DP
        LDX     #$0000
CLR     CLR     ,X+
        CMPX    #$3000          ; (MAME and we fill uninitialised RAM differently)
        BNE     CLR
        CLR     $FF01           ; PIA0: DDRs, then data registers, CA1/CB1 flags enabled
        CLR     $FF00
        CLR     $FF03
        LDA     #$FF
        STA     $FF02
        LDA     #$34
        STA     $FF01
        STA     $FF03
        CLR     $FF21           ; PIA1 likewise
        LDA     #$FE
        STA     $FF20
        LDA     #$34
        STA     $FF21
        LDA     #$02            ; PA1 (CoCo serial out) idles high, as BASIC leaves it
        STA     $FF20
        CLR     $FF23
        LDA     #$FC
        STA     $FF22
        LDA     #$34
        STA     $FF23
        LDX     #LOOPS          ; copy the field loop to RAM
        LDY     #RAMLP
CP      LDA     ,X+
        STA     ,Y+
        CMPX    #LOOPSE
        BNE     CP
        LDU     #RES
        LDY     #$0200          ; RAM operand for the mixed loop
* ---- rate 00 (slow), 01 (address dependent), 10 and 11 (fast) ----
        JSR     MEAS
        STA     $FFD7           ; R0: address dependent
        JSR     MEAS
        STA     $FFD9           ; R1 too: fast (11)
        JSR     MEAS
        STA     $FFD6           ; R0 off: fast (10)
        JSR     MEAS
        STA     $FFD7           ; fast -> address dependent: set R0, then clear R1 (p. 11)
        STA     $FFD8
        JSR     MEAS
* ---- leave the address-dependent rate with the data sheet's sequence #1 (p. 11) ----
        TST     $0000
        BRN     *
        STA     $FFD6
        JSR     MEAS
* ---- switch rate mid-field: address dependent for half of a field loop, then slow ----
        JSR     SYNCFS
        LDX     #0
        STA     $FFD7
MID     LEAX    1,X
        CMPX    #900
        BNE     MID
        STA     $FFD6
MID2    LEAX    1,X
        LDA     $FF03
        BPL     MID2
        LDA     $FF02
        STX     ,U++
* ---- map type 1 (RAM at $8000-$FEFF) at the address-dependent rate: run from RAM, read RAM above $8000 ----
        LDX     #TYCODE
        LDY     #$3100
TYCP    LDA     ,X+
        STA     ,Y+
        CMPX    #TYEND
        BNE     TYCP
        JSR     $3100
        STX     ,U++
        LDY     #$0200          ; (the copy loop moved Y)
* ---- back to slow; done ----
        STA     $FFD8
        STA     $FFD6
        JSR     MEAS
        LDX     #RES
        LDA     #$01
HALT    BRA     HALT

* wait for the next field sync (clear the flag, then poll it)
SYNCFS  LDA     $FF02
SY1     LDA     $FF03
        BPL     SY1
        LDA     $FF02
        RTS

* one measurement: ROM loop, RAM loop, mixed loop; one field each
MEAS    JSR     SYNCFS
        LDX     #0
RL      LEAX    1,X
        LDA     $FF03
        BPL     RL
        LDA     $FF02
        STX     ,U++
        JSR     RAMLP
        STX     ,U++
        JSR     SYNCFS
        LDX     #0
ML      LEAX    1,X
        LDA     $1234           ; RAM
        LDB     BANKB           ; ROM
        LDA     $FF21           ; I/O, PIA1 control (fast at the address-dependent rate)
        LDB     $FF00           ; I/O, PIA0 (slow at the address-dependent rate)
        ADDD    ,Y              ; indexed, Y in RAM
        MUL                     ; nine VMA cycles
        PSHS    A,B
        PULS    A,B
        LDA     $FF03
        BPL     ML
        LDA     $FF02
        STX     ,U++
        RTS
BANKB   FCB     $5A

* the RAM copy of the field loop (position independent)
LOOPS   LDX     #0
        LDA     $FF02
LW      LDA     $FF03
        BPL     LW
        LDA     $FF02
LR      LEAX    1,X
        LDA     $FF03
        BPL     LR
        LDA     $FF02
        RTS
LOOPSE  EQU     *

* map type 1 code, run from RAM at $3100: count a field of reads from RAM at $9000 at the address-dependent rate
TYCODE  STA     $FFDF           ; TY: map type 1
        STA     $FFD7           ; R0
        LDA     #$A5
        STA     $9000
        LDA     $FF02
TW      LDA     $FF03
        BPL     TW
        LDA     $FF02
        LDX     #0
TL      LEAX    1,X
        LDA     $9000
        LDA     $FF03
        BPL     TL
        LDA     $FF02
        STA     $FFD6
        STA     $FFDE           ; back to map type 0
        RTS
TYEND   EQU     *

IRQH    RTI
        ORG     $BF00
        FCB     $11
        ORG     $BFF2
        FDB     IRQH,IRQH,IRQH,IRQH,IRQH,IRQH,RESET
        END     RESET
