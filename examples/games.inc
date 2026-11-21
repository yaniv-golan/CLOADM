; ---------------------------------------------------------------
; games.inc - what the two bitmap games share (examples/2048.asm, examples/minesweeper.asm).
; 6809 assembly for CLOADM's assembler. Dragon 32/64/200, Tano, CoCo 1/2/3 and clones,
; with no ROMs (the built-in firmware) or with BASIC.
;
; Screen: the VDG's 128x192 four-colour mode (CG6, PMODE 3 in BASIC), 32 bytes a row, four
; pixels a byte (two bits each, the left pixel in bits 7-6), at $0400-$1BFF. Colours 0-3 are
; green, yellow, blue, red (CSS 0) or buff, cyan, magenta, orange (CSS 1).
; Text: our own 3x5 font in a 4-pixel cell (one byte a row), drawn 1x or 2x wide and any number
; of rows tall.
; Keys: the ROM's POLCAT vector at $A000 (the built-in firmware provides it), so the Dragon and
; CoCo keyboard matrices, which differ, are the firmware's business: arrows, SPACE, ENTER and
; BREAK give the same codes on every machine.
; Sound: square waves and noise on the 6-bit DAC (PIA1 port A bits 7-2), the analogue mux set to
; the DAC as in examples/welcome.asm.
; Interrupts stay masked: nothing here needs one, and the frame timing comes from the field sync
; flag (PIA0 CB1), polled.
;
; Each game starts with this fixed header (the Session and the tests know the offsets):
;   ORG $3000: JMP START ($3000), SEED FDB ($3003, nonzero: the game's random numbers start from it
;   instead of from the key-press timing), DONE BRA DONE ($3005, where the game stops after BREAK,
;   back in text mode; js/session.js GAMES.done), SAMEXIT FCB ($3007, the SAM memory size M, 0-3,
;   to put back on leaving: 2, BASIC's value on a 32K or 64K machine, unless the Session sets the
;   one the machine had; the SAM's registers cannot be read).
; Leaving (BREAK, on the title page too): the text screen at $0400, cleared, SAM V=0 and M as it was,
; then DONE with interrupts still masked. On the built-in firmware the Session then brings the welcome
; menu back; with BASIC it clears BASIC's warm-start flag ($0071) and presses reset: a cold start, since the
; game has drawn over BASIC's program area and a disk DOS's workspace (a BASIC program is not kept).
; Memory: the screen $0400-$1BFF, the stack below $3000, the program from $3000 (under $4000). The
; games need 32K: the SAM is set for 64K RAM chips (M=10), as BASIC sets it on the 32K and 64K
; machines; on a 4K or 16K machine (4K or 16K chips) that would scramble the addresses, so the
; Session refuses them there (Session.gameNeeds).
; ---------------------------------------------------------------

POLCAT  EQU     $A000           ; ROM vector: read key -> A, Z=1 if none
GSCREEN EQU     $0400           ; the bitmap, 6144 bytes
GEND    EQU     GSCREEN+6144
PIA0DA  EQU     $FF00
PIA0CRA EQU     $FF01
PIA0DB  EQU     $FF02
PIA0CRB EQU     $FF03
PIA1DA  EQU     $FF20           ; DAC in bits 7-2
PIA1CRA EQU     $FF21
PIA1DB  EQU     $FF22           ; VDG mode in bits 7-3
PIA1CRB EQU     $FF23
K_UP    EQU     $5E             ; POLCAT codes
K_DOWN  EQU     $0A
K_LEFT  EQU     $08
K_RIGHT EQU     $09
K_BREAK EQU     $03
K_ENTER EQU     $0D

; ---- set-up: sound path, then the four-colour mode with colour set A (0 or $08 for CSS) ----
GINIT   PSHS    A
        LDA     #$34            ; PIA0 CA2 = CB2 = 0: the sound mux selects the DAC; FS flag on CB1, no IRQ
        STA     PIA0CRA
        STA     PIA0CRB
        LDA     #$30            ; PIA1 port A: the DDR
        STA     PIA1CRA
        LDA     #$FE            ; bits 7-1 outputs (DAC), cassette input on bit 0
        STA     PIA1DA
        LDA     #$34            ; data register, motor off
        STA     PIA1CRA
        LDA     #$38            ; PIA1 port B: the DDR, CB2 high (sound on)
        STA     PIA1CRB
        LDA     PIA1DB
        ORA     #$F8            ; VDG mode bits 7-3 outputs; bits 2-0 as they were (Dragon 64 ROM select,
        STA     PIA1DB          ; CoCo RAM size, printer: not ours to change)
        LDA     #$3C            ; back to the data register, CB2 high
        STA     PIA1CRB
        LDA     #$80            ; DAC at mid level
        STA     PIA1DA
        PULS    A
