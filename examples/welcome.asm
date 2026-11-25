; ---------------------------------------------------------------
; WELCOME - the first program a visitor sees, with no ROMs.
; 6809 assembly, written for CLOADM. Dragon 32/64/200, Tano, Color
; Computer 1/2/2B and clones, and the Color Computer 3 in its CoCo 2-
; compatible 32x16 text mode.
;
; A row of semigraphics blocks builds the eight VDG colours, then
; "CLOADM" in large block characters and the menu. Keys 1-4 are
; posted in EVENT, a mailbox at a fixed address that the Session reads
; and clears after every frame (js/session.js WELCOME); the program
; keeps waiting for keys. Key 5 (PLAY A GAME) opens the games menu, where 1 and 2 post
; 6 (2048) and 7 (Minesweeper) and 0 or BREAK go back. Before it runs,
; the Session may set GREET (0 the first visit, 1 "WELCOME BACK",
; 2 "BYE FOR NOW. PICK ANOTHER?") and CARRY, the text of a sixth option
; ("CARRY ON WITH LIZA"): with CARRY set, the menu has option 6 and key 6
; posts 5. Once the page has unlocked audio it sets SOUNDOK and a short
; original tune plays on the 6-bit DAC.
; Keys come from the ROM's POLCAT vector, so it runs on the stub or
; with BASIC ROMs.
; Build: node tools/build-examples.js  (examples/welcome.bin)
; ---------------------------------------------------------------

POLCAT  EQU     $A000           ; ROM vector: read key -> A, Z=1 if none
SCREEN  EQU     $0400           ; 32x16 VDG text screen
PIA0CRA EQU     $FF01
PIA0DB  EQU     $FF02
PIA0CRB EQU     $FF03
PIA1DA  EQU     $FF20           ; DAC in bits 7-2
PIA1CRA EQU     $FF21
PIA1CRB EQU     $FF23

        ORG     $6000
; ---- fixed entry points: js/session.js knows these addresses ----
WELCOME JMP     START           ; $6000
EVENT   FCB     0               ; $6003 the choice, 1-7 (cleared by the Session)
SOUNDOK FCB     0               ; $6004 set to 1 by the page once audio is unlocked
PLAYED  FCB     0               ; $6005 the tune has played
CARRYN  EQU     26              ; the longest option 6 text ("CARRY ON WITH MINESWEEPER" fits)
GREET   FCB     0               ; $6006 set by the Session: 0 first visit, 1 back, 2 bye
CARRY   FCB     0               ; $6007 set by the Session: option 6's text (0 ends; none if 0)
        RMB     CARRYN
ROMSW   FCB     0               ; set by the Session: 1 when the machine HAS ROMs but runs without them,
                                ;   so option 3 says to switch them on rather than to add them

START   ORCC    #$50            ; no interrupts: frame timing from the FS flag
        LDS     #$6000          ; stack just below the program
        CLR     PLAYED
        CLR     EVENT
; sound: analogue mux on the DAC (PIA0 CA2 = CB2 = 0), DAC bits as
; outputs, sound enabled (PIA1 CB2 = 1); FS flag on PIA0 CB1, no IRQ
        LDA     #$34
        STA     PIA0CRA
        STA     PIA0CRB
        LDA     #$30            ; PIA1 port A: select the DDR
        STA     PIA1CRA
        LDA     #$FE            ; bits 7-1 outputs, cassette input on bit 0
        STA     PIA1DA
        LDA     #$34            ; back to the data register, motor off
        STA     PIA1CRA
        LDA     #$3C            ; CB2 high: sound on
        STA     PIA1CRB
        LDA     #$80            ; DAC at mid level
        STA     PIA1DA

; ---- clear the screen ----
        LDX     #SCREEN
        LDD     #$6060          ; normal-video spaces
CLS     STD     ,X++
        CMPX    #SCREEN+512
        BNE     CLS

; ---- the stripe builds, one block a frame, four blocks a colour ----
        LDX     #SCREEN
        CLRB
STRIPE  JSR     VSYNC
        JSR     BLOCK
        STA     ,X+
        INCB
        CMPB    #32
        BNE     STRIPE

