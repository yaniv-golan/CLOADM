; ---------------------------------------------------------------
; welcome-data.inc - the welcome program's data, INCLUDEd by both builds
; (examples/welcome.asm for the 6809 machines and examples/welcome6803.asm for the MC-10 and
; Matra Alice) so a changed menu line, colour pattern or tune cannot drift between them.
;
; The order of this file is load-bearing: both builds put it straight after their code, and the
; 6809 build's committed welcome.bin is a regress-hashed artefact, so keeping the sections in
; this order keeps that binary byte-identical. The screen-cell encodings are VDG text/SG4 codes;
; the address of the screen is the build's own constant (SCREEN, defined before this file is
; included), and the row arithmetic is written per build because the 6803 has one index register
; and the 6809 has several.
; ---------------------------------------------------------------

; the tune: delay, half periods (about 0.895 MHz: C5 E5 G5 E5 C6, A5 G5 E5 D5 C5).
; Each note: delay D, then N half periods of 5*D+19 cycles; 0 ends the list.
NOTES   FCB     167
        FDB     126
        FCB     132
        FDB     158
        FCB     110
        FDB     188
        FCB     132
        FDB     158
        FCB     82
        FDB     753
        FCB     98
        FDB     211
        FCB     110
        FDB     188
        FCB     132
        FDB     158
        FCB     149
        FDB     141
        FCB     167
        FDB     440
        FCB     0

; CLOADM, 29 cells by 3 rows of SG4 quarter blocks in green
BIG     FCB     $87,$8C,$8C,$8B,$80,$8F,$80,$80,$80,$80,$87,$8C,$8C,$8B,$80
        FCB     $87,$8C,$8C,$8B,$80,$8F,$8C,$8D,$82,$80,$8F,$82,$81,$8F
        FCB     $8F,$80,$80,$80,$80,$8F,$80,$80,$80,$80,$8F,$80,$80,$8F,$80
        FCB     $8F,$83,$83,$8F,$80,$8F,$80,$80,$8F,$80,$8F,$8D,$8E,$8F
        FCB     $8D,$83,$83,$8E,$80,$8F,$83,$83,$82,$80,$8D,$83,$83,$8E,$80
        FCB     $8F,$80,$80,$8F,$80,$8F,$83,$87,$88,$80,$8F,$80,$80,$8F

; screen address, string address; a 0 address ends the table. SCREEN is the build's own constant.
TEXTS   FDB     SCREEN+9*32+4,T_1
        FDB     SCREEN+10*32+4,T_2
        FDB     SCREEN+11*32+4,T_3
        FDB     SCREEN+12*32+4,T_4
        FDB     SCREEN+14*32+10,T_PRESS
        FDB     0
; the greeting under the title (row 7), one entry of screen address and string per GREET value: 0 the first
; visit (the subtitle), 1 a returning visitor, 2 back from a program
GREETS  FDB     SCREEN+7*32+3,T_SUB
        FDB     SCREEN+7*32+10,T_BACK
        FDB     SCREEN+7*32+3,T_BYE

; The subtitle names the machine the build runs on, selected at assembly time by one flag per build
; family. Every build passes ALL of them explicitly, 0 or 1 (tools/build-examples.js), and an IF on an
; undefined symbol is an assembler error, so a typo or an omitted flag cannot build the wrong name
; silently. The 6809 build covers eleven models, so it keeps the generic line.
        IF      MC10
T_SUB   FCN     "TANDY MC-10"
        ENDIF
        IF      ALICE
T_SUB   FCN     "MATRA ALICE"
        ENDIF
        IF      SIX09
T_SUB   FCN     "DRAGON AND COLOR COMPUTER"
        ENDIF
T_BACK  FCN     "WELCOME BACK"
T_BYE   FCN     "BYE FOR NOW. PICK ANOTHER?"
; option 5's digit (inverse video); its text is CARRY, which the Session sets
T_5     FCB     '5+$80
        FCN     " "

; the menu lines, each a digit (inverse video) followed by its text
T_1     FCB     '1+$80
        FCN     " TALK TO LIZA"
T_2     FCB     '2+$80
        FCN     " COLOUR AND SOUND"
T_3     FCB     '3+$80
        FCN     " ADD YOUR ROMS FOR BASIC"
T_4     FCB     '4+$80
        FCN     " CHAT WITH CLAUDE"
T_PRESS FCN     "PRESS 1 TO 4"
