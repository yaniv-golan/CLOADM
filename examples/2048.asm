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
; when no move changes the board; reaching 2048 says so, and play goes on. A move is drawn as it
; happens: the tiles travel over three fields, the joined squares flash once, then the new tile pops
; (SLIDE); a key pressed meanwhile ends that and is played as the next move.
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
SLIDEF  EQU     3               ; a slide is seen over three fields (tiles move on 3 fields)

START   ORCC    #$50            ; no interrupts
        LDS     #$3000          ; the stack below the program
        LDD     #0
        STD     ENTROPY
        STD     BEST
        STA     BEST+2
        CLR     POP
        CLR     KQN             ; (the CoCo 3 does not zero its RAM: every variable the loop reads first is
        CLR     SKIPPED         ;  cleared here; the old game cleared its own at NEWGAME, these are new)
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
        ; NOT KQN: R can arrive with keys queued behind it (LEFT, R, LEFT), and each of those keys is the
        ; player's and must be played. The queue is cleared once, in START.
        CLR     SKIPPED
        LDD     #0
        STD     MOVES
        JSR     FRAME
        JSR     SPAWN
        JSR     SPAWN
        JSR     SHOWALL

; ---- the game loop: a key, a move ----
; A move is drawn as it happened (SLIDE): its tiles travel, the joined squares flash, then the new tile
; pops. A key during that stops it there and is played next, at once; a key from the game's own wait
; (GETKEY) is played as a move of its own, its slide its own.
GLOOP   JSR     KQPOP           ; a key pressed during the last animation: play it now, no slide
        BEQ     GLWAIT
        STA     KQTMP           ; keep the key: the flag write below uses A
        LDA     #1
        STA     SKIPPED
        LDA     KQTMP
        BRA     GLHAVE
GLWAIT  JSR     GETKEY
        CLR     SKIPPED
GLHAVE  CMPA    #K_BREAK
        LBEQ    QUIT
        CMPA    #'R
        LBEQ    NEWGAME
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
        BEQ     GLNOMOVE        ; nothing moved: no new tile, no slide
        LDD     MOVES
        ADDD    #1
        STD     MOVES
        JSR     MOVESND
        TST     SKIPPED
        BEQ     GLSLIDE
        CLR     SKIPPED         ; a queued key's own move: drawn whole, at once
        BRA     GLDONE
GLSLIDE JSR     SLIDE           ; (may leave keys queued for the next move)
GLDONE  JSR     SHOWALL
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
        LBRA    GLOOP
GLNOMOVE CLR    SKIPPED
        LBRA    GLOOP

QUIT    JSR     GTEXT
        JMP     DONE

; ---- a move: DIR 0 up, 1 right, 2 down, 3 left ----
; Each direction is four lines of four squares, listed from the edge the tiles move to (LINES).
; A line is read into LINE, packed towards its start with equal neighbours joined (a joined tile
; does not join again in the same move), and written back.
DOMOVE  CLR     CHANGED
        CLR     MERGED
        CLR     MOVN
        CLR     MRGN
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
        STU     LNP             ; the line's squares, for the replay
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
        JSR     MLAY            ; record this line's movers and joins
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

; MLAY: replay one packed line into movers. LINE is what the line was, OUT what it became; LNP holds its four
; square numbers. Each output cell takes one source tile, or a join (OUT = LINE + 1) takes the tile the pack
; read next, which also lands on that cell. A tile that keeps its square is not a mover. A join's square goes
; in MRGL, for the flash. PKI walks LINE, PKO OUT.
MLAY    CLR     PKI
        CLR     PKO
MLAL    LDA     PKI
        CMPA    #4
        BEQ     MLADONE
        LDX     #LINE
        LDB     PKI
        LDA     B,X
        BEQ     MLASNEXT        ; an empty square
        STA     MVAL
        LDX     #OUT
        LDB     PKO
        LDA     B,X
        BEQ     MLADONE
        CMPA    MVAL
        BEQ     MLAWHOLE        ; a whole tile moved here
        DECA
        CMPA    MVAL
        LBNE    MLADONE         ; (never: the pack makes a join or a copy)
        LDA     #1
        STA     FLAGJ
        BRA     MLAREC