; colour set A: $00 or $08 (CSS)
GMODE   PSHS    A
        LDA     PIA1DB
        ANDA    #$07
        ORA     #$E0            ; A/G=1 GM=110: CG6 128x192x4
        ORA     ,S+
        STA     PIA1DB
        STA     $FFC0           ; SAM V=110 (V0 clear, V1 set, V2 set)
        STA     $FFC3
        STA     $FFC5
        BSR     SAMBASE
        STA     $FFDA           ; SAM M=10: 64K dynamic RAM, as BASIC sets it on a 32K or 64K machine.
        STA     $FFDD           ; (Set again in case M was left at 4K, which wraps the display every 4K.)
        RTS
SAMBASE STA     $FFC6           ; SAM F=2: the display at $0400 (F1 set, the others clear)
        STA     $FFC9
        STA     $FFCA
        STA     $FFCC
        STA     $FFCE
        STA     $FFD0
        STA     $FFD2
        RTS

; ---- back to the 32x16 text screen at $0400, cleared (before DONE) ----
GTEXT   LDX     #GSCREEN
        LDD     #$6060
GTXCLR  STD     ,X++
        CMPX    #GSCREEN+512
        BNE     GTXCLR
        LDA     PIA1DB
        ANDA    #$07            ; A/G=0, internal alphanumerics
        STA     PIA1DB
        STA     $FFC0           ; SAM V=0
        STA     $FFC2
        STA     $FFC4
        BSR     SAMBASE
        LDA     SAMEXIT         ; SAM M as it was: M0 ($FFDA clear, $FFDB set), M1 ($FFDC, $FFDD)
        LSRA
        BCS     GTM0SET
        STA     $FFDA
        BRA     GTM1
GTM0SET STA     $FFDB
GTM1    LSRA
        BCS     GTM1SET
        STA     $FFDC
        RTS
GTM1SET STA     $FFDD
        RTS

; ---- wait for the next field sync ----
VSYNC   LDA     PIA0DB          ; clear the FS flag
VSWAIT  LDA     PIA0CRB
        BPL     VSWAIT
        RTS

; ---- keys ----
; GETKEY: wait for a key -> A. Every poll counts in ENTROPY, which seeds the game from how long the
; player took (SEED, if set, wins).
GETKEY  PSHS    B,X,Y,U
GKLOOP  LDD     ENTROPY
        ADDD    #1
        STD     ENTROPY
        JSR     [POLCAT]
        BEQ     GKLOOP
        PULS    B,X,Y,U,PC
; INKEY: a key or 0 now -> A (Z set when none)
INKEY   PSHS    B,X,Y,U
        JSR     [POLCAT]
        PULS    B,X,Y,U,PC

; ---- random numbers: a 16-bit Galois LFSR (taps $B400, period 65535) ----
; RANDOMIZE: start it from SEED, or from ENTROPY when SEED is 0 (never 0: the LFSR would stick)
RANDOMIZE
        LDD     SEED
        BNE     RZSET
        LDD     ENTROPY
        BNE     RZSET
        LDD     #$ACE1
RZSET   STD     RSEED
        RTS
; RANDOM -> A, a byte from eight steps of the register
RANDOM  PSHS    B
        LDB     #8
RNSTEP  PSHS    B
        LDD     RSEED
        LSRA
        RORB
        BCC     RNOX
        EORA    #$B4
RNOX    STD     RSEED
        PULS    B
        DECB
        BNE     RNSTEP
        LDA     RSEED+1
        PULS    B,PC
