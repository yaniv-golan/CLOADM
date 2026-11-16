* Hi-Res joystick interface diagnostic (tools/mame-diff, written for CLOADM).
*
* The Tandy Hi-Res Joystick interface replaces the joystick in a controller port. Instead of
* the DAC comparator it runs a one-shot whose time is proportional to the stick's position, and the machine
* sees its state as JOYIN (PIA0 PA7): low while the one-shot runs, high when it has expired (MAME 0.264
* poll_joystick: high when the timer's remaining time is zero). This firmware measures that time by counting
* a fixed-length loop until JOYIN rises, on both axes, and stores the counts at RES. The comparison runs
* MAME with the same interface selected and the same stick positions and requires the same counts.
*
* This build measures the Tandy interface: started by the DAC (PIA1 PA2-PA7) falling below $20, and it fires after 535 + 5850 x position
* microseconds.
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
        LDA     #$3C           ; CA2 high: the Y axis
        STA     $FF01
        LDA     #$34           ; CB2 low: the right port, where the Rat is fitted
        STA     $FF03
        LDA     #$00
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$04
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$08
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$0C
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$10
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$14
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$18
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$1C
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$20
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$24
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$28
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$2C
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$30
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$34
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$38
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$3C
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$40
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$44
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$48
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$4C
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$50
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$54
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$58
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$5C
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$60
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$64
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$68
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$6C
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$70
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$74
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$78
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$7C
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$80
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$84
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$88
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$8C
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$90
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$94
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$98
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$9C
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$A0
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$A4
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$A8
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$AC
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$B0
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$B4
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$B8
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$BC
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$C0
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$C4
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$C8
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$CC
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$D0
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$D4
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$D8
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$DC
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$E0
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$E4
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$E8
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$EC
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$F0
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$F4
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$F8
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
        LDA     #$FC
        STA     $FF20           ; DAC value in PIA1 PA2-PA7
        LDA     $FF00           ; JOYIN: 1 when the DAC is at or below the table value
        ANDA    #$80
        LSRA                    ; bit 7 into bit 0
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        LSRA
        STA     ,X+             ; one byte per DAC step
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
