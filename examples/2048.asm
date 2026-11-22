; ---------------------------------------------------------------
; 2048 - slide the tiles, join equal ones, reach 2048.
; 6809 assembly, written for CLOADM. Runs with no ROMs (the built-in firmware) or with BASIC, on
; the Dragon 32/64/200, Tano, CoCo 1/2/3 and clones. The 128x192 four-colour screen; the shared
; routines are in games.inc.
;
; Keys: the arrows or W A S D move, R starts again, BREAK leaves (back to the text screen, then
; DONE). A move slides every tile as far as it goes; two equal tiles that meet join into one of
; twice the value, once per move; a move that changes the board brings a new tile (a 2, or one
; time in ten a 4) on a random empty square. Joining scores the new tile's value. The game is over
; when no move changes the board; reaching 2048 says so, and play goes on.
; Build: node tools/build-examples.js  (examples/2048.bin)
; ---------------------------------------------------------------

        ORG     $3000
; ---- fixed entry points: js/session.js GAMES and the tests know these addresses ----
ENTRY   JMP     START           ; $3000
SEED    FDB     0               ; $3003 nonzero: the random numbers start here (tests)
DONE    BRA     DONE            ; $3005 stopped after BREAK
SAMEXIT FCB     2               ; $3007 the SAM's M to put back on leaving (games.inc)

; (a pixel of this mode is twice as wide as it is tall: a tile of 24 pixels by 34 rows is a little wider than
; tall, and an even number of bytes, so a number of one to four digits sits in its middle)
TILEW   EQU     6               ; a tile: 6 bytes (24 pixels) by 34 rows
TILEH   EQU     34
TILEX   EQU     2               ; the first column of tiles; a column every 7 bytes
TILEY   EQU     24              ; the first row of tiles; a row every 40 rows
BOARDX  EQU     1               ; the board's blue frame: bytes 1-29, rows 20-181
BOARDY  EQU     20
BOARDW  EQU     29
BOARDH  EQU     162
FOOTY   EQU     185             ; the footer: the keys, or a message

START   ORCC    #$50            ; no interrupts
        LDS     #$3000          ; the stack below the program
        LDD     #0
        STD     ENTROPY
        STD     BEST
        STA     BEST+2
        CLR     POP
        CLRA                    ; colour set 0: green, yellow, blue, red
        JSR     GINIT
        JSR     TITLE
        JSR     RANDOMIZE

; ---- a new game ----
NEWGAME LDX     #BOARD
        LDB     #16
NGCLR   CLR     ,X+
        DECB
        BNE     NGCLR
        CLR     SCORE
        CLR     SCORE+1
        CLR     SCORE+2
        CLR     LOST
        CLR     WONSEEN
        LDD     #0
        STD     MOVES
        JSR     FRAME
        JSR     SPAWN
        JSR     SPAWN
        JSR     SHOWALL

; ---- the game loop: a key, a move ----
GLOOP   JSR     GETKEY
        CMPA    #K_BREAK
        LBEQ    QUIT
        CMPA    #'R
        BEQ     NEWGAME
        TST     LOST
        BNE     GLOOP           ; game over: R or BREAK only
        LDX     #KEYDIR         ; key -> direction 0-3
GLKEY   LDB     ,X+
        BEQ     GLOOP           ; not a move key
        CMPA    -1,X
        BEQ     GLFOUND
        LEAX    1,X
        BRA     GLKEY
GLFOUND LDA     ,X
        STA     DIR
        JSR     DOMOVE
        TST     CHANGED
        BEQ     GLOOP           ; nothing moved: no new tile
        LDD     MOVES
        ADDD    #1
        STD     MOVES
        JSR     MOVESND
        JSR     SHOWALL
        JSR     SPAWN
        JSR     SCORES
        JSR     CHKWIN
        JSR     CANMOVE
        TSTA
        BNE     GLOOP
        LDA     #1              ; no move left
        STA     LOST
        LDU     #T_OVER
        JSR     MESSAGE
        LDU     #SND_OVER
        JSR     PLAY
        BRA     GLOOP

QUIT    JSR     GTEXT
        JMP     DONE

