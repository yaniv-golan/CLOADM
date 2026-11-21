; ---------------------------------------------------------------
; CATCH - a starter game for CLOADM, written for this project.
; 6809 assembly for the Dragon 32/64/200 and Tandy Color Computer
; 1/2. Runs on CLOADM's built-in firmware (no ROMs) and with BASIC.
;
; Blocks fall down the screen; move the paddle with the LEFT and
; RIGHT arrow keys to catch them. A catch scores a point and beeps
; high, a miss beeps low, three misses end the game. SPACE starts.
;
; Everything is done on the hardware directly, so nothing here needs
; a ROM routine:
;   screen    the MC6847 VDG's 32x16 text mode at $0400 (SAM base),
;             with SG4 semigraphics blocks for the playfield
;   keys      the keyboard matrix through PIA0 (columns out on port
;             B $FF02, rows in on port A $FF00)
;   timing    the field sync (FS) flag on PIA0 CB1, polled once a
;             frame (50 Hz Dragon, 60 Hz CoCo); interrupts are off
;   sound     the 6-bit DAC on PIA1 port A ($FF20 bits 7-2), routed
;             to the speaker through the analogue mux (PIA0 CA2 =
;             CB2 = 0) with sound enabled (PIA1 CB2 = 1)
; Data sheets: MC6847 (VDG), MC6883 (SAM), MC6821 (PIA), MC6809.
;
; One binary for the Dragon and the CoCo: their keyboards wire the
; arrow keys and SPACE to the same columns (5, 6, 7) but to row 5 on
; the Dragon and row 3 on the CoCo, so each key test accepts either
; row (on the Dragon M, N, O are also LEFT, RIGHT, SPACE; on the
; CoCo -, . and /).
;
; Build:  node tools/build-examples.js   (examples/starter-game/catch.bin)
; Run:    node cli/cloadm.js --load examples/starter-game/catch.bin --hold SPACE:2 --frames 50 --screenshot catch.png
;         or drop catch.bin on the page.
; Test:   examples/starter-game/catch.cloadm, docs/game-development.md
; ---------------------------------------------------------------

SCREEN  EQU     $0400           ; 32x16 text screen (512 bytes)
PIA0DA  EQU     $FF00           ; keyboard rows in (bits 6-0)
PIA0CRA EQU     $FF01
PIA0DB  EQU     $FF02           ; keyboard columns out (bits 7-0)
PIA0CRB EQU     $FF03           ; bit 7: the FS flag (CB1)
PIA1DA  EQU     $FF20           ; DAC (bits 7-2), cassette in (bit 0)
PIA1CRA EQU     $FF21
PIA1DB  EQU     $FF22           ; VDG mode (bits 7-3), 1-bit sound (bit 1)
PIA1CRB EQU     $FF23           ; CB2: sound enable

BLACK   EQU     $80             ; SG4: bit 7 set, colour bits 6-4, quadrants 3-0
BLOCK   EQU     $BF             ; red (colour 3), all four quadrants lit
PADDLE  EQU     $9F             ; yellow (colour 1)
GREEN   EQU     $60             ; a text space: the green of BASIC's screen

ROWS    EQU     %00101000       ; row 5 (Dragon) and row 3 (CoCo)
KLEFT   EQU     1               ; KEYS bits
KRIGHT  EQU     2
KSPACE  EQU     4

DACHI   EQU     $FC             ; DAC value 63 in bits 7-2
DACMID  EQU     $80             ; DAC value 32: the resting level

        ORG     $3000
; ---- fixed addresses, so a test can read them (--expect-mem) ----
START   JMP     INIT            ; $3000
SCORE   FCB     0               ; $3003 blocks caught
MISSES  FCB     0               ; $3004 blocks missed (3 ends the game)
STATE   FCB     0               ; $3005 0 title, 1 playing, 2 game over
PX      FCB     0               ; $3006 paddle column (left cell, 0-29)
BX      FCB     0               ; $3007 block column (0-31)
BY      FCB     0               ; $3008 block row (1-15)
; ---- the rest of the game's variables ----
TIMER   FCB     0               ; frames until the block falls a row
SPEED   FCB     0               ; frames per row (6, down to 2)
CATCHN  FCB     0               ; catches since the last speed-up
MOVET   FCB     0               ; frames until the paddle may move again
RND     FCB     0               ; random number generator state (never 0)
KEYS    FCB     0               ; keys down this frame (KLEFT, KRIGHT, KSPACE)
TDLY    FDB     0               ; TONE's delay count as a 16-bit word