MLAWHOLE CLR    FLAGJ
MLAREC  JSR     MLAMOVE        ; record PKI -> PKO (if it moved)
        TST     FLAGJ
        BEQ     MLATAKE
        JSR     MLALIT         ; the join lights its square
        JSR     MLAPAIR        ; and its second tile moves there too
        BRA     MLASTEP
MLATAKE INC     PKI             ; one source tile consumed
MLASTEP INC     PKO             ; one output cell filled
        LBRA    MLAL
MLASNEXT INC   PKI             ; an empty square: it consumes no output cell
        LBRA    MLAL
MLADONE RTS

; MLAMOVE: record the mover PKI -> PKO from its LNP square numbers, when they differ, and the tile's own
; value (LINE[PKI]: what it was before the pack, so a joining tile slides in showing what it WAS, not what
; the join makes it)
MLAMOVE LDB     PKI
        LDX     LNP
        LDA     B,X
        STA     MFROM
        LDB     PKO
        LDX     LNP
        LDA     B,X             ; to
        CMPA    MFROM
        BEQ     MLAMRET
        STA     MTO
        LDB     MOVN
        LDA     #2
        MUL
        ADDD    #MFR
        TFR     D,X
        LDA     MFROM
        STA     ,X+
        LDA     MTO
        STA     ,X
        LDB     MOVN            ; its own value, by mover index (MOVN is not yet incremented).
        LDA     PKI             ; X and U belong to the caller: use X only, twice
        LDX     #LINE
        LDA     A,X
        LDX     #MVF
        STA     B,X
        INC     MOVN
MLAMRET RTS

; MLALIT: the square PKO joins, in MRGL
MLALIT  LDB     MRGN
        CMPB    #16
        BEQ     MLALRET
        LDB     PKO
        LDX     LNP
        LDA     B,X
        LDX     #MRGL
        LDB     MRGN
        STA     B,X
        INC     MRGN
MLALRET RTS

; MLAPAIR: the tile after PKI that joined onto it - the pack's next non-empty LINE square
MLAPAIR INC     PKI
        LDA     PKI
        CMPA    #4
        BEQ     MLAPDONE
        LDX     #LINE
        LDB     PKI
        LDA     B,X
        BEQ     MLAPAIR
        JSR     MLAMOVE
        INC     PKI
MLAPDONE RTS

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
        LDA     #3              ; (count in A: SLFIELD clobbers B)
; The pop is part of the move's animation, so a key ends it at once, as it ends the slide's fields: each pop
; field is one VSYNC, one ENTROPY tick and one POLCAT poll (SLFIELD), and a key is queued for the next move.
SPWAIT  PSHS    A
        JSR     SLFIELD
        LDA     KQN
        PULS    A
        BNE     SPDONE          ; a key is queued: the pop finishes at once; the game loop plays it next
        DECA
        BNE     SPWAIT
SPDONE  CLR     POP
        LDB     NEWSQ
        JSR     DRAWSQ          ; the tile at full size, whether the pop ran out or a key cut it
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
        JSR     SQPOS           ; its top left: SQCOL, SQROW
        LDX     #BOARD
        LDA     B,X             ; its value, off the board
        JSR     TILEAT          ; and the tile there
        PULS    B,PC

; SQPOS: square B (0-15) -> SQCOL (byte: 2, 9, 16, 23) and SQROW (24, 64, 104, 144), its top left.
; Leaves B as it found it. The slide draws a tile at a square it is passing over the same way.
SQPOS   PSHS    B
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
        PULS    B,PC

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
        LSRA                    ; no even mask is needed: a digit string is 4n-1 px wide, so (24-width)/2
                                ; shifted is always even, and SQCOL*4 is even. tests/cursor-phases.test.js
                                ; checks the column the renderer ends up with, not this reasoning.
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


; ---- the slide: a move's tiles travel to where they land over SLIDEF fields, the joined squares
; flash once, and the new tile pops. Each field is one ENTROPY tick and one POLCAT poll (the field clock
; the tests read); a key stops the whole thing at once, is QUEUED (KQ), and is played as the next move,
; drawn whole with no slide of its own.
;
; A mover is a (from, to) pair the pack recorded in MFR, with the tile's OWN value in MVF (what it was before
; the pack): a joining tile slides in showing that, and becomes the merged value only on the flash. A joined
; square is in MRGL.
;
; A tile between squares is drawn on one square of its own line at a time (a column 0-3, or rows 0, 4, 8,
; 12): its own rectangle only. Each field every mover's tile is drawn where it is now, and only THEN is a
; square a mover has left emptied - and only if no mover is on it this field. Drawing first and blanking
; second means a tile is never missing: a mover parked on a square another mover crosses keeps showing, and a
; mover stepping onto a square another has just left still ends up drawn, whichever order the table is in.