; ---- a move: DIR 0 up, 1 right, 2 down, 3 left ----
; Each direction is four lines of four squares, listed from the edge the tiles move to (LINES).
; A line is read into LINE, packed towards its start with equal neighbours joined (a joined tile
; does not join again in the same move), and written back.
DOMOVE  CLR     CHANGED
        CLR     MERGED
        LDB     DIR
        LDA     #16
        MUL
        ADDD    #LINES
        TFR     D,U             ; U: this direction's 16 square numbers
        LDA     #4
        STA     LINEN
MVLINE  LDX     #BOARD
        LDY     #LINE           ; read the line
        LDB     #4
MVREAD  PSHS    B
        LDB     ,U+
        LDA     B,X
        STA     ,Y+
        PULS    B
        DECB
        BNE     MVREAD
        LEAU    -4,U
        CLR     OUTN            ; pack it into OUT
        CLR     LASTV           ; the value the next tile may join (0: none)
        LDD     #0
        STD     OUT
        STD     OUT+2
        LDY     #LINE
        LDB     #4
MVPACK  LDA     ,Y+
        BEQ     MVPNEXT         ; an empty square
        CMPA    LASTV
        BNE     MVPUT
        INCA                    ; join: the previous tile doubles
        LDX     #OUT
        PSHS    B
        LDB     OUTN
        DECB
        STA     B,X
        PULS    B
        JSR     ADDSCORE
        CMPA    MERGED
        BLS     MVLOCK
        STA     MERGED          ; the biggest join this move (its sound)
MVLOCK  CLR     LASTV           ; a joined tile joins nothing more
        BRA     MVPNEXT
MVPUT   STA     LASTV
        LDX     #OUT
        PSHS    B
        LDB     OUTN
        STA     B,X
        INC     OUTN
        PULS    B
MVPNEXT DECB
        BNE     MVPACK
        LDX     #BOARD          ; write it back
        LDY     #OUT
        LDB     #4
MVWRITE PSHS    B
        LDB     ,U+
        LDA     ,Y+
        CMPA    B,X
        BEQ     MVSAME
        STA     B,X
        LDA     #1
        STA     CHANGED
MVSAME  PULS    B
        DECB
        BNE     MVWRITE
        DEC     LINEN
        LBNE    MVLINE
        RTS

; the score goes up by the joined tile's value, 2^A (A 1-17), in BCD
ADDSCORE
        PSHS    D,X
        LDB     #3
        MUL
        LDX     #VALUES-3
        ABX
        LDA     SCORE+2
        ADDA    2,X
        DAA
        STA     SCORE+2
        LDA     SCORE+1
        ADCA    1,X
        DAA
        STA     SCORE+1
        LDA     SCORE
        ADCA    ,X
        DAA
        STA     SCORE
        PULS    D,X,PC

; ---- a new tile on a random empty square: a 2 (value 1), one time in ten a 4 (value 2) ----
SPAWN   LDX     #BOARD          ; count the empty squares
        CLRB
        LDA     #16
SPCNT   TST     ,X+
        BNE     SPCNT1
        INCB
SPCNT1  DECA
        BNE     SPCNT
        TSTB
        BEQ     SPNONE          ; (never: a move that changed the board left a square empty)
        JSR     RANDN           ; A = which of them
        LDX     #BOARD
        CLRB
SPFIND  TST     B,X
        BNE     SPSKIP
        DECA
        BMI     SPHERE
SPSKIP  INCB
        BRA     SPFIND
SPHERE  STB     NEWSQ
        LDB     #10
        JSR     RANDN
        TSTA
        BEQ     SPFOUR
        LDA     #1
        BRA     SPPUT
SPFOUR  LDA     #2
SPPUT   LDB     NEWSQ
        STA     B,X
        LDA     #1              ; it pops up: small, then full size
        STA     POP
        JSR     DRAWSQ
        LDB     #3
SPWAIT  JSR     VSYNC
        DECB
        BNE     SPWAIT
        CLR     POP
        LDB     NEWSQ
        JSR     DRAWSQ
SPNONE  RTS

; ---- can any move change the board? -> A = 1 yes, 0 no ----
CANMOVE LDX     #BOARD
        CLRB
CMCELL  LDA     B,X
        BEQ     CMYES           ; an empty square
        PSHS    B
        ANDB    #3
        CMPB    #3
        PULS    B
        BEQ     CMDOWN          ; the right-hand column has no right neighbour
        INCB
        CMPA    B,X             ; the square to the right
        PSHS    CC
        DECB
        PULS    CC
        BEQ     CMYES
