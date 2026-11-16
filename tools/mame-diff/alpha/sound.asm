; sound.asm: our own 8K boot ROM for the Dragon Alpha's sound (run.js dgnalpha --sound), in place of
; alpha_bt_10.rom. MAME records it with -wavwrite; tools/mame-diff/alpha/sound-compare.js renders ours and
; compares. Segments of SEG (about 0.4 s) each, separated by SEG/2 of silence:
;   1. channel A tone, period $100 (244 Hz), volume 15
;   2. channel B period $080 (488 Hz) volume 10 with channel C period $040 (977 Hz) volume 6
;   3. noise on channel A (noise period $0F), volume 12
;   4. channel A on the envelope (tone and noise off): shape $0E (triangle), period $0080
;   5. channel A envelope shape $0D (attack, hold), period $0800
;   6. the 6-bit DAC alone: a square wave between $00 and $FC (the AY at volume 0), the AY-to-DAC level check
; then everything off and HALT. $7000 counts the segments (both emulators can be lined up on it).
SEG     EQU     50000           ; delay loop count: 8 cycles each, ~0.45 s
PHASE   EQU     $7000
        ORG     $A000
START   ORCC    #$50
        LDS     #$7F00
        CLR     PHASE
; PIA0: CA2 and CB2 outputs low (the sound mux on the DAC); PIA1: DAC outputs, CB2 high (sound on)
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
        LDA     #$3C
        STA     $FF23           ; CB2 high: sound enabled
; PIA2: port A bits 0-2 out, idle $04 (PA2 high keeps the boot ROM); port B outputs
        CLR     $FF25
        LDA     #$07
        STA     $FF24
        LDA     #$34
        STA     $FF25
        LDA     #$04
        STA     $FF24
        CLR     $FF27
        LDA     #$FF
        STA     $FF26
        LDA     #$04
        STA     $FF27
; AY: everything silent, port A an output (no drive selected)
        LDX     #SILENT
        JSR     AYTAB
        JSR     GAP
; 1. channel A, $100, volume 15
        LDX     #SEG1
        JSR     PLAY
; 2. B $080 volume 10, C $040 volume 6
        LDX     #SEG2
        JSR     PLAY
; 3. noise on A
        LDX     #SEG3
        JSR     PLAY
; 4. envelope triangle on A
        LDX     #SEG4
        JSR     PLAY
; 5. envelope attack-hold on A
        LDX     #SEG5
        JSR     PLAY
; 6. the DAC alone: square wave, 64 + 64 loops of 8 cycles per half period (~870 Hz) for ~0.45 s
        INC     PHASE
        LDY     #390
SQ      LDA     #$FC
        STA     $FF20
        LDX     #64
SQ1     LEAX    -1,X
        BNE     SQ1
        CLR     $FF20
        LDX     #64
SQ2     LEAX    -1,X
        BNE     SQ2
        LEAY    -1,Y
        BNE     SQ
        INC     PHASE
        JSR     GAP
HALT    BRA     HALT

; PLAY: the register table at X, hold SEG, silence, hold SEG/2
PLAY    INC     PHASE
        JSR     AYTAB
        LDX     #SEG
P1      LEAX    -1,X
        BNE     P1
        INC     PHASE
        LDX     #SILENT
        JSR     AYTAB
GAP     LDX     #SEG/2
G1      LEAX    -1,X
        BNE     G1
        RTS
; AYTAB: (register, value) pairs at X until register $FF
AYTAB   LDB     ,X+
        CMPB    #$FF
        BEQ     AT1
        LDA     ,X+
        BSR     AYWR
        BRA     AYTAB
AT1     RTS
; AYWR: AY register B = A, through PIA2 (port A $07 latches the address, $05 writes, $04 idle)
AYWR    STB     $FF26
        LDB     #$07
        STB     $FF24
        LDB     #$04
        STB     $FF24
        STA     $FF26
        LDB     #$05
        STB     $FF24
        LDB     #$04
        STB     $FF24
        RTS

SILENT  FCB     7,$7F,8,0,9,0,10,0,$FF
SEG1    FCB     0,$00,1,$01,7,$7E,8,15,$FF
SEG2    FCB     2,$80,3,$00,4,$40,5,$00,7,$79,9,10,10,6,$FF
SEG3    FCB     6,$0F,7,$77,8,12,$FF
SEG4    FCB     11,$80,12,$00,13,$0E,7,$7F,8,$10,$FF
SEG5    FCB     11,$00,12,$08,13,$0D,7,$7F,8,$10,$FF

        ORG     $BFF2
        FDB     START,START,START,START,START,START,START