; RANDN: A = a random number 0..B-1 (B 1-255), by rejection so every value is equally likely
RANDN   PSHS    B
        LDA     #1              ; the smallest all-ones mask covering B-1
RNMASK  CMPA    ,S
        BHS     RNTRY
        LSLA
        INCA
        BRA     RNMASK
RNTRY   PSHS    A               ; 0,S mask, 1,S limit
RNAGAIN BSR     RANDOM
        ANDA    ,S
        CMPA    1,S
        BHS     RNAGAIN
        LEAS    2,S
        RTS

; ---- drawing ----
; CLS: the whole screen in the fill byte A
CLS     LDX     #GSCREEN
        TFR     A,B
CLSLP   STD     ,X++
        CMPX    #GEND
        BNE     CLSLP
        RTS
; AT: X = the screen byte at column B (0-31), pixel row A (0-191)
AT      PSHS    B
        LDB     #32
        MUL
        ADDD    #GSCREEN
        ADDB    ,S+
        ADCA    #0
        TFR     D,X
        RTS
; BOX: fill a rectangle at X, BOXW bytes by BOXH rows, even rows FILLA, odd rows FILLB
BOX     PSHS    D,X,Y
        LDB     BOXH
        STB     BOXN
BOXROW  LDA     FILLA
        LDB     BOXN
        BITB    #1
        BEQ     BOXEVN
        LDA     FILLB
BOXEVN  LDB     BOXW
        TFR     X,Y
BOXCEL  STA     ,Y+
        DECB
        BNE     BOXCEL
        LEAX    32,X
        DEC     BOXN
        BNE     BOXROW
        PULS    D,X,Y,PC
; Text: TFG and TBG are the fill bytes of the text and background colours (colour * $55), TROWS
; the rows each font row is repeated (1: 5 rows tall). TWIDE 1 is the fixed 8-pixel doubled cell the
; titles use, positioned and advanced in BYTES. TWIDE 0 is PROPORTIONAL, positioned and advanced in
; PIXELS: a glyph is its own width plus ONE BLANK COLUMN after it, so no two letters ever touch (four
; pixels of ink in a four-pixel cell left no gap and smeared ARROWS). Widths: A H R are 4 (FONT4),
; M W are 5 (FONT5), everything else is 3 (FONT).
; PUTCH: the character in A. TWIDE 1: at the screen byte in X, which advances 2. TWIDE 0: at the pixel
; PCOL (0-3) of the screen byte X; X and PCOL move past the glyph and its blank column.
PUTCH   PSHS    D,Y,U
        TST     TWIDE
        LBEQ    PCPROP
; the 2x titles: a byte cursor and a fixed 8-pixel cell, unchanged (M and W have glyphs of their own)
        STX     PCADDR
        LDU     #WIDEM
        CMPA    #'M
        BEQ     PCMW
        LDU     #WIDEW
        CMPA    #'W
        BEQ     PCMW
        SUBA    #$20
        CMPA    #$40
        BLO     PCOK
        LDA     #'?-$20
PCOK    LDB     #5
        MUL
        ADDD    #FONT
        TFR     D,U             ; U: the glyph's five rows
        TFR     X,Y             ; Y: the screen byte being drawn
        LDB     #5
        STB     PCROWS
PCROW   LDB     ,U+             ; a font row, bits 2-0 (bit 2 the left pixel)
        LDA     TROWS
        STA     PCREP
PCREPT  LDX     #MASK2L
        LDA     B,X
        LBSR    PCMIX
        STA     ,Y
        LDX     #MASK2R
        LDA     B,X
        LBSR    PCMIX
        STA     1,Y
        LEAY    32,Y
        DEC     PCREP
        BNE     PCREPT
        DEC     PCROWS
        BNE     PCROW
        LDX     PCADDR
        LEAX    2,X
        PULS    D,Y,U,PC
; PCMW: the 7-pixel glyph at U (five rows of two mask bytes) at PCADDR, 2x wide
PCMW    TFR     X,Y
        LDB     #5
        STB     PCROWS