CMDOWN  CMPB    #12
        BHS     CMNEXT          ; the bottom row has no neighbour below
        ADDB    #4
        CMPA    B,X             ; the square below
        PSHS    CC
        SUBB    #4
        PULS    CC
        BEQ     CMYES
CMNEXT  INCB
        CMPB    #16
        BNE     CMCELL
        CLRA
        RTS
CMYES   LDA     #1
        RTS

; ---- the first 2048 tile: say so once; play goes on ----
CHKWIN  TST     WONSEEN
        BNE     CWDONE
        LDX     #BOARD
        LDB     #16
CWLOOP  LDA     ,X+
        CMPA    #11
        BHS     CWWON
        DECB
        BNE     CWLOOP
CWDONE  RTS
CWWON   LDA     #1
        STA     WONSEEN
        LDU     #T_WIN
        JSR     MESSAGE
        LDU     #SND_WIN
        JMP     PLAY

; sounds of a move: a short tone, its pitch stepping up with the biggest join (C major pentatonic, C5 to D6); a
; move with no join plays the lowest note. No noise: it read as a buzz on every move (measured ~177 ms), and the
; tone says "moved" without it. TONE's half period is 5*A+22 cycles, so A = round((894886/(2f)-22)/5).
; 60 half periods at the lowest note is 57 ms: short enough not to hold up the next key.
MOVESND LDA     MERGED
        BEQ     MSNOTE          ; no join: the lowest note
        CMPA    #6
        BLS     MSIDX
        LDA     #6
MSIDX   DECA                    ; MERGED is the joined TILE's level (a joined 4 is 3): PENTA[MERGED-1]
        LSLA
        LDX     #PENTA
        LEAX    A,X
        BRA     MSSET
MSNOTE  LDX     #PENTA
MSSET   LDA     ,X
        LDB     1,X
        JSR     TONE
        RTS
; the move notes: delay, half periods - C5, D5, E5, G5, A5, C6, D6
PENTA   FCB     167,64,148,64,131,64,110,64,97,64,81,64,72,64

; ---- the screen ----
; the title page: the name, a row of tiles, how to play; waits for a key (its timing seeds the game)
TITLE   CLRA
        JSR     CLS
        LDA     #$FF            ; red on green, 2x wide, 30 rows tall
        STA     TFG
        CLR     TBG
        LDA     #6
        STA     TROWS
        LDA     #1
        STA     TWIDE
        LDU     #T_NAME
        LDA     #16
        JSR     CENTRE
        CLR     DEMO            ; a row of tiles: 2, 16, 128 and 2048, where the board's columns are
TIDEMO  LDB     DEMO
        LDA     #7
        MUL
        ADDB    #TILEX
        STB     SQCOL
        LDA     #62
        STA     SQROW
        LDX     #DEMOV
        LDB     DEMO
        LDA     B,X
        JSR     TILEAT
        INC     DEMO
        LDA     DEMO
        CMPA    #4
        BNE     TIDEMO
TIDONE  LDA     #$AA            ; blue text on green, 1x wide
        STA     TFG
        CLR     TBG
        CLR     TWIDE
        LDA     #2
        STA     TROWS
        LDU     #T_JOIN
        LDA     #108
        JSR     CENTRE
        LDA     #1
        STA     TROWS
        LDU     #T_KEYS1
        LDA     #130
        JSR     CENTRE
        LDU     #T_KEYS2
        LDA     #140
        JSR     CENTRE
        LDU     #T_KEYS3
        LDA     #150
        JSR     CENTRE
        LDA     #$FF
        STA     TFG
        LDU     #T_PRESS
        LDA     #172
        JSR     CENTRE
        JSR     GETKEY          ; any key plays; BREAK leaves
        CMPA    #K_BREAK
        LBEQ    QUIT
        RTS

