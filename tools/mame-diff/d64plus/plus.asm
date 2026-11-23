; The Dragon 64 Plus's 80-column board, for the lockstep comparison with MAME (tools/mame-diff/d64plus).
; Our own firmware, installed in the two BASIC ROM sockets. It:
;   1. programs every HD6845S register (R0-R15) with a register set that matches MAME's plus_screen
;      geometry (114 characters a line, 26 rows of 12 plus 4 adjust, 80 x 22 displayed), reading CRTC R12-R15
;      back through $FFE1 (the HD6845S can, the MC6845 cannot);
;   2. writes a known pattern of character codes into the video RAM bank ($FFE2 write with bit 0 set
;      selects it over $0000-$07FF), covering the whole 2K;
;   3. switches the 32K bank ($FFE2 bits 1-2: 0 standard, 2 bank A, 6 bank B), writing a distinct byte at
;      the same address in each so the switch is observable in RAM, then returns to the standard bank;
;   4. sets the cursor (R14/R15, R10/R11) and moves the start address (R12/R13) part way, exercising the
;      registers mid-frame;
;   5. polls $FFE2 and stores a few samples of its DE status;
;   6. halts. Every access above appears in the MAME trace, so the registers, the bank register and the
;      display-enable port are compared instruction for instruction.
        ORG     $8000
RESET   ORCC    #$50
        LDS     #$7F00
        LDA     #$00
        STA     $FFDD           ; SAM M1=1: 64K dynamic RAM, as BASIC sets at boot
        JSR     CRTCINIT
        JSR     FILLVIDEO
        JSR     BANKS
        JSR     CURSOR
        JSR     DE
        JMP     HALT

; ---- every CRTC register, then read R12-R15 back ----
CRTCINIT
        LDX     #CRTCTAB
        LDB     #$00
CI1     LDA     ,X+
        PSHS    B
        STB     $FFE0           ; register address
        STA     $FFE1           ; its value
        CMPA    #$00            ; (dead compare: keeps the byte in A for the trace)
        PULS    B
        INCB
        CMPB    #16
        BNE     CI1
        ; read the four readable registers back
        LDA     #12
        STA     $FFE0
        LDA     $FFE1           ; CRTC R12
        STA     $2000
        LDA     #13
        STA     $FFE0
        LDA     $FFE1           ; CRTC R13
        STA     $2001
        LDA     #14
        STA     $FFE0
        LDA     $FFE1           ; CRTC R14
        STA     $2002
        LDA     #15
        STA     $FFE0
        LDA     $FFE1           ; CRTC R15
        STA     $2003
        RTS

; ---- the video RAM bank: $FFE2 bit 0 set selects it over $0000-$07FF ----
FILLVIDEO
        LDA     #$01
        STA     $FFE2           ; bit 0: video RAM bank
        LDX     #$0000
        LDB     #$00
FV1     STB     ,X+
        INCB
        CMPX    #$0800
        BNE     FV1
        ; a marker at the top of the visible window (MA 0 = $0000), so the picture proves the bank
        LDA     #$41
        STA     $0000
        LDA     #$42
        STA     $0001
        LDA     #$43
        STA     $0050           ; row 1, column 0 (80 characters a row)
        ; clear the standard 64K inside the video window's reach too, so the bank test below does not
        ; depend on what RAM held at power-on (MAME fills RAM with $FF, CLOADM with 0)
        LDA     #$00
        STA     $FFE2           ; bit 0 clear: the standard bank again
        LDX     #$0000
FV2     STA     ,X+
        CMPX    #$1000
        BNE     FV2
        RTS

; ---- the 32K banks: 0 standard, 2 bank A, 6 bank B ----
BANKS
        LDA     #$10
        STA     $0100           ; the standard bank
        LDA     #$02
        STA     $FFE2           ; bank A
        LDA     #$20
        STA     $0100
        LDA     #$06
        STA     $FFE2           ; bank B
        LDA     #$30
        STA     $0100
        LDA     #$00
        STA     $FFE2           ; back to the standard bank (and bit 0 clear: the video window goes too)
        LDA     $0100           ; must read $10 again
        LDA     #$02
        STA     $FFE2           ; bank A again
        LDA     $0100           ; must read $20
        LDA     #$06
        STA     $FFE2           ; bank B again
        LDA     $0100           ; must read $30
        LDA     #$00
        STA     $FFE2
        RTS

; ---- cursor and start address, mid-frame ----
CURSOR
        LDA     #$0A
        STA     $FFE0
        LDA     #$00            ; R10: cursor from raster 0, always on
        STA     $FFE1
        LDA     #$0B
        STA     $FFE0
        LDA     #$0B            ; R11: ... to raster 11
        STA     $FFE1
        LDA     #$0E
        STA     $FFE0
        LDA     #$00            ; R14/R15: cursor at MA $0005
        STA     $FFE1
        LDA     #$0F
        STA     $FFE0
        LDA     #$05
        STA     $FFE1
        ; wait for a field, then move the start address (it takes effect at the next row). As in the SAM
        ; diag firmware (diag.asm PHASE3/WFS1): make port B an output first, so reading it to clear the
        ; flag returns the output register and not the row inputs (whose value with no key pressed is not
        ; what this comparison is about - MAME leaves unconnected PIA inputs at 0, we pull them high).
        CLR     $FF03           ; CRB bit 2 clear: DDR access
        LDA     #$FF
        STA     $FF02           ; DDRB = $FF (all outputs), ORB = 0
        LDA     #$34            ; CB1 falling-edge interrupt, no handshake
        STA     $FF03
        LDA     $FF02           ; clear the flag
        LDA     #$36            ; CB1 rising edge
        STA     $FF03
        LDA     $FF02           ; clear it again
CW1     LDA     $FF03
        BPL     CW1
        LDA     $FF02
        LDA     #$0C
        STA     $FFE0
        LDA     #$00            ; CRTC R12 = 0
        STA     $FFE1
        LDA     #$0D
        STA     $FFE0
        LDA     #$50            ; CRTC R13 = $50: display from MA $0050
        STA     $FFE1
        RTS

; ---- the display-enable port: sample it across a frame ----
DE      LDX     #$2010
        LDY     #24
DE1     LDA     $FFE2
        STA     ,X+
        LEAY    -1,Y
        BNE     DE1
        RTS

; ---- CRTC R0-R15 values: MAME's plus_screen geometry and a visible picture ----
; R0 113 (114 characters = 912 pixels), R1 80, R2 96, R3 $0F, R4 25 (26 rows), R5 4 (adjust: 316 lines),
; R6 22 (264 lines), R7 24 (VS at row 24), R8 0, R9 11 (12 raster lines), R10 0, R11 11,
; R12/R13 the display start $0000, R14/R15 the cursor $0005.
CRTCTAB FCB     $71,$50,$60,$0F,$19,$04,$16,$18,$00,$0B,$00,$0B,$00,$00,$00,$05

HALT    LDA     #$01
        STA     <$00
HALT2   BRA     HALT2

        ORG     $BF00
        FCB     $11
        ORG     $BFF2
        FDB     HALT,HALT,HALT,HALT,HALT,HALT,RESET
        END     RESET