; ---- black band with CLOADM in large blocks (rows 1-5) ----
        LDX     #SCREEN+32
        LDA     #$80            ; black SG4 cell
BAND    STA     ,X+
        CMPX    #SCREEN+6*32
        BNE     BAND
        LDU     #BIG
        LDX     #SCREEN+2*32+1
BIGROW  LDB     #29
BIGCEL  LDA     ,U+
        STA     ,X+
        DECB
        BNE     BIGCEL
        LEAX    3,X             ; next screen row
        CMPX    #SCREEN+5*32
        BLO     BIGROW

; ---- the menu (rows 6-14) ----
        JSR     MAINMENU
; ---- bottom stripe, drawn at once ----
        LDX     #SCREEN+15*32
        CLRB
STRIP2  JSR     BLOCK
        STA     ,X+
        INCB
        CMPB    #32
        BNE     STRIP2

; ---- wait for keys; play the tune once sound is unlocked ----
; the main menu: 1-4 post their events, 5 opens the games menu, 6 (with option 6) posts 5;
; the games menu: 1 and 2 post 6 and 7, 0 or BREAK go back
KEYLP   TST     SOUNDOK
        BEQ     NOSND
        TST     PLAYED
        BNE     NOSND
        INC     PLAYED
        JSR     TUNE
NOSND   TST     EVENT           ; the last key not taken yet
        BNE     KEYLP
        JSR     [POLCAT]
        BEQ     KEYLP
        TST     INGAMES
        BNE     GAMEKEY
        CMPA    #'5
        BEQ     TOGAMES
        BHI     KEYSIX
        CMPA    #'1
        BLO     KEYLP
        SUBA    #'0             ; 1-4
        BRA     POST
KEYSIX  CMPA    #'6             ; 6 only with option 6
        BNE     KEYLP
        TST     CARRY
        BEQ     KEYLP
        LDA     #5
POST    STA     EVENT
        BRA     KEYLP
TOGAMES JSR     GAMESMENU
        BRA     KEYLP
GAMEKEY CMPA    #'0
        BEQ     TOMAIN
        CMPA    #3              ; BREAK
        BEQ     TOMAIN
        CMPA    #'1
        BLO     KEYLP
        CMPA    #'2
        BHI     KEYLP
        ADDA    #6-'1           ; 6 2048, 7 Minesweeper
        BRA     POST
TOMAIN  JSR     MAINMENU
        BRA     KEYLP

; MAINMENU: the greeting (row 6), options 1-5 (rows 8-12), option 6 if the Session set one
; (row 12, the options above it moved up a row), and the prompt (row 14)
MAINMENU
        CLR     INGAMES
        JSR     CLRMENU
; option 3: "ADD YOUR ROMS FOR BASIC", or "USE YOUR ROMS FOR BASIC" when the ROMs are already in the sockets and the
; machine runs without them (ROMSW). The table's entry is pointed at the right string before it is drawn, so the
; rest of the table, the clearing above and the key handling are the same either way.
        LDX     #MENU9+10       ; entry 2 (option 3), its string word
        LDD     #T_3
        TST     ROMSW
        BEQ     MMSET
        LDD     #T_3S
MMSET   STD     ,X
        LDU     #MENU9
        JSR     TEXTS9
; the greeting, chosen by GREET (its table's rows are the 6803 build's: one row higher here)
        LDB     GREET
        CMPB    #2
        BLS     GRTOK
        CLRB
GRTOK   LSLB
        LSLB                    ; 4 bytes an entry
        LDU     #GREETS
        LEAU    B,U
        LDX     ,U++
        LEAX    -32,X
        LDU     ,U
        JSR     PRAT
; With option 6 the options move up a row (rows 8-12 to 7-11), so a blank row still separates the menu from
; PRESS 1 TO 6 and the colour bar (as the 6803 build does); option 6 goes on row 12.
        TST     CARRY
        BEQ     MMDONE
        LDX     #SCREEN+7*32
MOVEUP  LDD     32,X
        STD     ,X++
        CMPX    #SCREEN+12*32
        BNE     MOVEUP
        LDD     #$6060          ; row 12, cleared for option 6