; the game screen's frame: the name and score labels, the blue board, the footer's keys
FRAME   CLRA
        JSR     CLS
        LDA     #$FF            ; "2048" in red, 2x wide, 15 rows tall
        STA     TFG
        CLR     TBG
        LDA     #3
        STA     TROWS
        LDA     #1
        STA     TWIDE
        LDU     #T_NAME
        LDB     #BOARDX
        LDA     #2
        JSR     PRINTAT
        LDA     #$AA            ; labels in blue
        STA     TFG
        CLR     TWIDE
        LDA     #1
        STA     TROWS
        LDU     #T_SCORE
        LDB     #14*4           ; column 14 in pixels (the 1x cursor is a pixel)
        LDA     #1
        JSR     PRINTAT
        LDU     #T_BEST
        LDB     #22*4
        LDA     #1
        JSR     PRINTAT
        LDU     #T_HINT
        LDA     #FOOTY
        JSR     CENTRE
        LDA     #BOARDW         ; the board's frame
        STA     BOXW
        LDA     #BOARDH
        STA     BOXH
        LDA     #$AA
        STA     FILLA
        STA     FILLB
        LDB     #BOARDX
        LDA     #BOARDY
        JSR     AT
        JSR     BOX
        JMP     SCORES

; every square, and the scores
SHOWALL CLRB
SALOOP  PSHS    B
        JSR     DRAWSQ
        PULS    B
        INCB
        CMPB    #16
        BNE     SALOOP
        RTS

; square B (0-15) as it is on the board
DRAWSQ  PSHS    B
        ANDB    #3              ; column: bytes 2, 9, 16, 23
        LDA     #7
        MUL
        ADDB    #TILEX
        STB     SQCOL
        LDB     ,S
        LSRB
        LSRB                    ; row: rows 24, 64, 104, 144
        LDA     #40
        MUL
        ADDB    #TILEY
        STB     SQROW
        PULS    B
        LDX     #BOARD
        LDA     B,X
; TILEAT: the tile of value A (0 empty) at SQCOL, SQROW; POP set: only its middle (popping up)
TILEAT  STA     TVAL
        LDB     #4              ; its style: two fills, the text's colour and background
        MUL
        LDX     #STYLES
        ABX
        STX     TSTYLE
        LDA     ,X
        STA     FILLA
        LDA     1,X
        STA     FILLB
        LDA     #TILEW
        STA     BOXW
        LDA     #TILEH
        STA     BOXH
        LDB     SQCOL
        LDA     SQROW
        TST     POP
        BEQ     TAFULL
        CLR     FILLA           ; popping: green around a smaller tile
        CLR     FILLB
        JSR     AT
        JSR     BOX
        LDX     TSTYLE
        LDA     ,X
        STA     FILLA
        LDA     1,X
        STA     FILLB
        LDA     #TILEW-2
        STA     BOXW
        LDA     #TILEH-14
        STA     BOXH
        LDB     SQCOL
        INCB
        LDA     SQROW
        ADDA    #7
TAFULL  JSR     AT
        JSR     BOX
        LDA     TVAL
        LBEQ    TADONE          ; an empty square has no number (the block grew past a short branch)
        LDB     #7              ; the number: its text (7 bytes a value)
        MUL
        ADDD    #NUMBERS-7
        TFR     D,U
        JSR     STRLEN          ; one or two digits 2x wide, more 1x
        CLR     TWIDE
        CMPB    #2
        BHI     TA1X
        INC     TWIDE
        LSLB                    ; 2x: its width in bytes (8 pixels a glyph)
        STB     TXTW
        LDA     #TILEW          ; centred: the column (6-width)/2 in, in BYTES
        SUBA    TXTW
        LSRA
        ADDA    SQCOL
        STA     TXTCOL
        BRA     TABOX
TA1X    LBSR    STRWID          ; 1x is PROPORTIONAL: B is its width in PIXELS
        STB     TXTW            ; keep it: the box below is worked out from the pixels
        LDA     #TILEW*4        ; centred in the tile's 24 pixels, and the 1x cursor is a PIXEL
        SUBA    TXTW            ; (a x4 of the byte column put a 4-digit number outside its tile)
        LSRA
        ANDA    #$FE            ; EVEN: the 1x renderer's phases are 0 and 2 (CENTRE's rule)
        ADDA    SQCOL
        ADDA    SQCOL
        ADDA    SQCOL
        ADDA    SQCOL           ; SQCOL is a byte column: four pixels
        STA     TXTCOL
        LDA     TXTW            ; its box is in BYTES: round the pixels up, 4 to a byte, and
        ADDA    #3              ; count the cell's blank column
        LSRA
        LSRA
        STA     TXTW
TABOX   LDA     TXTW            ; its box: a byte more each side, inside the tile
        ADDA    #2
        CMPA    #TILEW
        BLS     TABOXW
        LDA     #TILEW
