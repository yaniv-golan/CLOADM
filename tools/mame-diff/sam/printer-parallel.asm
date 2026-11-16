* Dragon parallel printer diagnostic (tools/mame-diff, written for CLOADM; run.js <dragon> --printer).
*
* Prints every byte value 0-255 and then a line of text through the Dragon's printer port: the byte goes on
* PIA0 port B (all outputs), then PIA1 PA1 (the strobe) is pulsed high and low. A PIA1 port A write with PA1 high
* prints whatever PIA0 port B shows (MAME dragon.cpp pia1_pa_changed), so the setup also checks that writes with
* the strobe low, and the DDR writes, print nothing. PIA1 PB0 (printer busy) is read before each byte, as BASIC
* does, and ignored. $7000 counts the bytes sent; $7001 = $FF once the firmware is done.
STAT    EQU     $7000
DONE    EQU     $7001
        ORG     $8000
RESET   ORCC    #$50
        LDS     #$7F00
        CLR     STAT
        CLR     DONE
        ; PIA0 port B: outputs (the printer's data lines)
        CLR     $FF03
        LDA     #$FF
        STA     $FF02
        LDA     #$04
        STA     $FF03
        CLR     $FF02
        ; PIA1 port A: PA1-PA7 outputs (strobe and DAC), PA0 input; the DDR is written while the output
        ; register holds 0, so the strobe stays low
        CLR     $FF21
        CLR     $FF20
        LDA     #$FE
        STA     $FF20
        LDA     #$34
        STA     $FF21
        CLR     $FF20           ; strobe low: prints nothing
        LDA     #$FC
        STA     $FF20           ; DAC bits only, strobe low: prints nothing
        CLR     $FF20
        ; every byte value
        CLRA
ALL     BSR     PRINT
        INCA
        BNE     ALL
        ; and a line of text
        LDX     #TEXT
TXT     LDA     ,X+
        BEQ     FIN
        BSR     PRINT
        BRA     TXT
FIN     LDA     #$FF
        STA     DONE
HALT    BRA     HALT

* print A: data on PIA0 PB, then the strobe high and low
PRINT   LDB     $FF22           ; PIA1 PB0: printer busy (read, not waited on)
        STA     $FF02
        LDB     #$02
        STB     $FF20           ; strobe high: the printer takes PIA0 PB
        CLR     $FF20           ; strobe low
        INC     STAT
        RTS

TEXT    FCC     "CLOADM PRINTER TEST, DRAGON PARALLEL PORT"
        FCB     13,10,0
        ORG     $BFF2
        FDB     RESET,RESET,RESET,RESET,RESET,RESET,RESET
        END     RESET
