; SAM counter probe (tools/mame-diff/sam, written for CLOADM).
;
; Puts a byte tagged with its address at every display address and shows the same address range at two SAM V
; modes, so the two emulators' pictures say which addresses the SAM's display counter fetched, in which order.
; Built for the V=1 text question: at V=1 the SAM divides as for 16 bytes a line, but the VDG still fetches
; 32 text samples, so the counter's carry chain decides which bytes are actually read.
;
; The picture is in text mode, and every byte is tagged with its address: byte = (low byte) XOR (high byte),
; so a line of 32 bytes has 32 different values and two addresses that share a value are at least 255 apart.
; Two phases, each held for 20 fields: V=0 ($00) and V=1 ($01). F stays 0 so the display starts at $0000.
;
;   node tools/mame-diff/sam/run-samv.js <profile>     compares every pixel of both phases with MAME
PHASE   EQU     $7000           ; the phase number, read by both emulators' capture scripts
        ORG     $8000
RESET   ORCC    #$50
        STA     $FFDD           ; SAM M1 = 1 (M1/M0 = 10): 64K RAM
        LDS     #$7F00
        CLRA
        TFR     A,DP
        ; PIA0 B: outputs (keyboard strobes idle high); PIA1 B: the VDG's inputs, text mode, CSS 0
        CLR     $FF03
        LDA     #$FF
        STA     $FF02
        LDA     #$34
        STA     $FF03
        CLR     $FF23           ; CRB bit 2 clear: $FF22 is the DDR
        LDA     #$FF            ; port B: all outputs
        STA     $FF22
        LDA     #$34            ; CRB bit 2 set: $FF22 is the data register
        STA     $FF23
        CLR     $FF22           ; A/G 0, GM 0, INT/EXT 0, CSS 0: text mode
        ; every display address gets a byte of its own: byte = (low byte of the address) XOR (high byte)
        LDX     #$0000
GX      TFR     X,D             ; A = high byte, B = low byte
        PSHS    A,B
        EORB    ,S              ; B = low ^ high (PSHS A,B leaves A at 0,S)
        LEAS    2,S
        STB     ,X+
        CMPX    #$2000
        BLO     GX
        ; $0000, the first byte of every field, is the redraw toggle: MAME redraws its screen bitmaps only
        ; when the fetched bytes change, and keeps two of them, so a still picture can leave the capture
        ; holding a stale one. HOLD flips this byte between $80 and $90 every field: both are semigraphics 4
        ; with no block lit, drawn black whatever the colour bits, so the picture never changes but every
        ; field is a redraw
        LDA     #$80
        STA     $0000
        CLRA
        TFR     A,DP
        CLR     PHASE
        ; ---- phase 1: V = 0 ----
        LDA     #$00
        STA     $FFC0           ; clear V0
        STA     $FFC2           ; clear V1
        STA     $FFC4           ; clear V2
        CLR     $FFC6           ; F0 = 0 (display starts at $0000)
        INC     PHASE
        BSR     HOLD
        ; ---- phase 2: V = 1 ----
        STA     $FFC1           ; set V0
        INC     PHASE
        BSR     HOLD
        LDA     #$FF
        STA     PHASE
HALT    BRA     HALT

; hold for 20 fields (enough for both emulators to capture a settled picture)
HOLD    LDB     #20
HOLD1   LDA     $FF02
HWFS    LDA     $FF03           ; wait for FS to fall (end of the active area)
        BPL     HWFS
        LDA     $0000           ; flip the redraw toggle
        EORA    #$10
        STA     $0000
        LDA     $FF02
HWFR    LDA     $FF03           ; and rise again
        BMI     HWFR
        DECB
        BNE     HOLD1
        RTS

        ORG     $BFF2
        FDB     HALT,HALT,HALT,HALT,HALT,HALT,HALT
        ORG     $BFFE
        FDB     RESET
        END     RESET