TABOXW  STA     BOXW
        LDA     #TILEW
        SUBA    BOXW
        LSRA
        ADDA    SQCOL
        TFR     A,B
        LDX     TSTYLE
        LDA     3,X
        STA     FILLA
        STA     FILLB
        STA     TBG
        LDA     2,X
        STA     TFG
        LDA     #14
        STA     BOXH
        LDA     SQROW
        ADDA    #10
        JSR     AT
        JSR     BOX
        LDA     #2
        STA     TROWS
        LDB     TXTCOL
        LDA     SQROW
        ADDA    #12
        JSR     PRINTAT
TADONE  RTS

; the score and the best score, six digits each, the best kept from game to game
SCORES  LDX     #SCORE          ; a new best?
        LDU     #BEST
        LDB     #3
SCCMP   LDA     ,X+
        CMPA    ,U+
        BHI     SCBEST
        BLO     SCSHOW
        DECB
        BNE     SCCMP
        BRA     SCSHOW
SCBEST  LDD     SCORE
        STD     BEST
        LDA     SCORE+2
        STA     BEST+2
        CLR     POP
SCSHOW  LDA     #$FF            ; red digits, 10 rows tall
        STA     TFG
        CLR     TBG
        CLR     TWIDE
        LDA     #2
        STA     TROWS
        LDX     #SCORE
        LDB     #14*4
        BSR     SCNUM
        LDX     #BEST
        LDB     #22*4
; six BCD digits at X, at pixel column B, row 7, leading zeros as spaces
SCNUM   PSHS    X
        LDA     #7
        JSR     ATPIX
        PULS    U
        CLR     LEAD
        LDB     #3
SCBYTE  LDA     ,U
        LSRA
        LSRA
        LSRA
        LSRA
        BSR     SCDIG
        LDA     ,U+
        ANDA    #$0F
        CMPB    #1              ; the last digit is shown even when 0
        BNE     SCNOT1
        INC     LEAD
SCNOT1  BSR     SCDIG
        DECB
        BNE     SCBYTE
        RTS
SCDIG   TSTA
        BNE     SCSHOWD
        TST     LEAD
        BNE     SCSHOWD
        LDA     #$20
        JMP     PUTCH
SCSHOWD INC     LEAD
        ADDA    #'0
        JMP     PUTCH

; MESSAGE: the string at U on the footer, in red (cleared first)
MESSAGE PSHS    U
        LDA     #32
        STA     BOXW
        LDA     #7
        STA     BOXH
        CLR     FILLA
        CLR     FILLB
        CLRB
        LDA     #FOOTY-1
        JSR     AT
        JSR     BOX
        LDA     #$FF
        STA     TFG
        CLR     TBG
        CLR     TWIDE
        LDA     #1
        STA     TROWS
        PULS    U
        LDA     #FOOTY
        JMP     CENTRE

; ---- data ----
; keys: code, direction (0 ends)
DEMOV   FCB     1,4,7,11
KEYDIR  FCB     K_UP,0,'W,0,K_RIGHT,1,'D,1,K_DOWN,2,'S,2,K_LEFT,3,'A,3,0
; the squares of each direction's four lines, from the edge the tiles move to
LINES   FCB     0,4,8,12,1,5,9,13,2,6,10,14,3,7,11,15          ; up
        FCB     3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12          ; right
        FCB     12,8,4,0,13,9,5,1,14,10,6,2,15,11,7,3          ; down
        FCB     0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15          ; left
; 2^n in BCD, n = 1-17 (the score each join adds)
VALUES  FCB     $00,$00,$02,$00,$00,$04,$00,$00,$08,$00,$00,$16,$00,$00,$32,$00,$00,$64
        FCB     $00,$01,$28,$00,$02,$56,$00,$05,$12,$00,$10,$24,$00,$20,$48,$00,$40,$96
        FCB     $00,$81,$92,$01,$63,$84,$03,$27,$68,$06,$55,$36,$13,$10,$72
