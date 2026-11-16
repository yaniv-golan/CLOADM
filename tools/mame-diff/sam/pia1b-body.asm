* pia1b-body.asm (INCLUDEd by sam/pia1b.asm and coco3/pia1b.asm): PIA1 port B's input pins on the CoCo. MAME 0.264
* (src/mame/trs/coco.cpp, coco_state::pia1_pb_r) drives bit 2, the RAM size sense (with 32K or more, PIA0 PB6 as
* it is output: a pin set as an input counts as high), and bit 0, serial in (no device: low); the other pins read
* 0. Each read goes through A, so the lockstep comparison sees it. PIA0 PB6 is set high, low and as an input,
* with PIA1's port B all inputs, half outputs and all outputs.
PIA1B   CLR     $FF03           ; PIA0 B: DDR, all outputs, then the data register
        LDA     #$FF
        STA     $FF02
        LDA     #$04
        STA     $FF03
        LDX     #DDRS
P1      LDA     ,X+             ; next PIA1 port B direction ($AA ends the list)
        CMPA    #$AA
        BEQ     P3
        CLR     $FF23
        STA     $FF22           ; DDRB
        LDA     #$04
        STA     $FF23
        LDA     #$A5
        STA     $FF22           ; output register (shows on the output pins)
        LDA     #$40            ; PIA0 PB6 high
        STA     $FF02
        LDA     $FF22
        CLR     $FF02           ; low
        LDA     $FF22
        CLR     $FF03           ; PB6 an input
        LDA     #$BF
        STA     $FF02
        LDA     #$04
        STA     $FF03
        LDA     $FF22
        CLR     $FF03           ; back to all outputs
        LDA     #$FF
        STA     $FF02
        LDA     #$04
        STA     $FF03
        BRA     P1
P3      RTS
DDRS    FCB     $00,$FE,$FB,$F8,$FA,$FF,$AA