PCMWROW LDB     TROWS
PCMWREP LDA     ,U
        LBSR    PCMIX
        STA     ,Y
        LDA     1,U
        LBSR    PCMIX
        STA     1,Y
        LEAY    32,Y
        DECB
        BNE     PCMWREP
        LEAU    2,U
        DEC     PCROWS
        BNE     PCMWROW
        LDX     PCADDR
        LEAX    2,X
        PULS    D,Y,U,PC
; PCPROP: the 1x glyph of A at the pixel PCOL of the screen byte X, proportional
PCPROP  LBSR    PCFIND          ; U: its five rows, PCGW: its width in pixels
        STX     PSTART          ; where the glyph starts, for the cursor's advance
        STX     PCADDR
        LDB     #5
        STB     PCROWS
PCGGLY  LDB     ,U+             ; the font row: PCGW bits, its left pixel the top bit
        LDA     #8
        SUBA    PCGW            ; left-align it in a byte, so each pixel falls off the top
        BEQ     PCGALI
PCGLSH  LSLB
        DECA
        BNE     PCGLSH
PCGALI  STB     PCROWBYTE
        LDA     TROWS
        STA     PCREP
PCGROW  BSR     PCDOROW
        DEC     PCREP
        BNE     PCGROW
        DEC     PCROWS
        BNE     PCGGLY
        LDX     PSTART          ; the cursor: past the glyph and its blank column
        LDA     PCOL
        ADDA    PCGW
        INCA
PCADV   CMPA    #4
        BLO     PCADVD
        SUBA    #4
        LEAX    1,X
        BRA     PCADV
PCADVD  STA     PCOL
        STX     PCSBYTE         ; the pixel cursor: the byte here, the pixel in PCOL
        PULS    D,Y,U,PC
; PCDOROW: one screen row of the glyph at PCADDR: its PCGW pixels and the blank column after them,
; each pixel taking the text colour when its bit is set and the background colour when it is clear
PCDOROW LDA     PCROWBYTE
        STA     PCBITS
        LDX     PCADDR
        STX     PCCUR
        LDA     PCOL
        STA     PCOFF
        LDA     PCGW
        INCA                    ; the glyph and its blank column
        STA     PCNPIX
PCNXT   LDA     PCBITS
        BITA    #$80
        LBEQ    PBACK
        LDA     TFG
        BRA     PCSET
PBACK   LDA     TBG
PCSET   STA     PCOLOUR
        LDA     PCBITS
        LSLA
        STA     PCBITS
        LDB     PCOFF
        LDX     #PIXMASK
        LDB     B,X
        STB     PCMASK
        LDA     PCOLOUR
        ANDA    PCMASK
        STA     PCTMP
        LDB     PCMASK
        COMB
        LDX     PCCUR
        ANDB    ,X
        ORB     PCTMP
        STB     ,X
        INC     PCOFF
        LDA     PCOFF
        CMPA    #4
        BLO     PCWRAP
        CLR     PCOFF
        LDX     PCCUR
        LEAX    1,X
        STX     PCCUR
PCWRAP  DEC     PCNPIX
        BNE     PCNXT
        LDX     PCADDR
        LEAX    32,X
        STX     PCADDR
        RTS
; PCFIND: A = a character -> U: its five glyph rows, PCGW: its width (3, 4 or 5)
PCFIND  CMPA    #'M
        BEQ     PCFW5M
        CMPA    #'W
        BEQ     PCFW5W
        CMPA    #'A
        BEQ     PCFW5A
        CMPA    #'H
        BEQ     PCFW5H
        CMPA    #'R
        BEQ     PCFW5R
        SUBA    #$20            ; FONT: $20-$5F, three wide
        CMPA    #$40
        BLO     PCF3
        LDA     #'?-$20
PCF3    LDB     #5
        MUL
        ADDD    #FONT
        TFR     D,U
        LDA     #3
        BRA     PCFW
PCFW5A  LDU     #FONT5A
        BRA     PCFW5
PCFW5H  LDU     #FONT5H
        BRA     PCFW5
PCFW5R  LDU     #FONT5R
        BRA     PCFW5
PCFW5M  LDU     #FONT5M
        BRA     PCFW5
