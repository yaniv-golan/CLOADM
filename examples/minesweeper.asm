; ---------------------------------------------------------------
; MINESWEEPER - open every square that hides no mine.
; 6809 assembly, written for CLOADM. Runs with no ROMs (the built-in firmware) or with BASIC, on
; the Dragon 32/64/200, Tano, CoCo 1/2/3 and clones. The 128x192 four-colour screen in its second
; colour set (buff, cyan, magenta, orange); the shared routines are in games.inc.
;
; An 8x8 field with 10 mines. The arrows move, and so does either joystick (one step as it leaves the
; centre, then again after 300 ms and every 120 ms while it is held). SPACE or ENTER opens a square, and so
; does a tap of either fire button, on the release; F puts a flag on it or takes it off, and so does a hold
; of fire for 400 ms, at that moment. R starts again (and so does fire, once the game is won or lost);
; BREAK leaves (back to the text screen, then DONE). Each joystick is read with the sound off, so the
; reading makes no buzz; a key that fire's own row makes look pressed is ignored while fire is down.
; An open square shows how many of its eight neighbours hide a mine; a square with none opens
; its neighbours too, and so on (a queue of squares, never recursion: the stack stays put). The
; mines are laid when the first square is opened, never on it or next to it, so the first square
; always opens an area. Opening a mine loses; opening the 54 safe squares wins. A flagged square
; does not open until its flag is taken off; at most 10 flags.
; Build: node tools/build-examples.js  (examples/minesweeper.bin)
; ---------------------------------------------------------------

        ORG     $3000
; ---- fixed entry points: js/session.js GAMES and the tests know these addresses ----
ENTRY   JMP     START           ; $3000
SEED    FDB     0               ; $3003 nonzero: the random numbers start here (tests)
DONE    BRA     DONE            ; $3005 stopped after BREAK
SAMEXIT FCB     2               ; $3007 the SAM's M to put back on leaving (games.inc)

MINES   EQU     10
SAFE    EQU     64-MINES
CELLX   EQU     4               ; the field: 8 squares of 3 bytes (11 pixels and a line) from byte 4,
CELLY   EQU     24              ; 8 of 20 rows (19 and a line) from row 24
CSS     EQU     $08             ; the second colour set
HIDDEN  EQU     0               ; STATE values
OPEN    EQU     1
FLAGGED EQU     2

START   ORCC    #$50            ; no interrupts
        LDS     #$3000          ; the stack below the program
        LDD     #0
        STD     ENTROPY
        LDA     #CSS
        JSR     GINIT
        JSR     JOYINIT         ; the key columns as outputs, the joystick on its x axis, the DAC at silence
        JSR     DETECT          ; 50 or 60 Hz, once, BEFORE the title: it is a loop of CPU cycles waiting on
                                ; the field flag, and run after the title it would hold the field back a
                                ; further 0.3 s with nothing on the screen
        JSR     TITLE           ; (DETECT only reads the PIA, so the field being drawn is no matter)
        JSR     RANDOMIZE

; ---- a new game ----
NEWGAME LDX     #FIELD          ; FIELD: bit 7 a mine, bits 3-0 the mines next to it; STATE: as above
        LDB     #128
NGCLR   CLR     ,X+
        DECB
        BNE     NGCLR
        LDD     #$0303          ; the cursor in the middle
        STD     CURX
        LDA     #3*8+3
        STA     SELECT
        CLR     PLANTED
        CLR     LOST
        CLR     WON
        CLR     OPENED
        CLR     FLAGS
        CLR     JOYDIR
        CLR     JOYPRE
        CLR     JOYWAIT
        CLR     FIREDN
        CLR     FIRECNT
        CLR     FIREREL
        JSR     FRAME

; ---- the game loop: one field of input, then whatever it asked for ----
; The stick steps once as it leaves the centre, then after 300 ms, then every 120 ms. The wait starts with
; the step it follows: a new direction's step sets 300 ms, a repeat's sets 120 ms. A field of input that
; takes no step spends one field of the wait, so at 50 Hz the steps are at fields 1, 16, 22, 28 ... - the
; first step and then every 6 fields, the 300 ms one 15 fields after the first (18 and 7 at 60 Hz).
GLOOP   BSR     RAWL
        LDA     JOYDIR
        BEQ     GLCENTRE        ; a centred stick: no step, and nothing to repeat
        CMPA    JOYPRE
        BEQ     GLSAME
        STA     JOYPRE          ; a new direction: one step now, then 300 ms
        LDA     FW300
        STA     JOYWAIT
        BRA     GLSTEP
