; ---------------------------------------------------------------
; WELCOME6803 - the welcome program for the MC-10 and the Matra
; Alice (MC6803): the same screen as the 6809 build (examples/
; welcome.asm) on a machine with no ROMs.
;
; The 6809 build draws a semigraphics colour stripe, "CLOADM" in
; large block characters and the menu, posts keys 1-4 in a mailbox
; the Session reads each frame, and plays a short tune on the DAC.
; This build does the same on the MC-10's hardware: the screen is the
; 32x16 text screen at $4000, keys come from Micro Color BASIC's
; POLCAT, and the tune is a square wave on the 1-bit sound output
; (bit 7 of the video/sound latch at $BFFF) rather than DAC levels.
;
; The menu strings, the CLOADM pattern and the tune's note table come
; from examples/welcome-data.inc, the file the 6809 build reads too,
; so the two cannot drift.
;
; What the 6803 forces (not choices), as in examples/liza6803.asm: one
; index register, so every extra pointer lives in RAM and is reached
; with LDX ptr / STX ptr; ABX and INX replace LEAX; PSHS/PULS take one
; register at a time; JSR has no indirect form, so POLCAT is called
; directly.
;
; Two builds from this one source, one per machine (Tandy MC-10, Matra Alice). The shipping .bin
; has no HALT: the program waits for keys forever, by design. An assemble-time HALTCODE symbol
; assembles a HALT loop once the screen is drawn, which the MAME comparison needs as a fixed
; stopping point; only the comparison build passes it (tools/mame-diff/mc10/spec.js).
;
; Build: node tools/build-examples.js  (examples/welcome6803-mc10.bin, examples/welcome6803-alice.bin)
; ---------------------------------------------------------------

POLCAT  EQU     $F883           ; ROM entry: read key -> A, Z=1 if none
SCREEN  EQU     $4000           ; text screen (32x16, VDG codes)
LATCH   EQU     $BFFF           ; video/sound latch: bit 7 is the sound output
STACK   EQU     $5000-1         ; the 6803 pushes down, so the first JSR writes $4FFF

