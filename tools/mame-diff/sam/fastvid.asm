* SAM fast rate (R1) video diagnostic (tools/mame-diff, written for CLOADM).
*
* Shows a known text screen at the slow rate for about one second, then sets R1 and loops forever reading
* RAM blocks filled with 'A' ($1020-$103F), 'B' ($1040-$105F) and 'C' ($1060-$107F). At R1 the VDG's time
* slot carries MPU addresses (MC6883 data sheet, Figure 3 note 1, p. 6), so the display shows what the RAM
* gives at the CPU's addresses instead of the screen. The loop takes 38 fast cycles, which divides a line
* (114 fast cycles) and so both fields (PAL 312 and NTSC 262 lines): the picture is the same in every field
* and can be compared by screenshot with XRoar; MAME (config.mameCompat) keeps the screen intact.
        ORG     $8000
RESET   ORCC    #$50
        STA     $FFDD           ; 64K
        LDS     #$7F00
        STA     $FFC9           ; F1: display at $0400
        CLR     $FF23           ; PIA1 port B (VDG mode) outputs, all low: text, CSS 0
        LDA     #$F8
        STA     $FF22
        LDA     #$04
        STA     $FF23
        CLR     $FF22
        LDX     #$0400          ; screen: character codes 0-63 repeated
        CLRA
SCR     STA     ,X+
        INCA
        ANDA    #$3F
        CMPX    #$0600
        BNE     SCR
        LDX     #$1020          ; 'A', 'B', 'C' blocks
        LDA     #$01
BLK     STA     ,X+
        CMPX    #$1040
        BNE     BLK1
        INCA
BLK1    CMPX    #$1060
        BNE     BLK2
        INCA
BLK2    CMPX    #$1080
        BNE     BLK
        LDX     #0              ; about one second at the slow rate
WAIT    LEAX    1,X
        CMPX    #$9000
        BNE     WAIT
        STA     $FFD9           ; R1: fast
LOOP    LDA     $1020           ; 7 x 5 + 3 = 38 fast cycles
        LDA     $1040
        LDA     $1060
        LDA     $1020
        LDA     $1040
        LDA     $1060
        LDA     $1020
        BRA     LOOP
        ORG     $BFF2
        FDB     RESET,RESET,RESET,RESET,RESET,RESET,RESET
        END     RESET