GLCENTRE
        CLR     JOYWAIT
        CLR     JOYPRE          ; the centre is no direction: pushing the SAME way again is a new press
        BRA     GLKEY
GLSAME  DEC     JOYWAIT         ; the same direction: a repeat is due when the wait runs out
        BNE     GLKEY
GLREP   LDA     FW120
        STA     JOYWAIT
GLSTEP  LDA     JOYDIR          ; the direction now: the new one, or the repeat of the same
        PSHS    A               ; kept for the axis below (PSHS leaves A alone)
        LDB     #2
        MUL
        ADDD    #JOYDIRS
        TFR     D,X
        JSR     MOVE
        PULS    A               ; MOVE redraws and plays a tick; the stack is balanced here, so this returns
        CMPA    #2              ; up and down are the y axis; left and right are x
        BHI     GLX
        LDA     #1
        BRA     GLLAST
GLX     CLRA
GLLAST  STA     JOYLAST
GLKEY   TST     LOST            ; over: fire RESTARTS, on its RELEASE: the press that ends a game must
        BNE     GLOVER          ; be let go first, or a long one carries into the new game as a tap
        TST     WON
        BNE     GLOVER
        BRA     GLKEYS
GLOVER  LDA     FIREREL         ; the field fire came up on, if it did
        BEQ     GLKEYS          ; still down (or not pressed yet): nothing, however long
        LBRA    NEWGAME
GLKEYS  LDA     IN
        CMPA    #K_BREAK
        LBEQ    QUIT
        CMPA    #'R
        LBEQ    NEWGAME
        TST     LOST
        BNE     GLOOP           ; over: R, BREAK or fire only
        TST     WON
        BNE     GLOOP
        JSR     DISPATCH
        BRA     GLOOP

; RAWL: one field of input -> IN (a key, a fire action, or 0) and JOYDIR (the stick, either joystick).
; The poll counts in ENTROPY as GETKEY's does, once a field rather than in a tight loop.
RAWL    PSHS    D,X,Y
RLWAIT  JSR     VSYNC
        CLR     FIREREL         ; "fire came up on THIS field": the over screen restarts on it (GLOVER)
        LDD     ENTROPY
        ADDD    #1
        STD     ENTROPY
        JSR     [POLCAT]
        BEQ     RLNOKEY
        JSR     KEYOK           ; 0 (Z set) for a key fire's rows 0 and 1 make phantom
        BEQ     RLNOKEY
        STA     KEYIN
        BRA     RLFIRE
RLNOKEY CLR     KEYIN
RLFIRE  JSR     JOYFIRE
        TSTA
        BNE     RLDOWN
        TST     FIREDN
        BEQ     RLJOY           ; not pressed, or released before it counted
        CLR     FIREDN
        LDA     #1
        STA     FIREREL         ; it came up this field
        LDA     FIRECNT
        CMPA    FW400
        BHS     RLJOY           ; a hold: it flagged on its 400 ms field, and the release does nothing
        LDA     #$20            ; a tap: OPEN on the release
        STA     FIREIN
        BRA     RLJOY
RLDOWN  TST     FIREDN
        BNE     RLCOUNT
        LDA     #1
        STA     FIREDN
        STA     FIRECNT         ; the field it went down on is the first of the count: a press held for
        BRA     RLJOY           ; exactly 400 ms flags, and 400 ms less one opens
RLCOUNT LDA     FIRECNT
        CMPA    FW400
        BHS     RLJOY           ; already flagged: once a hold
        INCA
        STA     FIRECNT
        CMPA    FW400
        BNE     RLJOY
        LDA     #'F             ; held for 400 ms: FLAG now, with its sound
        STA     FIREIN
RLJOY   JSR     JOYREAD
        STA     JOYDIR
        LDA     KEYIN           ; a key wins the field; otherwise fire's action
        BNE     RLDONE
        LDA     FIREIN
RLDONE  STA     IN
        CLR     FIREIN
        PULS    D,X,Y,PC