INIT    ORCC    #$50            ; IRQ and FIRQ off: the game polls FS instead
        LDS     #START          ; the stack grows down from just below the game
        JSR     INITHW

; ---- title screen: wait for SPACE ----
TITLE   CLR     STATE
        JSR     CLS
        JSR     STATUS
        LDX     #SCREEN+4*32+3
        LDY     #TTITLE
        JSR     PRINT
        LDX     #SCREEN+7*32+3
        LDY     #TKEYS
        JSR     PRINT
        LDX     #SCREEN+10*32+6
        LDY     #TSTART
        JSR     PRINT
        JSR     WAITSP

; ---- a new game ----
NEWGAME CLR     SCORE
        CLR     MISSES
        CLR     CATCHN
        CLR     MOVET
        LDA     #14
        STA     PX
        LDA     #6
        STA     SPEED
        STA     TIMER
        LDA     #$5A            ; the same seed every game: the same blocks
        STA     RND
        JSR     CLS
        JSR     STATUS
        JSR     DRAWP
        JSR     NEWBLK
        JSR     DRAWB
        LDA     #1              ; STATE changes once the screen is drawn, so a
        STA     STATE           ; test that waits for it sees the new screen

; ---- one frame of play ----
PLAY    JSR     WAITFS
        JSR     READKEYS
        TST     MOVET           ; the paddle moves one cell every 2 frames
        BEQ     PMOVE
        DEC     MOVET
        BRA     PFALL
PMOVE   LDB     PX
        LDA     KEYS
        BITA    #KLEFT
        BEQ     PM1
        TSTB
        BEQ     PM1
        DECB
PM1     BITA    #KRIGHT
        BEQ     PM2
        CMPB    #29
        BHS     PM2
        INCB
PM2     CMPB    PX
        BEQ     PFALL
        STB     PX
        LDA     #1
        STA     MOVET
        JSR     DRAWP

PFALL   DEC     TIMER           ; time for the block to fall a row?
        BNE     PLAY
        LDA     SPEED
        STA     TIMER
        JSR     ERASEB
        INC     BY
        LDA     BY
        CMPA    #15             ; the paddle's row
        BLO     PDRAW
        LDA     BX              ; caught if BX - PX is 0, 1 or 2 (unsigned:
        SUBA    PX              ; a block left of the paddle wraps above 2)
        CMPA    #2
        BHI     PMISS
        INC     SCORE
        JSR     SNDCATCH
        INC     CATCHN          ; every 5 catches the blocks fall faster
        LDA     CATCHN
        CMPA    #5
        BLO     PNEXT
        CLR     CATCHN
        LDA     SPEED
        CMPA    #2
        BLS     PNEXT
        DEC     SPEED
        BRA     PNEXT
PMISS   INC     MISSES
        JSR     SNDMISS
        LDA     MISSES
        CMPA    #3
        BHS     OVER
PNEXT   JSR     STATUS
        JSR     NEWBLK
PDRAW   JSR     DRAWB
        JMP     PLAY

; ---- game over: SPACE plays again ----
OVER    JSR     STATUS
        LDX     #SCREEN+6*32+11
        LDY     #TOVER
        JSR     PRINT
        LDX     #SCREEN+9*32+7
        LDY     #TAGAIN
        JSR     PRINT
        LDA     #2
        STA     STATE
        JSR     WAITSP
        JMP     NEWGAME

