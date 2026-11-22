; framecount.asm - a graphics program with no text on its screen, for the headless examples in docs/automation.md.
; Dragon 32/64/200 and CoCo 1/2, on the built-in firmware (no ROMs). Written for this project.
;
; It draws nothing of its own but a PMODE 4 screen (256x192, two colours, at $0600) and then runs one tick per video
; field: it waits for the field sync (the VDG's FS flag on PIA0 CB1), and each tick
;   * adds one to FRAME, a byte in RAM that a test can wait on (--wait-for 'mem:$3100=N'), and
;   * reads the keyboard matrix once; with SPACE down it records the tick in KEYSEEN and inverts one byte of the
;     picture on row 96, in the column FRAME mod 32, so a held key draws a line one byte a tick.
; Nothing on the screen is text: there is nothing for --wait-for text: to find.
;
; Run:    node cli/cloadm.js --asm docs/examples/framecount.asm --wait-for 'mem:$3100=3' --hold SPACE:2 --screenshot out.png
FRAME   EQU     $3100           ; the tick counter (wraps at 256)
KEYSEEN EQU     $3101           ; FRAME at the last tick that found SPACE down
PIA0DA  EQU     $FF00           ; keyboard rows in
PIA0DB  EQU     $FF02           ; keyboard columns out; reading it clears the FS flag
PIA0CRB EQU     $FF03           ; bit 7: the FS flag
PIA1DB  EQU     $FF22           ; VDG mode in bits 7-3
        ORG     $3000
START   ORCC    #$50            ; no interrupts: the program polls the field sync
        LDX     #$0600          ; clear the picture (6144 bytes)
        LDD     #0
CLEAR   STD     ,X++
        CMPX    #$0600+6144
        BNE     CLEAR
        CLR     FRAME
        CLR     KEYSEEN
        STA     $FFDA           ; SAM M = 10: 32K/64K RAM, so the VDG sees above $0FFF
        STA     $FFDD
        STA     $FFC7           ; SAM F = 3: the picture at 3 x 512 = $0600
        STA     $FFC9
        STA     $FFCA
        STA     $FFCC
        STA     $FFCE
        STA     $FFD0
        STA     $FFD2
        STA     $FFC0           ; SAM V = 110
        STA     $FFC3
        STA     $FFC5
        LDA     PIA1DB          ; VDG: A/G 1, GM 111 (RG6, PMODE 4), CSS 0
        ANDA    #$07
        ORA     #$F0
        STA     PIA1DB
TICK    LDA     PIA0DB          ; clear the flag...
WAITFS  LDA     PIA0CRB         ; ...and wait for the next field sync
        BPL     WAITFS
        INC     FRAME           ; one tick
        LDA     #%01111111      ; keyboard column 7 (SPACE) low
        STA     PIA0DB
        LDA     PIA0DA          ; rows: Dragon 5 and CoCo 3 (the bits 5 and 3)
        ANDA    #%00101000
        CMPA    #%00101000      ; both high: SPACE is up
        BEQ     NOKEY
        LDA     FRAME           ; SPACE is down at this tick
        STA     KEYSEEN
        ANDA    #31             ; column = FRAME mod 32
        LDX     #$0600+32*96    ; row 96
        COM     A,X             ; invert that byte (8 pixels)
NOKEY   LDA     #$FF            ; columns released
        STA     PIA0DB
        BRA     TICK
        END     START
