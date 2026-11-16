; board.asm: our own 8K boot ROM for the Dragon Alpha's own hardware (run.js dgnalpha --board), in place of
; alpha_bt_10.rom. The BASIC socket holds a 16K image with markers ($B1 at $8000, $B2 at $A000, $B3 at $BFFF).
; Every result goes through a CPU register (the lockstep trace compares it) and into a log from $6000.
;   1. ROM paging (run from RAM, since $A000-$BFFF changes under it): PIA2 PA2 with and without PIA2 DDRB bit 2,
;      PIA2 DDRA changes, PIA1 PB2 as an output and as an input, PIA1 DDRB changes
;   2. the $FF20-$FF2F mirror at $FF30-$FF3F; the modem ($FF28-$FF2B reads $FF)
;   3. PIA2 port B input: 00 until the AY drives it, then the AY's value
;   4. AY-3-8912: all 16 registers written and read back, register 14 (port A input), a deselected chip
;      (address with a non-zero upper nibble), register 7's port A direction (the disk latch: the WD2797's
;      ready line and status follow the drive selected)
;   5. PIA2 control registers and CA2 set/reset (read back)
LOG     EQU     $6000
RAMCODE EQU     $7000
        ORG     $A000
START   ORCC    #$50
        LDS     #$7F00
        LDX     #$0000
        LDD     #$0000
CLR1    STD     ,X++
        CMPX    #$7F00
        BNE     CLR1
        LDU     #LOG
; ---- 1. ROM paging, from RAM
        LDX     #PAGING
        LDY     #RAMCODE
CP1     LDA     ,X+
        STA     ,Y+
        CMPX    #PAGEND
        BNE     CP1
        JSR     RAMCODE
; ---- 2. mirrors and the modem
        LDA     #$34
        STA     $FF35           ; PIA2 CRA through the mirror
        LDA     $FF25
        STA     ,U+
        LDA     $FF35
        STA     ,U+
        LDA     #$5A
        STA     $FF2E           ; WD2797 track register ($FF2E), read through the mirror
        LDB     #20
D1      DECB
        BNE     D1
        LDA     $FF3E
        STA     ,U+
        LDA     $FF28
        STA     ,U+
        LDA     $FF29
        STA     ,U+
        LDA     $FF2A
        STA     ,U+
        LDA     $FF2B
        STA     ,U+
        LDA     $FF3B
        STA     ,U+
        CLR     $FF28           ; writes go nowhere
        LDA     $FF28
        STA     ,U+
; ---- 3. PIA2 port B as inputs: nothing has driven it yet
        CLR     $FF27
        CLR     $FF26           ; DDRB = 0
        LDA     #$04
        STA     $FF27
        LDA     $FF26
        STA     ,U+
; PIA2 port A: bits 0-2 out, CA2 output high (set/reset mode); idle $04 keeps PA2 high
        CLR     $FF25
        LDA     #$07
        STA     $FF24
        LDA     #$3C
        STA     $FF25
        LDA     #$04
        STA     $FF24
        LDA     $FF25
        STA     ,U+
; ---- 4. AY: every register written with its own value, then read back
        CLRB
AW      LDX     #AYVALS
        LDA     B,X
        JSR     AYWR
        INCB
        CMPB    #16
        BNE     AW
        CLRB
AR      JSR     AYRD
        STA     ,U+
        INCB
        CMPB    #16
        BNE     AR
; a deselected chip: address $1F (upper nibble 1) reads $FF and ignores data
        LDB     #$1F
        JSR     AYADDR
        JSR     AYGET
        STA     ,U+
        LDA     #$99
        JSR     AYPUT
        LDB     #$08
        JSR     AYRD
        STA     ,U+
; register 7: port A an input ($FF on the latch: no drive fitted at bit 3 selects none), then an output with
; register 14 = $01 (drive 0) and $02 (drive 1), single density: the WD2797's status shows NOT READY / the drive
        LDA     #$3F
        LDB     #7
        JSR     AYWR
        LDA     $FF2F
        STA     ,U+
        LDA     #$21
        LDB     #14
        JSR     AYWR
        LDA     #$7F
        LDB     #7
        JSR     AYWR
        LDA     $FF2F
        STA     ,U+
        LDA     #$02
        LDB     #14
        JSR     AYWR
        LDA     $FF2F
        STA     ,U+
        LDB     #14
        JSR     AYRD
        STA     ,U+
; ---- 5. PIA2 control registers: CRA with CA2 low, then strobe mode; CRB
        LDA     #$34
        STA     $FF25
        LDA     $FF25
        STA     ,U+
        LDA     #$2C
        STA     $FF25
        LDA     $FF25
        STA     ,U+
        LDA     #$3C
        STA     $FF25
        LDA     #$07
        STA     $FF27
        LDA     $FF27
        STA     ,U+
        LDA     #$04
        STA     $FF27
        STU     $5FFE