PCFW5W  LDU     #FONT5W
PCFW5   LDA     #5
PCFW    STA     PCGW
        RTS
; A = pixel mask -> (mask AND TFG) OR (NOT mask AND TBG)
PCMIX   PSHS    A
        ANDA    TFG
        STA     PCTMP
        LDA     ,S+
        COMA
        ANDA    TBG
        ORA     PCTMP
        RTS
; PUTSTR: the string at U (0 ends). TWIDE: from the screen byte X, advancing X. 1x: from the pixel
; cursor PCSBYTE/PCOL, which each glyph advances (X is not the cursor there: a glyph can start mid-byte).
PUTSTR  LDA     ,U+
        BEQ     PSDONE
        TST     TWIDE
        BNE     PSBYTE
        LDX     PCSBYTE
PSBYTE  LBSR    PUTCH
        BRA     PUTSTR
PSDONE  RTS
; PRINTAT: the string at U at column B, row A, in the current text style. In 1x B is a PIXEL column
; (0-127); when TWIDE it is a byte column (0-31).
PRINTAT TST     TWIDE
        BNE     PRBYTE
        BSR     ATPIX
        BRA     PUTSTR
PRBYTE  JSR     AT
        BRA     PUTSTR
; ATPIX: pixel column B (0-127), row A -> X = its screen byte, PCOL = the pixel within it
ATPIX   PSHS    B
        ANDB    #3
        STB     PCOL
        PULS    B
        LSRB
        LSRB
        LBSR    AT
        STX     PCSBYTE         ; the proportional cursor starts here
        RTS
; STRLEN: the length of the string at U -> B
STRLEN  PSHS    U
        CLRB
SLLP    TST     ,U+
        BEQ     SLEND
        INCB
        BRA     SLLP
SLEND   PULS    U,PC
; STRWID: the 1x width of the string at U in pixels (its glyphs and the blank columns) -> B.
; The string pointer lives in SWPTR: PCFIND returns the glyph's address in U, which would otherwise
; overwrite it and run the loop past the string's end (it did, forever).
STRWID  PSHS    U               ; the caller's string pointer: PCFIND returns a glyph in U
        STU     SWPTR
        CLRB
SWLP    LDX     SWPTR
        LDA     ,X+
        BEQ     SWEND
        STX     SWPTR           ; (after the test: STX sets the flags, which would hide the 0)
        PSHS    B
        LBSR    PCFIND          ; PCGW: its width; the advance is one blank column more
        LDB     PCGW
        INCB
        ADDB    ,S+
        BRA     SWLP
SWEND   DECB
        PULS    U,PC
; CENTRE: the string at U centred on the screen at row A (pixels in 1x, bytes when TWIDE)
CENTRE  PSHS    A
        TST     TWIDE
        BNE     CENBYTE
        BSR     STRWID
        NEGB
        ADDB    #128
        LSRB
        PULS    A
        BRA     PRINTAT
CENBYTE BSR     STRLEN
        LSLB
        NEGB
        ADDB    #32
        LSRB
        PULS    A
        BRA     PRINTAT

; ---- sound ----
; TONE: a square wave: A = the delay (a half period is about 5*A+22 cycles), B = the half periods
TONE    PSHS    D,X
        STA     SDELAY
        STB     SPULSES
        LDA     #$FC            ; DAC high
SNHALF  STA     PIA1DA
        LDB     SDELAY
SNDLY   DECB
        BNE     SNDLY
        EORA    #$F8            ; $FC <-> $04
        DEC     SPULSES
        BNE     SNHALF
        LDA     #$80
        STA     PIA1DA
        PULS    D,X,PC
; NOISE: B*256 random levels on the DAC, A = the delay between them (a rumble when large)
NOISE   PSHS    D,X
        STA     SDELAY
        STB     SPULSES
        LDX     RSEED           ; its own copy of the LFSR: the game's numbers are not disturbed
        BNE     NSOUT
        LDX     #$ACE1
NSOUT   CLR     NSCOUNT
NSLOOP  TFR     X,D
        LSRA
        RORB
        BCC     NSNOX
        EORA    #$B4