; SLIDE: draw the move just packed as it happened, then flash what joined
SLIDE   CLR     SKIPPED
        CLR     MFIELD
SLNEXT  INC     MFIELD
        JSR     SLPASS
        JSR     SLFIELD         ; one field: the sync, one ENTROPY tick, one key
        LDA     KQN
        BNE     SLDONE          ; a key is queued: the rest is not shown
        LDA     MFIELD
        CMPA    #SLIDEF
        BLO     SLNEXT
        JSR     FLASH
SLDONE  RTS

; SLPASS: the field MFIELD. Every mover's tile is drawn where it is now, THEN each square a mover has
; left is emptied - unless another mover is on it now. Drawing first and blanking second means no frame
; ever shows a square empty that a mover occupies: a mover parked on a square a moving mover has just
; left keeps it drawn, and a tile never blinks out for part of a field.
SLPASS  CLR     MI
SPDRAW  LDA     MI
        CMPA    MOVN
        BHS     SPCLR0
        JSR     SPOS            ; MTMP (now), MPREV (a field ago), MV (Z set when it did not move)
        LDB     MTMP
        JSR     SPTILE
        INC     MI
        BRA     SPDRAW
SPCLR0  CLR     MI
SPCLR   LDA     MI
        CMPA    MOVN
        BHS     SPRET
        JSR     SPOS
        BEQ     SPCN            ; it did not move: nothing of its own to clear
        LDA     MPREV           ; (keep it: SPOCC calls SPOS, which overwrites MPREV)
        STA     SPKEEP
        JSR     SPOCC           ; is a mover on that square now?  Z clear = yes: leave it
        BNE     SPCN
        LDB     SPKEEP
        JSR     SPEMPTY
SPCN    INC     MI
        BRA     SPCLR
SPRET   RTS

; SPOCC: A = a square -> Z set when NO mover is on that square this field (clear when one is), so a
; square a mover has just left can be emptied only if nobody has stepped onto it.
SPOCC   PSHS    A,B,X
        STA     SPQ             ; the square asked about
        LDA     MI              ; SPOS reads MI: keep ours and walk MI2 through it
        STA     SPMI
        CLR     MI2
SPOL    LDA     MI2
        CMPA    MOVN
        BHS     SPOFREE
        STA     MI              ; SPOS now examines mover MI2
        JSR     SPOS            ; fills MTMP
        LDA     MTMP
        CMPA    SPQ
        BEQ     SPOTAKEN
        INC     MI2
        BRA     SPOL
SPOTAKEN LDA     SPMI            ; restore the caller's MI before returning
        STA     MI
        LDA     #1
        PULS    A,B,X,PC        ; Z clear: taken
SPOFREE LDA     SPMI
        STA     MI
        CLRA
        PULS    A,B,X,PC        ; Z set: free

; SPOS: mover MI at the field MFIELD -> MTMP (its square now), MPREV (its square a field ago) and MV (its
; own value MVF[MI]); Z set when those are the same square (it did not move this field).
SPOS    LDB     MI
        LSLB
        LDX     #MFR
        LEAX    B,X
        LDA     ,X              ; from
        STA     MSQ
        LDA     1,X             ; to
        STA     MTO
        LDB     MI              ; its own value, recorded by the pack: a joining tile slides in as what it
        LDX     #MVF            ; was, not as the value the join makes (that appears on the flash)
        LDA     B,X
        STA     MV
        LDA     MTO
        SUBA    MSQ             ; to - from: positive when the line runs up or left
        BPL     SPOSF
        LDA     #$FF            ; a Right or Down slide trips back up the line
        STA     MSTEP
        LDA     MSQ
        SUBA    MTO             ; its distance
        BRA     SPOSD
SPOSF   LDA     #1
        STA     MSTEP
        LDA     MSQ
        NEGA
        ADDA    MTO             ; to - from