HALT    BRA     HALT

; AY access through PIA2: port B is the AY's bus (outputs to write, inputs to read); port A $07 latches the
; address, $05 writes data, $06 reads data into port B, $04 idle (PA2 high: the boot ROM stays in)
; AYWR: register B = A.  AYRD: A = register B.
AYWR    PSHS    A
        JSR     AYADDR
        PULS    A
        BRA     AYPUT
AYRD    JSR     AYADDR
        BRA     AYGET
AYADDR  PSHS    A
        BSR     PBOUT
        STB     $FF26
        LDA     #$07
        STA     $FF24
        LDA     #$04
        STA     $FF24
        PULS    A,PC
AYPUT   PSHS    B
        BSR     PBOUT
        STA     $FF26
        LDB     #$05
        STB     $FF24
        LDB     #$04
        STB     $FF24
        PULS    B,PC
AYGET   PSHS    B
        CLR     $FF27
        CLR     $FF26           ; port B inputs
        LDB     #$04
        STB     $FF27
        LDB     #$06
        STB     $FF24           ; read: the AY drives port B
        LDB     #$04
        STB     $FF24
        LDA     $FF26
        PULS    B,PC
PBOUT   PSHS    A
        CLR     $FF27
        LDA     #$FF
        STA     $FF26           ; port B outputs
        LDA     #$04
        STA     $FF27
        PULS    A,PC
AYVALS  FCB     $11,$F2,$23,$E4,$35,$D6,$1F,$B8,$09,$1A,$0B,$6C,$7D,$0E,$5F,$A0

; ---- the paging tests, copied to RAMCODE (position independent: relative branches, absolute I/O)
PAGING  LBSR    MARKS           ; reset: the boot ROM bank
        CLR     $FF25           ; PIA2 CRA: DDRA selected
        LDA     #$04
        STA     $FF24           ; DDRA = $04: port A out $FB, PA2 low, but PIA2 DDRB bit 2 is 0: no change
        LBSR    MARKS
        CLR     $FF27
        LDA     #$04
        STA     $FF26           ; PIA2 DDRB = $04 (no port A write: no change)
        LBSR    MARKS
        LDA     #$04
        STA     $FF25           ; CRA: data register
        CLR     $FF24           ; PA = 00: PA2 low -> the BASIC bank
        LBSR    MARKS
        LDA     #$04
        STA     $FF24           ; PA2 high -> boot
        LBSR    MARKS
        CLR     $FF25
        CLR     $FF24           ; DDRA = 0: port A all inputs, pulled up: $FF, PA2 high -> boot (and the AY sees 11)
        LBSR    MARKS
        LDA     #$04
        STA     $FF24           ; DDRA = $04 again: out_a is $04 (the last PA write), PA2 high: boot
        LBSR    MARKS
        LDA     #$FF
        STA     $FF26           ; PIA2 DDRB = $FF (still DDR: CRB = 0)
        CLR     $FF24           ; DDRA = 0: PA2 high -> boot
        LBSR    MARKS
; PIA1 PB2: as an output it switches too
        LDA     $FF23
        PSHS    A
        CLR     $FF23           ; PIA1 CRB: DDRB selected
        LDA     #$04
        STA     $FF22           ; DDRB = $04: out_b bit 2 = 0 -> BASIC
        LBSR    MARKS
        LDA     #$04
        STA     $FF23
        STA     $FF22           ; PB2 high -> boot
        LBSR    MARKS
        CLR     $FF22           ; PB2 low -> BASIC
        LBSR    MARKS
        CLR     $FF23
        CLR     $FF22           ; DDRB = 0: PB2 an input: no call -> stays BASIC
        LBSR    MARKS
        PULS    A
        STA     $FF23
        LDA     #$04
        STA     $FF25
        STA     $FF24           ; PIA2 PA = $04 with DDRB bit 2 set: boot
        LBSR    MARKS
        CLR     $FF27
        CLR     $FF26           ; PIA2 DDRB = 0
        LDA     #$04
        STA     $FF27
        CLR     $FF24           ; PA2 low without DDRB bit 2: stays boot
        LBSR    MARKS
        LDA     #$04
        STA     $FF24
        RTS
MARKS   LDA     $8000
        STA     ,U+
        LDA     $A000
        STA     ,U+
        LDA     $BFFF
        STA     ,U+
        RTS
PAGEND  EQU     *

        ORG     $BFF2
        FDB     START,START,START,START,START,START,START
