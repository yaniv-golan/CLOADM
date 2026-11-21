; The Dragon 64 Plus's paging, for the lockstep comparison with MAME (run.js d64plus --paging [--video]).
; Our own firmware, installed in the two BASIC ROM sockets. It runs on our machine WITHOUT config.mameCompat,
; so it proves two points from the Harvey-Smith traced Dragon 64 Plus schematic (owner-supplied research; known
; drawing errors) where MAME 0.264's outcome is the same as the schematic's:
;   (a) $FFE2 = $04 (R2 R1 = 10) is the motherboard RAM, like $00, after bank A or bank B was selected
;       ($05: the same, with the video RAM over $0000-$07FF only);
;   (b) the MC6847 always fetches from the motherboard RAM, whatever $FFE2 selects.
; MAME 0.264 never applies $FFE2 to memory (docs/verification.md, "Deviations from MAME"), so its CPU and VDG
; always reach the motherboard RAM. This firmware therefore never lets the CPU touch $0000-$7FFF while bank A,
; bank B or the video RAM covers the address it would touch: no stack, no subroutine, no RAM operand then. A
; machine that kept bank A for $04, or let the VDG see a bank, reads or shows the bank (zeros on ours, never
; written) instead of the motherboard bytes, and the comparison fails.
;
; Part 1 (a): CPU reads after $02 -> $04, $06 -> $04, $07 -> $05 and $03 -> $04; the values are in the trace's
; registers and are saved at RESULTS once the standard RAM is back.
; Part 2 (b): text mode from $0000 (the SAM's F = 0) holding a pattern in the motherboard RAM; for each $FFE2
; value in PHASES the picture is held for 30 fields with the phase number at PHASE, and each phase changes CSS so
; that headless MAME redraws its bitmap (d64plus/run-paging.js compares the pictures).
PHASE   EQU     $3F00           ; standard RAM, written only while $FFE2 = $00
RESULTS EQU     $3F10
        ORG     $8000
RESET   ORCC    #$50
        STA     $FFDD           ; SAM M1=1: 64K dynamic RAM, as BASIC sets at boot
        LDS     #$7F00
        CLRA
        TFR     A,DP
        CLR     $FFE2           ; the motherboard RAM, no overlay
        ; PIA0 B outputs (keyboard columns), PIA1 B outputs for the VDG, CB1 flags the field sync
        CLR     $FF03
        LDA     #$FF
        STA     $FF02
        LDA     #$34
        STA     $FF03
        CLR     $FF23
        LDA     #$F8
        STA     $FF22
        LDA     #$34
        STA     $FF23
        CLR     $FF22           ; text mode, CSS 0
        ; the motherboard RAM: $0000-$01FF byte = low(addr) + 3*high(addr) (every character code), then zero to $2000
        LDX     #$0000
GX      TFR     X,D
        PSHS    B
        LDB     #3
        MUL
        ADDB    ,S+
        STB     ,X+
        CMPX    #$0200
        BLO     GX
GZ      CLR     ,X+
        CMPX    #$2000
        BLO     GZ
        LDA     #$5A
        STA     $1000
        CLR     PHASE

; ---- part 1: the CPU after each paging ----
        LDA     #$02
        STA     $FFE2           ; bank A (nothing in $0000-$7FFF touched)
        LDA     #$04
        STA     $FFE2           ; R2 R1 = 10: the motherboard RAM
        LDA     $0100           ; $03, the motherboard's (bank A would give 0)
        LDB     $1000           ; $5A
        TFR     D,U
        LDA     #$77
        STA     $1001           ; a write under $04 lands in the motherboard RAM
        LDA     #$06
        STA     $FFE2           ; bank B
        LDA     #$04
        STA     $FFE2
        LDA     $1001           ; $77
        LDB     $0101           ; $04
        TFR     D,Y
        LDA     #$07
        STA     $FFE2           ; bank B and the video RAM
        LDA     #$05
        STA     $FFE2           ; the motherboard RAM, the video RAM over $0000-$07FF only
        LDA     $1000           ; $5A: above the overlay, the motherboard's
        LDB     $1001           ; $77
        TFR     D,X
        LDA     #$03
        STA     $FFE2           ; bank A and the video RAM
        LDA     #$04
        STA     $FFE2           ; the overlay goes with bit 0: $0100 is the motherboard's again
        LDA     $0100           ; $03
        LDB     $01FF           ; $02
        CLR     $FFE2
        STD     RESULTS+6
        STU     RESULTS
        STY     RESULTS+2
        STX     RESULTS+4

; ---- part 2: the VDG under each paging ----
        LDY     #PHASES
NEXT    CLR     $FFE2           ; the motherboard RAM while the phase number is written
        INC     PHASE
        LDA     ,Y+             ; $FFE2 for this phase ($FF: done)
        CMPA    #$FF
        BEQ     DONE
        LDB     ,Y+             ; PIA1 PB: text, CSS 0 or 1
        STA     $FFE2
        STB     $FF22           ; a mode change, so headless MAME redraws
        LDB     #30             ; hold for 30 fields
WAIT    LDA     $FF02
W1      LDA     $FF03
        BPL     W1
        DECB
        BNE     WAIT
        BRA     NEXT
DONE    CLR     $FF22           ; one more change (back to CSS 0), for MAME's picture of the last phase
        LDB     #30
DW      LDA     $FF02
DW1     LDA     $FF03
        BPL     DW1
        DECB
        BNE     DW
HALT    LDA     #$01
        STA     <$00
HALT2   BRA     HALT2

; $FFE2, PIA1 PB: each phase changes CSS
PHASES  FCB     $00,$00
        FCB     $02,$08
        FCB     $06,$00
        FCB     $01,$08
        FCB     $03,$00
        FCB     $07,$08
        FCB     $04,$00
        FCB     $05,$08
        FCB     $FF

        ORG     $BF00
        FCB     $11
        ORG     $BFF2
        FDB     HALT,HALT,HALT,HALT,HALT,HALT,RESET
        END     RESET