NSNOX   TFR     D,X
        ANDB    #$FC
        STB     PIA1DA
        LDB     SDELAY
NSDLY   DECB
        BNE     NSDLY
        DEC     NSCOUNT
        BNE     NSLOOP
        DEC     SPULSES
        BNE     NSOUT
        LDA     #$80
        STA     PIA1DA
        PULS    D,X,PC
; PLAY: notes at U (delay, half periods; a 0 delay ends)
PLAY    PSHS    D,U
PLLP    LDA     ,U+
        BEQ     PLEND
        LDB     ,U+
        BSR     TONE
        BRA     PLLP
PLEND   PULS    D,U,PC

; pixel masks for the font: bits 2-0 of a font row -> the pixels they set (two bits each)
MASK1   FCB     $00,$0C,$30,$3C,$C0,$CC,$F0,$FC
MASK2L  FCB     $00,$00,$0F,$0F,$F0,$F0,$FF,$FF
MASK2R  FCB     $00,$F0,$00,$F0,$00,$F0,$00,$F0

; M and W 2x wide: seven pixels, two mask bytes a row
WIDEM   FCB     $C0,$0C,$F0,$3C,$CC,$CC,$C3,$0C,$C0,$0C        ; #.....#  ##...##  #.#.#.#  #..#..#  #.....#
WIDEW   FCB     $C0,$0C,$C3,$0C,$CC,$CC,$F0,$3C,$C0,$0C        ; #.....#  #..#..#  #.#.#.#  ##...##  #.....#

; pixel masks for one pixel, by its position in a screen byte (0-3): the two bits it sets
PIXMASK FCB     $C0,$30,$0C,$03
; the five letters a 3-pixel cell cannot tell apart, 5x5: five bits a row, bit 4 the left pixel,
; ONE BLANK COLUMN after each (the proportional cell). A has its point, H a full middle bar, R a
; bowl and a leg, M its top notch, W the mirror. They differ by shape at the centre, not by one pixel.
FONT5A  FCB     %00100,%01010,%10001,%11111,%10001        ; ..#.. .#.#. #...# ##### #...#
FONT5H  FCB     %10001,%10001,%11111,%10001,%10001        ; #...# #...# ##### #...# #...#
FONT5R  FCB     %11110,%10001,%11110,%10100,%10001        ; ####. #...# ####. #.#.. #...#
FONT5M  FCB     %10001,%11011,%10101,%10001,%10001        ; #...# ##.## #.#.# #...# #...#
FONT5W  FCB     %10001,%10001,%10101,%11011,%10001        ; #...# #...# #.#.# ##.## #...#