; the tiles' numbers, 7 bytes each (0 ends), n = 1-17
NUMBERS FCC     "2"
        FCB     0,0,0,0,0,0
        FCC     "4"
        FCB     0,0,0,0,0,0
        FCC     "8"
        FCB     0,0,0,0,0,0
        FCC     "16"
        FCB     0,0,0,0,0
        FCC     "32"
        FCB     0,0,0,0,0
        FCC     "64"
        FCB     0,0,0,0,0
        FCC     "128"
        FCB     0,0,0,0
        FCC     "256"
        FCB     0,0,0,0
        FCC     "512"
        FCB     0,0,0,0
        FCC     "1024"
        FCB     0,0,0
        FCC     "2048"
        FCB     0,0,0
        FCC     "4096"
        FCB     0,0,0
        FCC     "8192"
        FCB     0,0,0
        FCC     "16384"
        FCB     0,0
        FCC     "32768"
        FCB     0,0
        FCC     "65536"
        FCB     0,0
        FCC     "131K"
        FCB     0,0,0
; tile styles, n = 0-17: even-row fill, odd-row fill, text colour, text background (fill bytes:
; colour 0 green $00, 1 yellow $55, 2 blue $AA, 3 red $FF; mixed bytes are patterns)
STYLES  FCB     $00,$00,$00,$00         ; empty: green
        FCB     $55,$55,$AA,$55         ; 2: yellow
        FCB     $FF,$FF,$55,$FF         ; 4: red
        FCB     $77,$DD,$FF,$55         ; 8: yellow and red check
        FCB     $66,$99,$AA,$55         ; 16: yellow and blue check
        FCB     $EE,$BB,$55,$FF         ; 32: red and blue check
        FCB     $55,$FF,$55,$AA         ; 64: yellow and red stripes
        FCB     $11,$44,$FF,$55         ; 128: green and yellow check
        FCB     $33,$CC,$55,$FF         ; 256: green and red check
        FCB     $FF,$AA,$55,$AA         ; 512: red and blue stripes
        FCB     $55,$AA,$FF,$55         ; 1024: yellow and blue stripes
        FCB     $77,$77,$AA,$55         ; 2048: yellow and red columns
        FCB     $BB,$BB,$55,$AA         ; 4096: red and blue columns
        FCB     $66,$66,$FF,$55         ; 8192: yellow and blue columns
        FCB     $FF,$FF,$AA,$55         ; 16384
        FCB     $55,$55,$FF,$AA         ; 32768
        FCB     $77,$DD,$AA,$FF         ; 65536
        FCB     $EE,$BB,$FF,$55         ; 131072
; sounds: delay, half periods. The win is a rising C major pentatonic arpeggio (C5 E5 G5 A5 C6) and the loss the
; same run falling; the open-halves are the move cues in PENTA, above.
SND_WIN FCB     167,40,131,40,110,40,97,40,81,40,0
SND_OVER
        FCB     81,40,110,40,131,40,167,40,0
; text
T_NAME  FCN     "2048"
T_JOIN  FCN     "JOIN THE TILES TO MAKE 2048"
T_KEYS1 FCN     "ARROWS OR WASD SLIDE THEM"
T_KEYS2 FCN     "R STARTS AGAIN"
T_KEYS3 FCN     "BREAK LEAVES"
T_PRESS FCN     "PRESS A KEY TO PLAY"
T_SCORE FCN     "SCORE"
T_BEST  FCN     "BEST"
T_HINT  FCN     "ARROWS  R=NEW  BREAK=QUIT"
T_WIN   FCN     "YOU MADE 2048! PLAY ON"
T_OVER  FCN     "NO MOVES LEFT. R PLAYS AGAIN"

        INCLUDE "games.inc"

; ---- the game's state ----
BOARD   RMB     16              ; a square's value n: the tile 2^n, 0 empty
SCORE   RMB     3               ; BCD, the most significant byte first
BEST    RMB     3
MOVES   RMB     2               ; moves that changed the board
LOST    RMB     1               ; no move left
WONSEEN RMB     1               ; 2048 has been made
DIR     RMB     1
CHANGED RMB     1
MERGED  RMB     1
LINE    RMB     4
OUT     RMB     4
OUTN    RMB     1
LASTV   RMB     1
LINEN   RMB     1
NEWSQ   RMB     1
POP     RMB     1
SQCOL   RMB     1
SQROW   RMB     1
TVAL    RMB     1
TSTYLE  RMB     2
TXTW    RMB     1
TXTCOL  RMB     1
LEAD    RMB     1
DEMO    RMB     1

        END     ENTRY
