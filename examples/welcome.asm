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
; keeps waiting for keys. Before it runs, the Session may set GREET
; (0 the first visit, 1 "WELCOME BACK", 2 "BYE FOR NOW. PICK ANOTHER?")
; and CARRY, the text of a fifth option ("CARRY ON WITH LIZA"): with
; CARRY set, the menu has option 5 and key 5 is posted too. Once the page has unlocked audio it sets
; SOUNDOK and a short original tune plays on the 6-bit DAC.
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
EVENT   FCB     0               ; $6003 key 1-4 pressed (cleared by the Session)
SOUNDOK FCB     0               ; $6004 set to 1 by the page once audio is unlocked
PLAYED  FCB     0               ; $6005 the tune has played
CARRYN  EQU     24              ; the longest option 5 text
GREET   FCB     0               ; $6006 set by the Session: 0 first visit, 1 back, 2 bye
CARRY   FCB     0               ; $6007 set by the Session: option 5's text (0 ends; none if 0)
        RMB     CARRYN

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

; ---- text ----
        LDU     #TEXTS
TEXT    LDX     ,U++            ; screen address, 0 ends
        BEQ     ENDTXT
        LDY     ,U++            ; string
        PSHS    U
        TFR     Y,U
        JSR     PRAT
        PULS    U
        BRA     TEXT
ENDTXT
; ---- the greeting under the title, chosen by GREET ----
        LDB     GREET
        CMPB    #2
        BLS     GRTOK
        CLRB
GRTOK   LSLB
        LSLB                    ; 4 bytes an entry
        LDU     #GREETS
        LEAU    B,U
        LDX     ,U++
        LDU     ,U
        JSR     PRAT
; ---- option 5, if the Session set one: its line and the prompt's last digit ----
; With option 5 the greeting and the menu move up a row (rows 7-12 to 6-11), so a blank row still separates the
; menu from PRESS 1 TO 5; option 5 goes on row 12.
        TST     CARRY
        BEQ     NOFIVE
        LDX     #SCREEN+6*32
MOVEUP  LDD     32,X
        STD     ,X++
        CMPX    #SCREEN+12*32
        BNE     MOVEUP
        LDD     #$6060          ; row 12, cleared for option 5
CLR12   STD     ,X++
        CMPX    #SCREEN+13*32
        BNE     CLR12
        LDU     #T_5
        LDX     #SCREEN+12*32+4
        JSR     PRAT
        LDU     #CARRY
        JSR     PRAT
        LDA     #'5
        STA     SCREEN+14*32+21 ; PRESS 1 TO 4 -> 5
NOFIVE

; ---- bottom stripe, drawn at once ----
        LDX     #SCREEN+15*32
        CLRB
STRIP2  JSR     BLOCK
        STA     ,X+
        INCB
        CMPB    #32
        BNE     STRIP2

; ---- wait for keys; play the tune once sound is unlocked ----
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
        CMPA    #'1
        BLO     KEYLP
        CMPA    #'4
        BLS     KEYOK
        CMPA    #'5             ; 5 only with option 5
        BNE     KEYLP
        TST     CARRY
        BEQ     KEYLP
KEYOK   SUBA    #'0             ; 1-5
        STA     EVENT
        BRA     KEYLP

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

        END     WELCOME