; KEYOK: A = the key the ROM's POLCAT gave. While fire is down, a key in matrix row 0 or 1 is not a key:
; pulling PA0 or PA1 down for fire makes those rows read as pressed, so the ROM can hand one back. The rows
; are not the same on every machine (a Dragon's row 0 is '0'-'7' and row 1 '8'-'/', a CoCo's row 0 @ and
; A-G and row 1 H-O), and which table applies cannot be known from the game, so BOTH are dropped: the union
; costs only 'F' while fire is down, which is no loss because a held fire flags anyway. R, BREAK, the
; arrows, SPACE, ENTER and the rest are never in those rows, so no real key is affected.
KEYOK   TST     FIREDN
        BEQ     KYKEEP
        LDX     #PHANTOM
KYLOOP  LDB     ,X+
        BEQ     KYKEEP
        PSHS    A
        CMPB    ,S+
        BNE     KYLOOP
        CLRA
KYKEEP  TSTA                    ; the caller tests Z: the key, or none, not the loop's last load
        RTS

; DISPATCH: the key or fire action in IN, with the game on
DISPATCH LDA    IN
        CMPA    #$20
        BEQ     DSPOPEN
        CMPA    #K_ENTER
        BEQ     DSPOPEN
        CMPA    #'F
        BNE     DSPMOVE
        JSR     FLAG
        RTS
DSPOPEN JSR     REVEAL
        RTS
DSPMOVE LDX     #KEYMOVE
DSM1    LDB     ,X+             ; the key, then its dx and dy (a 0 key ends the table)
        BEQ     DSPNONE
        CMPA    -1,X
        BNE     DSM2
        ; The axis, from the entry's dy, before the call: MOVE (and TONE, which it jumps to last) uses
        ; A, B and X, so the value cannot stay in one of them across it. MOVE's own stack is balanced
        ; before its JMP TONE, so that jump returns to MOVE's caller as an RTS would.
        LDA     #0
        LDB     1,X             ; the dy of THIS entry (a key at ,X+ leaves X on its dx)
        TSTB
        BEQ     DSMX
        LDA     #1
DSMX    STA     JDAXIS
        JSR     MOVE
        LDA     JDAXIS
DSMLAST STA     JOYLAST
        CLR     JOYPRE          ; a key's move is not the stick's: a stick still pushed steps AGAIN on the next
        LDA     FW300           ; field (measured: the key's step, then the stick's, one field apart), and the
        STA     JOYWAIT         ; 300 ms wait then counts from that stick step
        RTS
DSM2    LEAX    2,X
        BRA     DSM1
DSPNONE RTS

QUIT    JSR     GTEXT
        JMP     DONE

; the cursor moves by (,X, 1,X), staying on the field
MOVE    LDA     CURX
        ADDA    ,X
        CMPA    #8
        BHS     MVNONE          ; (-1 is $FF: higher than 7 too)
        LDB     CURY
        ADDB    1,X
        CMPB    #8
        BHS     MVNONE
        PSHS    D
        LDB     SELECT          ; the old square, then the cursor moves
        STB     OLDSQ
        PULS    D
        STD     CURX
        JSR     CURSQ           ; the new square, with the cursor
        LDB     OLDSQ
        JSR     DRAWSQ          ; the old one, without
        LDA     #20
        LDB     #6
        JMP     TONE
MVNONE  RTS
; CURSQ: B = the cursor's square, drawn
CURSQ   LDB     CURY
        LSLB
        LSLB
        LSLB
        ADDB    CURX
        STB     SELECT
        JMP     DRAWSQ

; ---- F: a flag on the cursor's square, or off ----
FLAG    BSR     CURSQ
        LDX     #STATE
        LDA     B,X
        CMPA    #OPEN
        BEQ     FLNONE
        CMPA    #FLAGGED
        BEQ     FLOFF
        LDA     FLAGS
        CMPA    #MINES
        BHS     FLNONE          ; no more flags than mines
        LDA     #FLAGGED
        STA     B,X
        INC     FLAGS
        LDU     #SND_FLAG
        BRA     FLSHOW
FLOFF   CLR     B,X
        DEC     FLAGS
        LDU     #SND_UNFLAG
FLSHOW  JSR     DRAWSQ
        JSR     COUNTER
        JMP     PLAY
FLNONE  LDA     #200            ; a low buzz: not here
        LDB     #8
        JMP     TONE

; ---- SPACE: open the cursor's square ----
REVEAL  BSR     CURSQ
        LDX     #STATE
        TST     B,X
        BNE     RVNONE          ; open already, or flagged
        TST     PLANTED
        BNE     RVLAID
        JSR     LAY             ; the first square: now the mines