CLR12   STD     ,X++
        CMPX    #SCREEN+13*32
        BNE     CLR12
        LDU     #T_6
        LDX     #SCREEN+12*32+4
        JSR     PRAT
        LDU     #CARRY
        JSR     PRAT
        LDA     #'6
        STA     SCREEN+14*32+21 ; PRESS 1 TO 5 -> 6
MMDONE  RTS

; GAMESMENU: the games, and the way back
GAMESMENU
        LDA     #1
        STA     INGAMES
        JSR     CLRMENU
        LDU     #GAMES9
; TEXTS9: the strings in the table at U (screen address, string; 0 ends)
TEXTS9  LDX     ,U++
        BEQ     T9DONE
        LDY     ,U++
        PSHS    U
        TFR     Y,U
        JSR     PRAT
        PULS    U
        BRA     TEXTS9
T9DONE  RTS

; CLRMENU: rows 6-14 to spaces
CLRMENU LDX     #SCREEN+6*32
        LDD     #$6060
CLRM    STD     ,X++
        CMPX    #SCREEN+15*32
        BNE     CLRM
        RTS

; B = cell 0-31 -> A = full SG4 block of colour B/4
BLOCK   TFR     B,A
        ANDA    #$1C            ; (B/4)*4
        LSLA
        LSLA                    ; colour << 4
        ORA     #$8F
        RTS

; wait for the next field sync
VSYNC   LDA     PIA0DB          ; clear the FS flag
VSWAIT  LDA     PIA0CRB
        BPL     VSWAIT
        RTS

; print the string at U (0 ends; bit 7 set = inverse video) at X
PRAT    LDA     ,U+
        BEQ     PRDONE
        BMI     PRINV
        CMPA    #$40
        BHS     PRPUT
        ADDA    #$40            ; space, digits, punctuation: normal video
PRPUT   STA     ,X+
        BRA     PRAT
PRINV   ANDA    #$3F            ; inverse video
        BRA     PRPUT
PRDONE  RTS

; ---- the tune: square waves on the DAC ----
; each note: delay D, then N half periods of 5*D+19 cycles each
TUNE    LDU     #NOTES
TNOTE   LDB     ,U
        BEQ     TDONE
        LDY     1,U
        LDA     #$FC            ; DAC high
THALF   STA     PIA1DA          ; 5
        LDB     ,U              ; 4
TDLY    DECB                    ; 2
        BNE     TDLY            ; 3
        EORA    #$F8            ; 2   $FC <-> $04
        LEAY    -1,Y            ; 5
        BNE     THALF           ; 3
        LEAU    3,U
        LDA     #$80            ; a short rest between notes
        STA     PIA1DA
        LDB     #200
TREST   DECB
        BNE     TREST
        BRA     TNOTE
TDONE   RTS

        INCLUDE "welcome-data.inc"

; ---- the 6809 build's menus (the 6803 build has no games: they are 6809 programs) ----
MENU9   FDB     SCREEN+8*32+4,T_1
        FDB     SCREEN+9*32+4,T_2
        FDB     SCREEN+10*32+4,T_3
        FDB     SCREEN+11*32+4,T_4
        FDB     SCREEN+12*32+4,T_5G
        FDB     SCREEN+14*32+10,T_PRESS5
        FDB     0
GAMES9  FDB     SCREEN+6*32+2,T_GAMES
        FDB     SCREEN+8*32+4,T_G1
        FDB     SCREEN+9*32+4,T_G2
        FDB     SCREEN+11*32+4,T_G0
        FDB     SCREEN+13*32+5,T_GBRK
        FDB     SCREEN+14*32+8,T_GPRESS
        FDB     0
T_5G    FCB     '5+$80
        FCN     " PLAY A GAME"
T_6     FCB     '6+$80
        FCN     " "
T_PRESS5 FCN    "PRESS 1 TO 5"
T_GAMES FCN     "NEW GAMES FOR AN OLD MACHINE"
T_G1    FCB     '1+$80
        FCN     " 2048"
T_G2    FCB     '2+$80
        FCN     " MINESWEEPER"
T_G0    FCB     '0+$80
        FCN     " BACK TO THE MENU"
T_GBRK  FCN     "BREAK LEAVES A GAME"
T_GPRESS FCN    "PRESS 1, 2 OR 0"
INGAMES FCB     0               ; the games menu is showing

        END     WELCOME
