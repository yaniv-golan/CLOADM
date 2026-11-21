; cass-sound.asm: our own firmware for the SAM machines' cassette sound (run.js <dragon64|dragon32|coco> --cass-sound),
; in place of the BASIC ROM, with a tape we build ourselves playing (sam/cass-sound.js). It selects the analogue
; sound mux's sources while the tape plays, as BASIC's AUDIO ON does (PIA0 CA2 high, CB2 low: the cassette input;
; PIA1 CB2 high: sound enabled). MAME records it with -wavwrite; ours goes through the command line's recording path.
; Segments of about 0.25 s, separated by about 0.2 s with the DAC selected at 0; PHASE counts them:
;   1. the 6-bit DAC, a square wave between 63 and 0 (the reference for the scale)
;   2. the cassette selected, sound enabled, motor on: the tape heard
;   3. the cassette selected, sound disabled, motor on
;   4. the cassette selected, sound enabled, motor off
;   5. the DAC selected (at 0), sound enabled, motor on: the tape playing but not selected
; then the motor off, the DAC selected, and HALT.
SEG     EQU     3
PHASE   EQU     $0F00
        ORG     $A000
START   ORCC    #$50
        LDS     #$0E00
        CLR     PHASE
        CLR     $FF01
        LDA     #$34
        STA     $FF01           ; PIA0 CA2 low
        CLR     $FF03
        STA     $FF03           ; PIA0 CB2 low: the mux on the DAC
        CLR     $FF21
        LDA     #$FC
        STA     $FF20           ; DDRA: PA2-PA7 the DAC
        LDA     #$34
        STA     $FF21           ; CA2 low: motor off
        CLR     $FF20           ; DAC 0
        CLR     $FF23
        LDA     #$02
        STA     $FF22
        LDA     #$3C
        STA     $FF23           ; CB2 high: sound enabled
        CLR     $FF22
        LBSR     GAP
; 1: DAC square 63/0
        INC     PHASE
        LDY     #SEG*256
        LDA     #$FC
D1      STA     $FF20
        LDB     #30
D2      DECB
        NOP
        NOP
        BNE     D2
        EORA    #$FC
        LEAY    -1,Y
        BNE     D1
        CLR     $FF20
        INC     PHASE
        LDA     #$3C
        STA     $FF21           ; motor on (the tape starts moving)
        LBSR     GAP
; 2: cassette selected, sound on, motor on
        INC     PHASE
        LDA     #$3C
        STA     $FF01           ; PIA0 CA2 high: the cassette
        LBSR     SEGW
        INC     PHASE
        LDA     #$34
        STA     $FF01
        LBSR     GAP
; 3: cassette selected, sound off
        INC     PHASE
        LDA     #$34
        STA     $FF23           ; sound disabled
        LDA     #$3C
        STA     $FF01
        LBSR     SEGW
        INC     PHASE
        LDA     #$34
        STA     $FF01
        LDA     #$3C
        STA     $FF23
        LBSR     GAP
; 4: cassette selected, sound on, motor off
        INC     PHASE
        LDA     #$34
        STA     $FF21           ; motor off
        LDA     #$3C
        STA     $FF01
        LBSR     SEGW
        INC     PHASE
        LDA     #$34
        STA     $FF01
        LDA     #$3C
        STA     $FF21           ; motor on
        LBSR     GAP
; 5: the DAC selected (0), motor on
        INC     PHASE
        LBSR     SEGW
        INC     PHASE
        LDA     #$34
        STA     $FF21           ; motor off
        LBSR     GAP
HALT    BRA     HALT

; SEGW: about 0.25 s
SEGW    LDY     #SEG*10000
S1      LEAY    -1,Y
        BNE     S1
        RTS
; GAP: about 0.2 s
GAP     LDY     #SEG*8000
G1      LEAY    -1,Y
        BNE     G1
        RTS

        ORG     $BFF2
        FDB     START,START,START,START,START,START,START