RVLAID  LDB     SELECT
        LDX     #FIELD
        TST     B,X
        BMI     RVBOOM
        JSR     OPENSQ
        JSR     FLOOD
        LDA     #131            ; E5, 40 halves (~38 ms): a tick, not a buzz (NOISE read as one)
        LDB     #40
        JSR     TONE
        LDA     OPENED
        CMPA    #SAFE
        BEQ     RVWIN
RVNONE  RTS
RVWIN   LDA     #1
        STA     WON
        JSR     SHOWALL         ; the cursor goes; the flags stay
        LDU     #T_WIN
        JSR     MESSAGE
        LDB     #6              ; the colours flash
        JSR     FLASH
        LDU     #SND_WIN
        JMP     PLAY
RVBOOM  LDA     #1
        STA     LOST
        STB     BOOMSQ
        JSR     SHOWALL         ; every mine shows
        LDU     #T_LOSE
        JSR     MESSAGE
        LDB     #2
        JSR     FLASH
        LDU     #SND_LOSE       ; a falling arpeggio, then the burst
        JSR     PLAY
        LDA     #1              ; the mine: one short noise burst, not three
        LDB     #4
        JMP     NOISE

; FLASH: B times the other colour set and back
FLASH   PSHS    B
        LDA     #CSS-$08        ; (the other set: CSS is $08, so 0)
        JSR     GMODE
        LDB     #6
FLW1    JSR     VSYNC
        DECB
        BNE     FLW1
        LDA     #CSS
        JSR     GMODE
        LDB     #6
FLW2    JSR     VSYNC
        DECB
        BNE     FLW2
        PULS    B
        DECB
        BNE     FLASH
        RTS

; OPENSQ: square B opens (it is hidden and no mine)
OPENSQ  LDX     #STATE
        LDA     #OPEN
        STA     B,X
        INC     OPENED
        JMP     DRAWSQ

; FLOOD: from SELECT, just opened: while a square with no mine next to it is in the queue, its
; hidden neighbours open, and those with none next to them join the queue. A square joins it once
; (it is open by then), so 64 bytes hold it.
FLOOD   LDB     SELECT
        LDX     #FIELD
        TST     B,X
        BNE     FLDONE          ; mines next to it: nothing more opens
        STB     QUEUE
        CLR     QHEAD
        LDA     #1
        STA     QTAIL
FLNEXT  LDB     QHEAD
        CMPB    QTAIL
        BEQ     FLDONE
        LDX     #QUEUE
        LDB     B,X
        INC     QHEAD
        JSR     NEIGHB          ; its neighbours: NBLIST, NBN of them
        LDY     #NBLIST
FLNB    LDB     ,Y+
        LDX     #STATE
        TST     B,X
        BNE     FLSKIP          ; open, or flagged
        JSR     OPENSQ
        LDX     #FIELD
        TST     B,X
        BNE     FLSKIP          ; (no neighbour of a square with none next to it is a mine)
        LDX     #QUEUE
        LDA     QTAIL
        EXG     A,B
        STA     B,X
        INC     QTAIL
FLSKIP  DEC     NBN
        BNE     FLNB
        BRA     FLNEXT
FLDONE  RTS

; NEIGHB: square B's neighbours (3 to 8 of them) -> NBLIST, NBN
NEIGHB  PSHS    D,X,Y
        TFR     B,A
        ANDA    #7
        STA     NX
        LSRB
        LSRB
        LSRB
        STB     NY
        CLR     NBN
        LDY     #NBLIST
        LDX     #DELTAS
NBLOOP  LDA     NX
        ADDA    ,X
        CMPA    #8
        BHS     NBSKIP
        LDB     NY
        ADDB    1,X
        CMPB    #8
        BHS     NBSKIP
        LSLB
        LSLB
        LSLB
        PSHS    A
        ADDB    ,S+
        STB     ,Y+
        INC     NBN
NBSKIP  LEAX    2,X
        CMPX    #DELTAS+16
        BNE     NBLOOP
        PULS    D,X,Y,PC

; LAY: MINES mines at random, none on SELECT or next to it; then each square's count
LAY     LDB     SELECT          ; keep out: SELECT and its neighbours (marked $40 for now)
        LDX     #FIELD
        LDA     #$40
        STA     B,X
        JSR     NEIGHB
        LDY     #NBLIST