; RAM pointers: the 6803 has only X, so each additional pointer is a word in RAM. They do NOT live in
; the 6803's on-chip RAM at $80-$FF: BASIC's own routines use that while POLCAT and CHROUT run
; (examples/liza6803.asm line 28), and the first version of this program put them at $60-$66, where they
; were silently zeroed — the row counter read 0 at every pass of the CLOADM loop. They live at VARS
; (see the end of this file) instead, in RAM that neither BASIC nor the program's own image occupies.
PTRA     EQU     VARS+0          ; the CLOADM pattern cursor
PTRB     EQU     VARS+2          ; the screen position
PTRC     EQU     VARS+4          ; the string cursor
ROWS     EQU     VARS+6          ; the CLOADM row counter (and the tune's delay)
; The tune's own state. $BFFF reads the keyboard rows, not the latch, so the sound bit cannot be toggled by
; reading the latch back: SND holds the latch value last written (bit 7 the sound, video bits 0: the text
; screen, as the stub sets it), and COUNT the note's half periods left.
SND      EQU     VARS+7
COUNT    EQU     VARS+8

        ORG     $5000
; ---- fixed entry points: js/session.js knows these addresses ----
WELCOME JMP     START           ; $5000
EVENT   FCB     0               ; $5003 key 1-4 pressed (cleared by the Session)
SOUNDOK FCB     0               ; $5004 set to 1 by the page once audio is unlocked
PLAYED  FCB     0               ; $5005 the tune has played
CARRYN  EQU     24              ; the longest option 5 text
GREET   FCB     0               ; $5006 set by the Session: 0 first visit, 1 back, 2 bye
CARRY   FCB     0               ; $5007 set by the Session: option 5's text (0 ends; none if 0)
        RMB     CARRYN
ROMSW   FCB     0               ; set by the Session: 1 when the machine HAS ROMs but runs without them,
                                ;   so option 3 says to switch them on rather than to add them

START   LDS     #STACK          ; stack just below the program
        CLR     PLAYED
        CLR     EVENT

; ---- clear the screen ----
        LDX     #SCREEN
        LDA     #$60            ; normal-video space
CLS     STA     ,X
        INX
        CPX     #SCREEN+512
        BNE     CLS

; ---- the top stripe: 32 cells, four blocks per colour ----
        LDX     #SCREEN
        CLRB
STRIPE  JSR     BLOCK           ; A = the SG4 block for colour B/4
        STA     ,X
        INX
        INCB
        CMPB    #32
        BNE     STRIPE

; ---- black band across rows 1-5, then CLOADM in large blocks ----
        LDX     #SCREEN+32
        LDA     #$80            ; black SG4 cell
BAND    STA     ,X
        INX
        CPX     #SCREEN+6*32
        BNE     BAND

        LDX     #BIG
        STX     PTRA            ; the pattern
        LDX     #SCREEN+2*32+1
        STX     PTRB            ; where the first block row starts
        LDA     #3
        STA     ROWS
BIGROW  LDB     #29             ; 29 cells across
BIGCEL  LDX     PTRA
        LDA     ,X
        INX
        STX     PTRA
        LDX     PTRB
        STA     ,X
        INX
        STX     PTRB
        DECB
        BNE     BIGCEL
        LDX     PTRB            ; next row: the pattern stops 3 cells short
        INX
        INX
        INX
        STX     PTRB
        DEC     ROWS
        BNE     BIGROW

; ---- the text lines: (screen address, string) pairs, a 0 address ends the table ----
; option 3 reads "ADD YOUR ROMS FOR BASIC", or "USE YOUR ROMS FOR BASIC" when the ROMs are in the sockets and the
; machine runs without them (ROMSW): the table's entry is pointed at the right string before it is drawn.
        LDX     #TEXTS+10       ; entry 2 (option 3), its string word (4-byte entries: +8, then +2)
        LDD     #T_3
        TST     ROMSW
        BEQ     T3SET
        LDD     #T_3S
T3SET   STD     ,X
        LDX     #TEXTS
        STX     PTRA
TEXT    LDX     PTRA
        LDD     ,X              ; the screen address (big-endian)
        BEQ     ENDTXT
        STD     PTRB
        LDX     PTRA            ; the string address follows it
        INX
        INX
        LDD     ,X
        STD     PTRC
        LDX     PTRA            ; advance the table cursor past both words
        INX
        INX
        INX
        INX
        STX     PTRA
        JSR     PRINTAT         ; draw the string at PTRB, cursor PTRC
        BRA     TEXT
ENDTXT
; ---- the greeting under the title, chosen by GREET (as the 6809 build) ----
        LDB     GREET
        CMPB    #2
        BLS     GRTOK
        CLRB
GRTOK   LSLB
        LSLB                    ; 4 bytes an entry
        LDX     #GREETS
        ABX
        LDD     ,X              ; the screen address
        STD     PTRB
        LDD     2,X             ; the string
        STD     PTRC
        JSR     PRINTAT
; ---- option 5, if the Session set one: its line and the prompt's last digit ----
; With option 5 the greeting and the menu move up a row (rows 7-12 to 6-11), so a blank row still separates the
; menu from PRESS 1 TO 5 (as the 6809 build); option 5 goes on row 12.
        TST     CARRY
        BEQ     NOFIVE
        LDX     #SCREEN+6*32
MOVEUP  LDD     32,X
        STD     0,X
        INX
        INX
        CPX     #SCREEN+12*32
        BNE     MOVEUP
        LDD     #$6060          ; row 12, cleared for option 5
CLR12   STD     0,X
        INX
        INX
        CPX     #SCREEN+13*32
        BNE     CLR12
        LDX     #SCREEN+12*32+4
        STX     PTRB
        LDX     #T_5
        STX     PTRC
        JSR     PRINTAT         ; the digit and a space; PTRB is where the text goes
        LDX     #CARRY
        STX     PTRC
        JSR     PRINTAT
        LDA     #'5
        STA     SCREEN+14*32+21 ; PRESS 1 TO 4 -> 5
NOFIVE

; ---- the bottom stripe, drawn at once ----
        LDX     #SCREEN+15*32
        CLRB
STRIP2  JSR     BLOCK
        STA     ,X
        INX
        INCB
        CMPB    #32
        BNE     STRIP2

; ---- the comparison build's stop, in a FIXED 2-byte slot so the two builds differ only here ----
; The shipping build has two NOPs (no effect, the key loop follows); the comparison build has BRA to its
; HALT loop. Both are two bytes, so nothing after this point moves and everything else in the image is
; byte-identical: tests/welcome6803.test.js checks exactly that, and MAME compares the same bytes the page
; ships (tools/mame-diff/mc10/gen-welcome.js).
        IF      HALTCODE
        BRA     HALT
        ELSE
        NOP
        NOP
        ENDIF

; ---- wait for keys; play the tune once the page has unlocked audio ----
KEYLP   TST     SOUNDOK
        BEQ     NOSND
        TST     PLAYED
        BNE     NOSND
        INC     PLAYED
        JSR     TUNE
NOSND   TST     EVENT           ; the Session has not taken the last key yet
        BNE     KEYLP
        JSR     POLCAT
        BEQ     KEYLP
        CMPA    #'1
        BLO     KEYLP
        CMPA    #'4
        BLS     KEYOK
        CMPA    #'5             ; 5 only with option 5
        BNE     KEYLP
        TST     CARRY
        BEQ     KEYLP
KEYOK   SUBA    #'0
        STA     EVENT
        BRA     KEYLP

; ---- the HALT loop: a FIXED 2-byte slot, so the shipping and comparison images differ only in the two
; ---- slots above and this one, never by a shifted address
        IF      HALTCODE
HALT    BRA     HALT
        ELSE
HALT    NOP
        NOP
        ENDIF

; ---- B = cell 0-31 -> A = the full SG4 block of colour B/4 ----
BLOCK   TBA
        ANDA    #$1C            ; (B/4)*4
        LSLA
        LSLA                    ; the colour in bits 6-4
        ORA     #$8F
        RTS

; ---- the string at PTRC, drawn from the screen address in PTRB; bit 7 = inverse video ----
; The sign of the character must be tested BEFORE INX/STX PTRC: on the 6803 STX sets N and Z from the
; value stored, so a test after it reads the pointer's sign, not the character's (the 6809 build gets
; away with testing after LDA ,U+ because the autoincrement does not touch the flags). The frame test
; catches the difference: with the test moved, the menu digits came out as SG4 blocks instead of
; inverse-video text.
PRINTAT LDX     PTRC
        LDA     ,X
        BEQ     PRDONE
        BMI     PRINV
        INX
        STX     PTRC
        CMPA    #$40
        BHS     PRPUT
        ADDA    #$40            ; space, digits and punctuation: normal video
PRPUT   LDX     PTRB
        STA     ,X
        INX
        STX     PTRB
        BRA     PRINTAT
PRINV   ANDA    #$3F            ; inverse video
        INX
        STX     PTRC
        BRA     PRPUT
PRDONE  RTS

; ---- the tune: a square wave on the 1-bit sound output ----
; The note table gives a delay and a half-period count, as the 6809 build's DAC tune does; here the
; output toggles bit 7 of the latch instead of switching DAC levels, so the pitch has the same shape
; with one bit of level. The 6803 has no 16-bit decrement-and-test, so the half-period count is two
; bytes counted down here.
TUNE    CLR     SND
        LDX     #NOTES
        STX     PTRA
TNOTE   LDX     PTRA
        LDA     ,X              ; the delay
        BEQ     TDONE
        STA     ROWS
        LDX     PTRA            ; the half-period count follows the delay
        INX
        LDD     ,X
        STD     COUNT
        LDX     PTRA            ; advance past the whole note
        INX
        INX
        INX
        STX     PTRA
THALF   LDA     SND
        EORA    #$80            ; toggle the sound output
        STA     SND
        STA     LATCH           ; the text screen stays (video bits 0)
        LDB     ROWS
TDLY    DECB
        BNE     TDLY
        LDD     COUNT           ; one half period done: count down; STD sets Z on the 16-bit result
        SUBD    #1
        STD     COUNT
        BNE     THALF
        BRA     TNOTE
TDONE   CLR     SND             ; sound off, the text screen as before
        CLR     LATCH
        RTS

        INCLUDE "welcome-data.inc"

; the program's variables, at a fixed RAM address rather than at the end of the image: the comparison build
; is installed in the MC-10's ROM slot at $E000 (tools/mame-diff/mc10/spec.js), where bytes are read-only, so
; a variable that travelled with the image would be written into ROM and the program would misbehave there.
; $4300 is RAM on the 20K option this program needs (RAM runs $4000-$8FFF with the screen at $4000-$41FF),
; and it is clear of the 6803's on-chip RAM at $80-$FF that BASIC's routines own while POLCAT runs.
VARS    EQU     $4300

        END     WELCOME
