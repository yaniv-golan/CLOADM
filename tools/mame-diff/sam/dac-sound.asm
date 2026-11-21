; dac-sound.asm: our own firmware for the SAM machines' sound output (run.js <dragon64|dragon32|coco> --sound), in
; place of the BASIC ROM. MAME records it with -wavwrite; sam/dac-sound.js runs it here, through the command line's
; recording path (AudioOutput without its DC filter, as `cloadm --wav`), and compares. Segments of 0.25 to 0.7 s,
; separated by about 0.2 s with the DAC at 0:
;   1. the 6-bit DAC, a square wave between 63 and 0, about 1.6 kHz on a Dragon
;   2. the same, about 0.5 kHz
;   3. between 32 and 0 (half the swing: the DAC's scale)
;   4. between 63 and 32 (the upper half)
;   5. the single-bit sound (PIA1 PB1) as a square wave, the DAC at 0
; then the DAC at 0 and HALT. PHASE counts the segments, so both recordings can be lined up on them.
SEG     EQU     3               ; segment and gap length factor (about 0.25 s and 0.2 s on a Dragon)
PHASE   EQU     $0F00           ; inside the first 4K (the SAM's memory size is not set)
        ORG     $A000
START   ORCC    #$50
        LDS     #$0E00
        CLR     PHASE
; PIA0: CA2 and CB2 outputs low (the sound mux on the DAC); PIA1: DAC outputs, CB2 high (sound on), PB1 output
        CLR     $FF01
        LDA     #$34
        STA     $FF01
        CLR     $FF03
        STA     $FF03
        CLR     $FF21
        LDA     #$FC
        STA     $FF20           ; DDRA: PA2-PA7 the DAC
        LDA     #$34
        STA     $FF21
        CLR     $FF20           ; DAC 0
        CLR     $FF23
        LDA     #$02
        STA     $FF22           ; DDRB: PB1 (the single-bit sound) an output
        LDA     #$3C
        STA     $FF23           ; CB2 high: sound enabled
        CLR     $FF22           ; single-bit sound low
        BSR     GAP
; 1-4: DAC squares (HI, LO, delay count)
        LDX     #SQ1
        LDB     #4
SQL     PSHS    B
        INC     PHASE           ; segment start
        BSR     DACSQ
        INC     PHASE           ; segment end
        CLR     $FF20
        BSR     GAP
        LEAX    3,X
        PULS    B
        DECB
        BNE     SQL
; 5: the single-bit sound
        INC     PHASE
        LDY     #SEG*60
SB1     LDA     #$02
        STA     $FF22
        LDA     #120
SB2     DECA
        BNE     SB2
        CLR     $FF22
        LDA     #120
SB3     DECA
        BNE     SB3
        LEAY    -1,Y
        BNE     SB1
        INC     PHASE
        BSR     GAP
HALT    BRA     HALT

; DACSQ: X -> (HI, LO, count): SEG x 256 half periods of about 9 x count cycles, alternating HI and LO (the pitch is
; measured in both recordings, not assumed)
DACSQ   LDY     #SEG*256
        LDA     ,X
DS1     STA     $FF20
        LDB     2,X
DS2     DECB                    ; 2
        NOP                     ; 2
        NOP                     ; 2
        BNE     DS2             ; 3
        CMPA    ,X              ; HI -> LO, LO -> HI
        BEQ     DS3
        LDA     ,X
        BRA     DS4
DS3     LDA     1,X
DS4     LEAY    -1,Y
        BNE     DS1
        RTS
; GAP: about 0.2 s of silence
GAP     LDY     #SEG*8000
G1      LEAY    -1,Y
        BNE     G1
        RTS

SQ1     FCB     $FC,$00,30
        FCB     $FC,$00,90
        FCB     $80,$00,30
        FCB     $FC,$80,30

        ORG     $BFF2
        FDB     START,START,START,START,START,START,START