; the font: 3x5, ASCII $20-$5F, five rows a character, bit 2 the left pixel
FONT    FCB     %000,%000,%000,%000,%000        ; space
        FCB     %010,%010,%010,%000,%010        ; !
        FCB     %101,%101,%000,%000,%000        ; "
        FCB     %101,%111,%101,%111,%101        ; #
        FCB     %011,%110,%010,%011,%110        ; $
        FCB     %101,%001,%010,%100,%101        ; %
        FCB     %010,%101,%010,%101,%011        ; &
        FCB     %010,%010,%000,%000,%000        ; '
        FCB     %001,%010,%010,%010,%001        ; (
        FCB     %100,%010,%010,%010,%100        ; )
        FCB     %000,%101,%010,%101,%000        ; *
        FCB     %000,%010,%111,%010,%000        ; +
        FCB     %000,%000,%000,%010,%100        ; ,
        FCB     %000,%000,%111,%000,%000        ; -
        FCB     %000,%000,%000,%000,%010        ; .
        FCB     %001,%001,%010,%100,%100        ; /
        FCB     %111,%101,%101,%101,%111        ; 0
        FCB     %010,%110,%010,%010,%111        ; 1
        FCB     %111,%001,%111,%100,%111        ; 2
        FCB     %111,%001,%011,%001,%111        ; 3
        FCB     %101,%101,%111,%001,%001        ; 4
        FCB     %111,%100,%111,%001,%111        ; 5
        FCB     %111,%100,%111,%101,%111        ; 6
        FCB     %111,%001,%010,%010,%010        ; 7
        FCB     %111,%101,%111,%101,%111        ; 8
        FCB     %111,%101,%111,%001,%111        ; 9
        FCB     %000,%010,%000,%010,%000        ; :
        FCB     %000,%010,%000,%010,%100        ; ;
        FCB     %001,%010,%100,%010,%001        ; <
        FCB     %000,%111,%000,%111,%000        ; =
        FCB     %100,%010,%001,%010,%100        ; >
        FCB     %111,%001,%011,%000,%010        ; ?
        FCB     %010,%101,%111,%100,%011        ; @
        FCB     %010,%101,%111,%101,%101        ; A
        FCB     %110,%101,%110,%101,%110        ; B
        FCB     %011,%100,%100,%100,%011        ; C
        FCB     %110,%101,%101,%101,%110        ; D
        FCB     %111,%100,%110,%100,%111        ; E
        FCB     %111,%100,%110,%100,%100        ; F
        FCB     %011,%100,%101,%101,%011        ; G
        FCB     %101,%101,%111,%101,%101        ; H
        FCB     %111,%010,%010,%010,%111        ; I
        FCB     %001,%001,%001,%101,%010        ; J
        FCB     %101,%101,%110,%101,%101        ; K
        FCB     %100,%100,%100,%100,%111        ; L
        FCB     %101,%111,%111,%101,%101        ; M
        FCB     %110,%101,%101,%101,%101        ; N
        FCB     %010,%101,%101,%101,%010        ; O
        FCB     %110,%101,%110,%100,%100        ; P
        FCB     %010,%101,%101,%110,%011        ; Q
        FCB     %110,%101,%110,%101,%101        ; R
        FCB     %011,%100,%010,%001,%110        ; S
        FCB     %111,%010,%010,%010,%010        ; T
        FCB     %101,%101,%101,%101,%111        ; U
        FCB     %101,%101,%101,%101,%010        ; V
        FCB     %101,%101,%111,%111,%101        ; W
        FCB     %101,%101,%010,%101,%101        ; X
        FCB     %101,%101,%010,%010,%010        ; Y
        FCB     %111,%001,%010,%100,%111        ; Z
        FCB     %011,%010,%010,%010,%011        ; [
        FCB     %100,%100,%010,%001,%001        ; backslash
        FCB     %110,%010,%010,%010,%110        ; ]
        FCB     %010,%101,%000,%000,%000        ; ^
        FCB     %000,%000,%000,%000,%111        ; _

; variables (set before use: the binary does not carry RMB space)
ENTROPY RMB     2
RSEED   RMB     2
PCADDR  RMB     2               ; 2x: the screen byte PUTCH is at
PCOL    RMB     1
PCSBYTE RMB     2               ; 1x: the screen byte the pixel cursor is in (PCOL: the pixel)
SWPTR   RMB     2               ; STRWID's string pointer               ; 1x: the pixel (0-3) within the screen byte the cursor is at
PSTART  RMB     2               ; 1x: where a glyph starts, for the cursor's advance
PCGW    RMB     1               ; 1x: the glyph's width in pixels (3, 4 or 5)
PCROWBYTE RMB   1               ; 1x: the font row being drawn, left-aligned
PCCUR   RMB     2               ; 1x: the screen byte one pixel of the row goes into
PCOFF   RMB     1               ; 1x: the pixel within PCCUR
PCNPIX  RMB     1               ; 1x: pixels left in the row (the glyph and its blank column)
PCBITS  RMB     1               ; 1x: the row's pixels, the top bit the next one
PCMASK  RMB     1               ; 1x: the two bits of the pixel being set
PCOLOUR RMB     1               ; 1x: the colour byte of that pixel
NSCOUNT RMB     1
BOXW    RMB     1
BOXH    RMB     1
BOXN    RMB     1
FILLA   RMB     1
FILLB   RMB     1
TFG     RMB     1
TBG     RMB     1
TROWS   RMB     1
TWIDE   RMB     1
PCROWS  RMB     1
PCREP   RMB     1
PCTMP   RMB     1
SDELAY  RMB     1
SPULSES RMB     1