LYKEEP  LDB     ,Y+
        STA     B,X
        DEC     NBN
        BNE     LYKEEP
        CLR     PLANTED
LYMINE  LDB     #64
        JSR     RANDN
        TFR     A,B
        LDA     B,X
        BNE     LYMINE          ; a mine already, or kept out
        LDA     #$80
        STA     B,X
        INC     PLANTED
        LDA     PLANTED
        CMPA    #MINES
        BNE     LYMINE
        CLRB                    ; clear the marks, then count: each mine adds one to its neighbours
LYCLR   LDA     B,X
        ANDA    #$80
        STA     B,X
        INCB
        CMPB    #64
        BNE     LYCLR
        CLRB
LYCOUNT TST     B,X
        BPL     LYNEXT
        JSR     NEIGHB
        LDY     #NBLIST
LYADD   PSHS    B
        LDB     ,Y+
        INC     B,X             ; (a mine's count is never read)
        PULS    B
        DEC     NBN
        BNE     LYADD
LYNEXT  INCB
        CMPB    #64
        BNE     LYCOUNT
        RTS

; ---- the screen ----
; the title page: the name, a flag, a mine and some numbers, how to play; waits for a key
TITLE   CLRA
        JSR     CLS
        LDA     #$AA            ; magenta, 2x wide, 20 rows tall
        STA     TFG
        CLR     TBG
        LDA     #4
        STA     TROWS
        LDA     #1
        STA     TWIDE
        LDU     #T_NAME
        LDA     #20
        JSR     CENTRE
        CLR     SQCUR
        LDB     #7              ; a strip of squares: hidden, a flag, 1, 2, 3, a mine
        STB     SQCOL
        LDA     #56
        STA     SQROW
        LDU     #DEMOSQ
TIDEMO  LDA     ,U+
        BMI     TIDONE
        STA     SQKIND
        LDA     ,U+
        STA     SQNUM
        PSHS    U
        JSR     SQUARE
        PULS    U
        LDA     SQCOL
        ADDA    #3
        STA     SQCOL
        BRA     TIDEMO
TIDONE  LDA     #$FF            ; orange text, 1x wide
        STA     TFG
        CLR     TWIDE
        LDA     #2
        STA     TROWS
        LDU     #T_GOAL1
        LDA     #96
        JSR     CENTRE
        LDU     #T_GOAL2
        LDA     #110
        JSR     CENTRE
        LDA     #$55            ; cyan
        STA     TFG
        LDA     #1
        STA     TROWS
        LDU     #T_KEYS1
        LDA     #132
        JSR     CENTRE
        LDU     #T_KEYS2
        LDA     #142
        JSR     CENTRE
        LDU     #T_KEYS3
        LDA     #152
        JSR     CENTRE
        LDA     #$AA
        STA     TFG
        LDU     #T_PRESS
        LDA     #174
        JSR     CENTRE
        JSR     GETKEY          ; any key plays; BREAK leaves
        CMPA    #K_BREAK
        LBEQ    QUIT
        RTS

; the game screen: the name, the mines counter, the field, the keys
FRAME   CLRA
        JSR     CLS
        LDA     #$AA            ; the name in magenta, 2x wide (its M and W read as M and W) and 10 rows tall
        STA     TFG
        CLR     TBG
        LDA     #1
        STA     TWIDE
        LDA     #2
        STA     TROWS
        LDU     #T_NAME
        LDB     #CELLX-1
        LDA     #2
        JSR     PRINTAT
        CLR     TWIDE
        LDB     #26             ; a mine beside the counter, in place of a label
        LDA     #2
        JSR     AT
        LDU     #SPMINE
        JSR     SPRITE
        LDU     #T_HINT
        JSR     MESSAGE
        LDA     #$55
        STA     TFG
        LDU     #T_FOOT
        LDA     #186
        JSR     CENTRE
        LDA     #24             ; the field's top line
        STA     BOXW
        LDA     #1
        STA     BOXH
        LDA     #$AA
        STA     FILLA
        STA     FILLB
        LDB     #CELLX
        LDA     #CELLY-1
        JSR     AT
        JSR     BOX
        LDA     #1              ; and its left line: a byte of buff with a magenta last pixel
        STA     BOXW
        LDA     #160
        STA     BOXH
        LDA     #$02
        STA     FILLA
        STA     FILLB
        LDB     #CELLX-1
        LDA     #CELLY
        JSR     AT
        JSR     BOX
        JSR     COUNTER
; every square
SHOWALL CLRB
SALOOP  PSHS    B
        JSR     DRAWSQ
        PULS    B
        INCB
        CMPB    #64
        BNE     SALOOP
        RTS

; the mines counter: MINES less the flags, two digits (beside a mine)
COUNTER LDA     #$FF
        STA     TFG
        CLR     TBG
        CLR     TWIDE
        LDA     #2
        STA     TROWS
        LDB     #29*4           ; byte 29 in pixels (the 1x cursor is a pixel)
        LDA     #2
        JSR     ATPIX
        LDA     #MINES
        SUBA    FLAGS
        LDB     #'0-1
CNTENS  INCB
        SUBA    #10
        BHS     CNTENS
        ADDA    #10+'0
        PSHS    A
        TFR     B,A
        JSR     PUTCH
        PULS    A
        JMP     PUTCH

; MESSAGE: the string at U on the line under the name, in orange (cleared first)
MESSAGE PSHS    U
        LDA     #32
        STA     BOXW
        LDA     #7
        STA     BOXH
        CLR     FILLA
        CLR     FILLB
        CLRB
        LDA     #15
        JSR     AT
        JSR     BOX
        LDA     #$FF
        STA     TFG
        CLR     TBG
        CLR     TWIDE
        LDA     #1
        STA     TROWS
        PULS    U
        LDA     #16
        JMP     CENTRE

; DRAWSQ: square B as the game has it
DRAWSQ  PSHS    D,X,Y,U
        TFR     B,A             ; where: column 4 + 3x, row 24 + 20y
        ANDA    #7
        LDB     #3
        MUL
        ADDB    #CELLX
        STB     SQCOL
        LDB     1,S
        LSRB
        LSRB
        LSRB
        LDA     #20
        MUL
        ADDB    #CELLY
        STB     SQROW
        LDB     1,S
        LDX     #FIELD
        LDA     B,X
        ANDA    #$0F
        STA     SQNUM
        LDA     B,X             ; a mine, shown when the game is lost
        BPL     DSNOMINE
        TST     LOST
        BEQ     DSNOMINE
        LDA     #K_BOOM
        CMPB    BOOMSQ
        BEQ     DSKIND
        LDX     #STATE
        LDA     B,X
        CMPA    #FLAGGED
        BEQ     DSSTATE         ; a mine found: its flag stays
        LDA     #K_MINE
        BRA     DSKIND
DSNOMINE
        LDX     #STATE
        LDA     B,X
DSSTATE CMPA    #FLAGGED
        BNE     DSNOFL
        LDA     #K_FLAG
        BRA     DSKIND
DSNOFL  CMPA    #OPEN
        BNE     DSHIDE
        LDA     #K_OPEN
        BRA     DSKIND
DSHIDE  LDA     #K_HIDDEN
DSKIND  STA     SQKIND
        CLR     SQCUR           ; the cursor: while the game goes on
        TST     LOST
        BNE     DSDRAW
        TST     WON
        BNE     DSDRAW
        CMPB    SELECT
        BNE     DSDRAW
        INC     SQCUR
DSDRAW  JSR     SQUARE
        PULS    D,X,Y,U,PC

; SQUARE: a square of kind SQKIND (count SQNUM for an open one) at SQCOL, SQROW, framed when SQCUR
K_HIDDEN EQU    0
K_FLAG  EQU     1
K_OPEN  EQU     2
K_MINE  EQU     3
K_BOOM  EQU     4
SQUARE  LDB     SQKIND          ; the background: 19 rows of 11 pixels and the magenta line right
        LDX     #KINDBG
        LDA     B,X
        STA     FILLA
        STA     FILLB
        LDA     #2
        STA     BOXW
        LDA     #19
        STA     BOXH
        LDB     SQCOL
        LDA     SQROW
        JSR     AT
        STX     SQADDR
        JSR     BOX
        LDA     FILLA           ; the third byte: three pixels and the line
        ANDA    #$FC
        ORA     #$02
        STA     FILLA
        STA     FILLB
        LDA     #1
        STA     BOXW
        LEAX    2,X
        JSR     BOX
        LDX     SQADDR          ; the line under it
        LEAX    19*32,X
        LDD     #$AAAA
        STD     ,X
        STA     2,X
        LDB     SQKIND
        CMPB    #K_HIDDEN
        BNE     SQNOTH
        LDX     SQADDR          ; hidden: raised, a light top row and a dark bottom row
        LDD     #$0000
        STD     ,X
        LDA     #$02
        STA     2,X
        LEAX    18*32,X
        LDD     #$AAAA
        STD     ,X
        STA     2,X
        BRA     SQFRAME
SQNOTH  CMPB    #K_OPEN
        BNE     SQSPRITE
        LDB     SQNUM           ; open: its count, unless 0
        BEQ     SQFRAME
        LDX     #NUMCOL
        LDA     B,X
        STA     TFG
        CLR     TBG
        CLR     TWIDE
        LDA     #2
        STA     TROWS
        LDX     SQADDR
        LEAX    1+5*32,X
        STX     PCADDR
        CLR     PCOL            ; the pixel within that byte
        TFR     B,A
        ADDA    #'0
        JSR     PUTCH
        BRA     SQFRAME
SQSPRITE
        LDU     #SPFLAG         ; a flag, a mine or the mine that went off: its sprite, 10 rows
        CMPB    #K_FLAG
        BEQ     SQSPR
        LDU     #SPMINE
SQSPR   LDX     SQADDR
        LEAX    5*32,X
        BSR     SPRITE
        BRA     SQFRAME
; SPRITE: the sprite at U (10 rows of three mask and colour pairs) over the screen at X
SPRITE  LDB     #10
SQSROW  LDA     ,X
        ANDA    ,U+
        ORA     ,U+
        STA     ,X
        LDA     1,X
        ANDA    ,U+
        ORA     ,U+
        STA     1,X
        LDA     2,X
        ANDA    ,U+
        ORA     ,U+
        STA     2,X
        LEAX    32,X
        DECB
        BNE     SQSROW
        RTS
SQFRAME TST     SQCUR           ; the cursor: an orange frame inside the square
        BEQ     SQDONE
        LDX     SQADDR
        LDD     #$FFFF
        STD     ,X
        LDA     #$FE
        STA     2,X
        LEAX    18*32,X
        LDD     #$FFFF
        STD     ,X
        LDA     #$FE
        STA     2,X
        LDX     SQADDR
        LDB     #19
SQSIDES LDA     ,X
        ORA     #$C0
        STA     ,X
        LDA     2,X
        ORA     #$0C
        STA     2,X
        LEAX    32,X
        DECB
        BNE     SQSIDES
SQDONE  RTS

; ---- data ----
; keys that move: key, dx, dy (0 ends)
KEYMOVE FCB     K_UP,0,-1,K_DOWN,0,1,K_LEFT,-1,0,K_RIGHT,1,0,0
; the stick's directions as MOVE's (dx, dy): index 1-4 is up, down, left, right; dy non-zero means the y axis
JOYDIRS FCB     0,0,0,-1,0,1,-1,0,1,0
; the keys fire's matrix rows 0 and 1 make phantom, and that a POLCAT with ROMs can hand back, which the
; game ignores while fire is down. Both machines' rows, because which one the ROM scans cannot be known:
; a Dragon's row 0 is '0'-'7' and row 1 '8'-'/', a CoCo's row 0 is @ and A-G and row 1 H-O. R, BREAK, the
; arrows, SPACE, ENTER and the rest are never in those rows.
PHANTOM FCB     '0,'1,'2,'3,'4,'5,'6,'7,'8,'9,':,';,44,'-,'.,'/,'@,'A,'B,'C,'D,'E,'F,'G,'H,'I,'J,'K,'L,'M,'N,'O,0
; (44 is the comma: a character literal for it cannot be written in a comma-separated FCB list)
; the eight neighbours: dx, dy
DELTAS  FCB     -1,-1,0,-1,1,-1,-1,0,1,0,-1,1,0,1,1,1
; each kind's background fill: hidden cyan, flag on cyan, open buff, mine buff, the mine that went off orange
KINDBG  FCB     $55,$55,$00,$00,$FF
; the counts' colours, 1-8: cyan, magenta, orange, then again
NUMCOL  FCB     0,$55,$AA,$FF,$AA,$FF,$55,$AA,$FF
; the title's strip of squares: kind, count (a negative kind ends)
DEMOSQ  FCB     K_HIDDEN,0,K_FLAG,0,K_OPEN,1,K_OPEN,2,K_OPEN,3,K_MINE,0,$FF
; sprites: 10 rows of three (mask, colour) pairs; the mask keeps the background, the colour is ORed
SPFLAG  FCB     $FF,$00,$0F,$F0,$FF,$00  ; ....33.....
        FCB     $FC,$03,$0F,$F0,$FF,$00  ; ...333.....
        FCB     $F0,$0F,$0F,$F0,$FF,$00  ; ..3333.....
        FCB     $C0,$3F,$0F,$F0,$FF,$00  ; .33333.....
        FCB     $F0,$0F,$0F,$F0,$FF,$00  ; ..3333.....
        FCB     $FC,$03,$0F,$F0,$FF,$00  ; ...333.....
        FCB     $FF,$00,$CF,$20,$FF,$00  ; .....2.....
        FCB     $FF,$00,$CF,$20,$FF,$00  ; .....2.....
        FCB     $FC,$02,$00,$AA,$FF,$00  ; ...22222...
        FCB     $F0,$0A,$00,$AA,$3F,$80  ; ..2222222..
SPMINE  FCB     $FF,$00,$CF,$20,$FF,$00  ; .....2.....
        FCB     $F3,$08,$03,$A8,$3F,$80  ; ..2.222.2..
        FCB     $FC,$02,$00,$AA,$FF,$00  ; ...22222...
        FCB     $F0,$0A,$00,$1A,$3F,$80  ; ..2201222..
        FCB     $00,$AA,$00,$5A,$0F,$A0  ; 2222112222.
        FCB     $F0,$0A,$00,$AA,$3F,$80  ; ..2222222..
        FCB     $FC,$02,$00,$AA,$FF,$00  ; ...22222...
        FCB     $F3,$08,$03,$A8,$3F,$80  ; ..2.222.2..
        FCB     $FF,$00,$CF,$20,$FF,$00  ; .....2.....
        FCB     $FF,$00,$FF,$00,$FF,$00  ; ...........
; sounds: delay, half periods. The flag notes are a rising fifth (C5 then G5), the unflag the same two falling;
; the win is a rising C major pentatonic arpeggio and the loss a falling one. The open tick and the mine's burst
; are made in the code above (a TONE and a short NOISE).
SND_FLAG
        FCB     167,24,110,24,0
SND_UNFLAG
        FCB     110,24,167,24,0
SND_WIN FCB     167,40,131,40,110,40,97,40,81,40,0
SND_LOSE
        FCB     81,40,110,40,131,40,167,40,0
; text
T_NAME  FCN     "MINESWEEPER"
T_GOAL1 FCN     "TEN MINES ARE HIDDEN"
T_GOAL2 FCN     "OPEN EVERY OTHER SQUARE"
T_KEYS1 FCN     "ARROWS MOVE  SPACE OPENS"
T_KEYS2 FCN     "F FLAGS A MINE  R START"
T_KEYS3 FCN     "A NUMBER: MINES NEXT TO IT"
T_PRESS FCN     "PRESS A KEY TO PLAY"
T_HINT  FCN     "SPACE OPENS  F FLAGS"
T_FOOT  FCN     "ARROWS  R=NEW  BREAK=QUIT"
T_WIN   FCN     "ALL CLEAR! R PLAYS AGAIN"
T_LOSE  FCN     "BOOM! R PLAYS AGAIN"

        INCLUDE "games.inc"

; ---- the game's state ----
FIELD   RMB     64
STATE   RMB     64
QUEUE   RMB     64
CURX    RMB     1               ; the cursor (CURX, CURY: one word)
CURY    RMB     1
SELECT  RMB     1
PLANTED RMB     1
LOST    RMB     1
WON     RMB     1
OPENED  RMB     1
FLAGS   RMB     1
BOOMSQ  RMB     1
QHEAD   RMB     1
QTAIL   RMB     1
NX      RMB     1
NY      RMB     1
NBN     RMB     1
NBLIST  RMB     8
SQCOL   RMB     1
SQROW   RMB     1
SQKIND  RMB     1
SQNUM   RMB     1
SQCUR   RMB     1
SQADDR  RMB     2
OLDSQ   RMB     1
IN      RMB     1               ; the game loop's action this field: a key, or a fire action, or 0
KEYIN   RMB     1
FIREIN  RMB     1
FIREDN  RMB     1               ; fire has been down since ...
FIREREL RMB     1               ; ... and came UP on this field (the over screen restarts on that: GLOVER)
JOYPRE  RMB     1               ; the direction the stick had last field

        END     ENTRY