SPOSD   CMPA    #4              ; a column (4, 8 or 12 between the cells) or a row (1, 2 or 3)
        BLO     SPOSH
        LSRA
        LSRA                    ; four squares to a row
        STA     MK
        LDA     MSTEP
        LSLA
        LSLA                    ; its step is a whole row
        STA     MSTEP
        BRA     SPOSG
SPOSH   STA     MK
SPOSG   LDA     MFIELD
        JSR     SPLACE
        STA     MTRV
        LDA     MFIELD
        DECA
        BEQ     SPOS0
        JSR     SPLACE
        BRA     SPOS1
SPOS0   CLRA
SPOS1   STA     MTRVP
        LDA     MTRVP           ; the square it was on, and the one it is on now: always worked out, so a
        JSR     SPSQ            ; parked mover can be redrawn when another mover has blanked its square
        STA     MPREV
        LDA     MTRV
        JSR     SPSQ
        STA     MTMP
        LDA     MTRV
        CMPA    MTRVP
        BEQ     SPOSN           ; Z set: it did not move this field
        LDA     #1
        RTS
SPOSN   CLRA
        RTS

; SPSQ: A = squares travelled -> A = the square, MSQ + travel x MSTEP (the steps are kept in range)
SPSQ    PSHS    B
        TFR     A,B
        LDA     MSQ
        TSTB
        BEQ     SPSQD
SPSQL   ADDA    MSTEP
        DECB
        BNE     SPSQL
SPSQD   PULS    B,PC

; SPLACE: A = a field (1..SLIDEF) -> A = round(field/SLIDEF x MK), squares travelled by then. Index is
; (field-1)*SLIDEF + MK - 1 into SPSTEP, which holds SLIDEF entries for each travel 1..SLIDEF.
SPLACE  PSHS    B
        DECA
        LDB     #SLIDEF
        MUL                     ; D = (field-1) x SLIDEF
        ADDB    MK
        DECB                    ; B = index into SPSTEP
        LDX     #SPSTEP
        LEAX    B,X
        LDA     ,X
        PULS    B,PC
; SPSTEP is SLIDEF rows of SLIDEF: row MK-1 (travel 1..SLIDEF) holds the squares reached at fields
; 1..SLIDEF, i.e. round(f/SLIDEF x travel) - a 3-square slide is seen on all three (0,1,1 / 1,1,2 / 1,2,3),
; and a 1-square slide reaches its square on field 2 (row 0 is 0,1,1), not only on the last field. The table
; is written for SLIDEF 3; tests/games-slide.test.js probes the drawn positions on every crossed square, so a
; SLIDEF change without a matching table turns those checks red (checked: SLIDEF 4 does).
SPSTEP  FCB     0,1,1
        FCB     1,1,2
        FCB     1,2,3

; SPEMPTY: B = a square -> its box in the empty style
SPEMPTY JSR     SQPOS
        CLRA
        JMP     TILEAT

; SPTILE: B = a square -> the mover's tile (MV) there
SPTILE  JSR     SQPOS
        LDA     MV
        JMP     TILEAT

; SLFIELD: one field -> the sync, one ENTROPY tick, one POLCAT poll for a key. A key stops the drawing
; and is kept as the next move.
SLFIELD JSR     VSYNC
        LDD     ENTROPY
        ADDD    #1
        STD     ENTROPY
        JSR     [POLCAT]
        BEQ     SLFRET
        STA     KQKEY           ; queue it: a later key must not overwrite an earlier one
        JSR     KQPUSH
SLFRET  RTS

; KQPUSH: queue the key in A for the game loop, if there is room (a bounded queue of KQN keys). Each queued
; key is played as its own move, in order, once the animation ends.
KQPUSH  PSHS    A,B
        LDB     KQN
        CMPB    #4              ; full: the player is pressing faster than the game can play; drop the newest
        BHS     KQPD
        LDX     #KQ
        ABX
        LDA     KQKEY           ; the key, put there by SLFIELD (no stack arithmetic)
        STA     ,X
        INC     KQN
KQPD    PULS    A,B,PC

; KQPOP: the oldest queued key -> A (Z set when none). Shifts the rest down, so order is kept.
KQPOP   PSHS    B,X
        LDA     KQN
        BEQ     KQP0
        LDX     #KQ
        LDA     ,X              ; the oldest key
        STA     KQTMP
        DEC     KQN             ; one fewer queued
        CLRB                    ; B = 0: i