; ---------------------------------------------------------------
; INITHW: set up the PIAs, the VDG and the SAM for the game. The
; built-in firmware and BASIC leave them much like this already;
; setting them here makes the game independent of either.
; ---------------------------------------------------------------
INITHW  CLR     PIA0CRA         ; PIA0 port A: select the data direction
        CLR     PIA0DA          ; register; all inputs (the keyboard rows)
        LDA     #$34            ; back to the data register; CA2 low (sound
        STA     PIA0CRA         ; mux bit 0); CA1 (HS) interrupt off
        CLR     PIA0CRB         ; PIA0 port B: all outputs (the keyboard
        LDA     #$FF            ; columns)
        STA     PIA0DB
        LDA     #$34            ; CB2 low (sound mux bit 1): mux 0 = the
        STA     PIA0CRB         ; DAC; CB1 (FS) sets bit 7, no interrupt
        LDA     #$FF            ; all columns high: no key selected
        STA     PIA0DB
        CLR     PIA1CRA         ; PIA1 port A: bits 7-1 outputs (the DAC
        LDA     #$FE            ; and the printer strobe or serial out),
        STA     PIA1DA          ; bit 0 the cassette input
        LDA     #$34            ; data register; CA2 low: cassette motor off
        STA     PIA1CRA
        LDA     #DACMID         ; the DAC at its resting level
        STA     PIA1DA
        LDA     #$3C            ; PIA1 CB2 high: sound on
        STA     PIA1CRB
        LDA     PIA1DB          ; VDG mode bits (PB7-3) to 0: alphanumeric,
        ANDA    #%00000101      ; CSS 0; the 1-bit sound (PB1) off; PB2
        STA     PIA1DB          ; (the Dragon 64's ROM select) kept
        STA     $FFC0           ; SAM V0-V2 = 0: the VDG's text mode timing
        STA     $FFC2           ; (a write to the even address clears a
        STA     $FFC4           ; bit, to the odd one sets it)
        STA     $FFC6           ; SAM F0-F6 = 2: the screen at 2 x 512 = $0400
        STA     $FFC9
        STA     $FFCA
        STA     $FFCC
        STA     $FFCE
        STA     $FFD0
        STA     $FFD2
        RTS

; WAITFS: wait for the next field sync, the start of a new frame.
WAITFS  LDA     PIA0DB          ; reading port B clears the CB1 flag
WFS     LDA     PIA0CRB         ; bit 7 is set by the next FS edge
        BPL     WFS
        RTS

; READKEYS: KEYS := the arrow keys and SPACE that are down. A column
; is selected by driving its PB bit low; a key down in it pulls its
; row's PA bit low.
READKEYS CLRB
        LDA     #%11011111      ; column 5: LEFT
        BSR     KEYCOL
        BEQ     RK1
        ORB     #KLEFT
RK1     LDA     #%10111111      ; column 6: RIGHT
        BSR     KEYCOL
        BEQ     RK2
        ORB     #KRIGHT
RK2     LDA     #%01111111      ; column 7: SPACE
        BSR     KEYCOL
        BEQ     RK3
        ORB     #KSPACE
RK3     LDA     #$FF            ; deselect every column
        STA     PIA0DB
        STB     KEYS
        TFR     B,A
        RTS
; KEYCOL: A = the column pattern -> Z clear if a key in ROWS is down
KEYCOL  STA     PIA0DB
        LDA     PIA0DA
        ANDA    #ROWS
        CMPA    #ROWS           ; both rows high: no key
        RTS

; WAITSP: wait until SPACE is up, then until it is pressed.
WAITSP  JSR     WAITFS
        JSR     READKEYS
        BITA    #KSPACE
        BNE     WAITSP
WSP2    JSR     WAITFS
        JSR     READKEYS
        BITA    #KSPACE
        BEQ     WSP2
        RTS

; NEWBLK: a new block at the top, in a random column.
NEWBLK  LDA     #1
        STA     BY
        JSR     RANDOM
        ANDA    #31
        STA     BX
        RTS

; RANDOM: an 8-bit Galois LFSR (taps $B8: all 255 non-zero states).
RANDOM  LDA     RND
        LSRA
        BCC     RN1
        EORA    #$B8
RN1     STA     RND
        RTS

; CELL: A = row, B = column -> X = the cell's screen address.
CELL    PSHS    B
        LDB     #32
        MUL                     ; D = row x 32
        ADDB    ,S+             ; + column
        ADCA    #0
        ADDD    #SCREEN
        TFR     D,X
        RTS

DRAWB   LDA     BY              ; the block
        LDB     BX
        BSR     CELL
        LDA     #BLOCK
        STA     ,X
        RTS
ERASEB  LDA     BY
        LDB     BX
        BSR     CELL
        LDA     #BLACK
        STA     ,X
        RTS

; DRAWP: the bottom row, black with the paddle's three cells.
DRAWP   LDX     #SCREEN+15*32
        LDA     #BLACK
DP1     STA     ,X+
        CMPX    #SCREEN+16*32
        BNE     DP1
        LDX     #SCREEN+15*32
        LDB     PX
        ABX
        LDA     #PADDLE
        STA     ,X+
        STA     ,X+
        STA     ,X
        RTS

; CLS: the top row green (the status line), the rest black.
CLS     LDX     #SCREEN
        LDA     #GREEN
CL1     STA     ,X+
        CMPX    #SCREEN+32
        BNE     CL1
        LDA     #BLACK
CL2     STA     ,X+
        CMPX    #SCREEN+16*32
        BNE     CL2
        RTS

; STATUS: the top row: score and misses.
STATUS  LDX     #SCREEN
        LDY     #TSTAT
        BSR     PRINT
        LDX     #SCREEN+7
        LDA     SCORE
        BSR     DEC3
        LDA     MISSES
        ADDA    #$70            ; the digit as a VDG code ('0' is $70)
        STA     SCREEN+28
        RTS

; PRINT: the ASCII text at Y (0 ends it) to the screen at X. The
; VDG's character codes: $40-$5F are @, A-Z and [\]^_ as in ASCII;
; space, digits and punctuation ($20-$3F in ASCII) are $60-$7F. All
; show dark on green; codes $00-$3F would show them inverted.
PRINT   LDA     ,Y+
        BEQ     PRX
        CMPA    #$40
        BHS     PR1
        ADDA    #$40
PR1     STA     ,X+
        BRA     PRINT
PRX     RTS

; DEC3: A (0-255) as three decimal digits at X.
DEC3    LDB     #$6F            ; '0' - 1 as a VDG code
D100    INCB
        SUBA    #100
        BCC     D100
        ADDA    #100
        STB     ,X+
        LDB     #$6F
D10     INCB
        SUBA    #10
        BCC     D10
        ADDA    #10
        STB     ,X+
        ADDA    #$70
        STA     ,X
        RTS

; ---------------------------------------------------------------
; Sound. TONE plays a square wave on the DAC, switching between
; DACHI and 0, and holds the CPU while it plays. One half period is
; 18 + 8 x A cycles (MC6809 cycle counts: STA extended 5, LDX
; extended 6, then A times LEAX -1,X 5 and BNE 3, then EORA
; immediate 2, DECB 2, BNE 3), so the pitch is the CPU clock
; (888,625 Hz on the Dragon, 894,886 Hz on the CoCo) / 2 / that.
; ---------------------------------------------------------------
SNDCATCH LDA    #30             ; 258-cycle half periods: ~1722 Hz on a Dragon
        LDB     #60             ; 30 periods
        BSR     TONE
        LDA     #20             ; 178 cycles: ~2496 Hz
        LDB     #100            ; 50 periods
        BRA     TONE
SNDMISS LDA     #90             ; 738 cycles: ~602 Hz
        LDB     #40             ; 20 periods
; TONE: A = delay count (1-255), B = number of half periods (1-255)
TONE    STA     TDLY+1
        CLR     TDLY
        LDA     #DACHI
TLOOP   STA     PIA1DA          ; the DAC changes on this write
        LDX     TDLY
TWAIT   LEAX    -1,X
        BNE     TWAIT
        EORA    #DACHI          ; DACHI <-> 0
        DECB
        BNE     TLOOP
        LDA     #DACMID         ; back to the resting level
        STA     PIA1DA
        RTS

TSTAT   FCC     " SCORE 000           MISSES 0 "
        FCB     0
TTITLE  FCC     "CATCH THE FALLING BLOCKS"
        FCB     0
TKEYS   FCC     "LEFT/RIGHT ARROWS MOVE"
        FCB     0
TSTART  FCC     "PRESS SPACE TO START"
        FCB     0
TOVER   FCC     "GAME OVER"
        FCB     0
TAGAIN  FCC     "SPACE PLAYS AGAIN"
        FCB     0

        END     START
