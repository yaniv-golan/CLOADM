* Hi-Res joystick interface diagnostic (tools/mame-diff, written for CLOADM).
*
* The CoCo Max 3 interface replaces the joystick in a controller port. Instead of
* the DAC comparator it runs a one-shot whose time is proportional to the stick's position, and the machine
* sees its state as JOYIN (PIA0 PA7): low while the one-shot runs, high when it has expired (MAME 0.264
* poll_joystick: high when the timer's remaining time is zero). This firmware measures that time by counting
* a fixed-length loop until JOYIN rises, on both axes, and stores the counts at RES. The comparison runs
* MAME with the same interface selected and the same stick positions and requires the same counts.
*
* This build measures the CoCo Max 3 interface: started by PIA0 PA2 (right port) going low, and it fires after 380 + 2885 x position microseconds.
* The axis is PIA0 CA2 (X when low, Y when high) and the port PIA0 CB2 (right when low, left when high:
* MAME's sel2() true selects the second joystick, and its first is the right port's).
*
* A sample stops the one-shot first, waits for it to reset, starts it, and counts until JOYIN rises. The
* stick positions are MAME's joystick input ports, set by the run script; the firmware does not touch them.
PHASE   EQU     $0100
RESPT   EQU     $0102           ; where the next 16-bit sample goes
RES     EQU     $0110           ; ten 16-bit samples
N       EQU     2               ; loop iterations between two JOYIN polls (the same in both emulators)
        ORG     $8000
RESET   ORCC    #$50
        LDS     #$7F00
        CLRA
        TFR     A,DP
        LDX     #$0000
CLR     CLR     ,X+
        CMPX    #$0400
        BNE     CLR
        CLR     $FF01           ; PIA0: DDRs first
        LDA     #$04
        STA     $FF00           ; PA2 only: it drives the CoCo Max 3 one-shot, and PA7 (JOYIN) stays an input
        LDA     #$FF
        STA     $FF02           ; PB: the keyboard columns are inputs
        LDA     #$3C           ; CRA: CA2 output, manual, low
        STA     $FF01
        LDA     #$3C           ; CRB: CB2 output, manual, low
        STA     $FF03
        CLR     $FF21           ; PIA1 CRA: after a reset CR bit 2 selects the DDR...
        LDA     #$FF
        STA     $FF20           ; ...so DDR: the DAC is all output
        LDA     #$34
        STA     $FF21           ; CRA: the data register now (C2 manual, high)
        LDX     #RES
        STX     RESPT
        LDA     #$34           ; CB2 low: right port
        STA     $FF03
        LDA     #$34           ; CA2 low: X axis
        STA     $FF01
        LDA     #$80
        STA     $FF20           ; DAC $20: a Tandy circuit would be idle
        LDA     #$FC
        STA     $FF00           ; PA2 high: stop the one-shot
        LBSR    SETTLE
        LDA     #$F8
        STA     $FF00           ; PA2 low: start it
        LBSR    MEASURE
        LDA     #$FC
        STA     $FF00           ; PA2 high: stop the one-shot
        LBSR    SETTLE
        LDA     #$F8
        STA     $FF00           ; PA2 low: start it
        LBSR    MEASURE
        LDA     #$FC
        STA     $FF00           ; PA2 high: stop the one-shot
        LBSR    SETTLE
        LDA     #$F8
        STA     $FF00           ; PA2 low: start it
        LBSR    MEASURE
        LDA     #$FC
        STA     $FF00           ; PA2 high: stop the one-shot
        LBSR    SETTLE
        LDA     #$F8
        STA     $FF00           ; PA2 low: start it
        LBSR    MEASURE
        LDA     #$FC
        STA     $FF00           ; PA2 high: stop the one-shot
        LBSR    SETTLE
        LDA     #$F8
        STA     $FF00           ; PA2 low: start it
        LBSR    MEASURE
        LDA     #$3C           ; CA2 high: Y axis
        STA     $FF01
        LDA     #$FC
        STA     $FF00           ; PA2 high: stop the one-shot
        LBSR    SETTLE
        LDA     #$F8
        STA     $FF00           ; PA2 low: start it
        LBSR    MEASURE
        LDA     #$FC
        STA     $FF00           ; PA2 high: stop the one-shot
        LBSR    SETTLE
        LDA     #$F8
        STA     $FF00           ; PA2 low: start it
        LBSR    MEASURE
        LDA     #$FC
        STA     $FF00           ; PA2 high: stop the one-shot
        LBSR    SETTLE
        LDA     #$F8
        STA     $FF00           ; PA2 low: start it
        LBSR    MEASURE
        LDA     #$FC
        STA     $FF00           ; PA2 high: stop the one-shot
        LBSR    SETTLE
        LDA     #$F8
        STA     $FF00           ; PA2 low: start it
        LBSR    MEASURE
        LDA     #$FC
        STA     $FF00           ; PA2 high: stop the one-shot
        LBSR    SETTLE
        LDA     #$F8
        STA     $FF00           ; PA2 low: start it
        LBSR    MEASURE
        LDA     #$0A
        STA     PHASE           ; phase 10: every sample recorded
        JMP     HALT
* Count N-iteration loops until JOYIN rises, in X (16-bit; $FFFF means it never rose). The result goes to
* the pointer in RESPT, which moves on by two, so the caller keeps no state of its own.
MEASURE LDX     #0
M1      LEAX    1,X
        CMPX    #$FFFF
        BEQ     M1DONE          ; counted to the sentinel without seeing JOYIN
        LDY     #N
M2      LEAY    -1,Y
        BNE     M2
        LDA     $FF00
        BPL     M1              ; PA7 low: still running
M1DONE  TFR     X,D             ; the count in D
        LDX     RESPT
        STD     ,X++
        STX     RESPT
        RTS
* Let a stopped one-shot reset (its reset time is not part of the measurement)
SETTLE  PSHS    Y
        LDY     #300
S1      LEAY    -1,Y
        BNE     S1
        PULS    Y,PC
HALT    BRA     HALT
        ORG     $BFF0
        FDB     RESET,RESET,RESET,RESET,RESET,RESET,RESET,RESET
        END     RESET