KQSH    CMPB    KQN
        BHS     KQSHD           ; i >= KQN: done
        LDA     1,X             ; KQ[i+1]
        STA     ,X              ; -> KQ[i]
        LEAX    1,X
        INCB
        BRA     KQSH
KQSHD   LDA     KQTMP
        PULS    B,X,PC          ; Z clear: a key
KQP0    CLRA
        PULS    B,X,PC          ; Z set: none

; FLASH: the joined squares, one field in a fill no tile has, then their own again. A key cuts it.
FLASH   TST     MRGN
        BEQ     FLDONE          ; nothing joined: no flash
        LDA     #1              ; the tests' marker: 1 from before the first box is painted until the restore
        STA     FLMARK          ; begins, so every field tick in between is a flash tick and is read
        CLR     FLREST
        CLR     MI
FLLOOP  LDA     MI
        CMPA    MRGN
        BHS     FLTICK
        LDX     #MRGL
        LDB     MI
        LDB     B,X             ; the join square, in B for SQPOS
        JSR     SQPOS
        LDA     #$AA
        STA     FILLA
        LDA     #$55
        STA     FILLB
        LDA     #TILEW
        STA     BOXW
        LDA     #TILEH
        STA     BOXH
        LDB     SQCOL
        LDA     SQROW
        JSR     AT
        JSR     BOX
        INC     MI
        BRA     FLLOOP
FLTICK  JSR     SLFIELD
        CLR     FLMARK
        LDA     KQN
        BEQ     FLGO
        CLR     FLREST
        BRA     FLDONE
FLGO    LDA     #1              ; the tests' marker: the restore (the flash taken down) has begun
        STA     FLREST
        CLR     MI
FLRLOO  LDA     MI
        CMPA    MRGN
        BHS     FLRDONE
        LDX     #MRGL
        LDB     MI
        LDB     B,X             ; the join square, in B for DRAWSQ
        JSR     DRAWSQ          ; the square as the board has it
        INC     MI
        BRA     FLRLOO
FLRDONE CLR     FLREST
FLDONE  RTS

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
; the slide. A move's movers are replayed from LINE (what a line was) and OUT (what it became) after it packs:
; a difference of the board before and after cannot say who travelled once two 2s are one 4. A mover is two
; bytes, from and to, and MVF holds each mover's own value; a join lights the square it landed on (MRGL).
MOVN    RMB     1
MRGN    RMB     1
MFR     RMB     32              ; 16 movers, from and to
MVF     RMB     16              ; each mover's own value before the pack (a joining tile shows this)
MRGL    RMB     16
LNP     RMB     2               ; the line being packed: its four square numbers
PKI     RMB     1               ; the square of the line being replayed
PKO     RMB     1
MVAL    RMB     1
FLAGJ   RMB     1
MFROM   RMB     1
MTO     RMB     1
MI      RMB     1
MK      RMB     1               ; this mover's travel, in squares
KQ      RMB     4               ; a key pressed during the animation: played as the next move, in order
KQN     RMB     1               ; how many keys are queued (0-4)
KQTMP   RMB     1               ; KQPOP's key, while the queue shifts down
KQKEY   RMB     1               ; the key SLFIELD is queueing
SKIPPED RMB     1               ; the move now being played came from the queue: draw it whole, no slide
MFIELD  RMB     1               ; the slide's field being drawn (1..SLIDEF)
MSQ     RMB     1               ; a mover: its from square
MSTEP   RMB     1               ; ... and a square of its line: 1 along a row, 4 (or $FC) down a column
MTMP    RMB     1               ; the square it is on this field, and the one it was on a field ago
MPREV   RMB     1
MTRV    RMB     1               ; squares travelled this field, and a field ago
MTRVP   RMB     1
MI2     RMB     1
SPQ     RMB     1               ; SPOCC: the square being asked about
SPMI    RMB     1               ; SPOCC: the caller's MI, kept across the walk
SPKEEP  RMB     1               ; SLPASS: the square a mover left, kept across SPOCC
FLMARK  RMB     1               ; 1 while the flash field's tick is being taken (tests read the screen then)
FLREST  RMB     1               ; 1 from the start of the restore until it is done (tests: same field as the tick)
MV      RMB     1               ; its tile's value at the field being drawn (MVF[MI], its own)

        END     ENTRY
