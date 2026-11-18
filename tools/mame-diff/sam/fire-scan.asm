* fire-scan.asm: our own firmware, in place of the BASIC ROMs, for the joystick's fire button on the keyboard's
* row lines. tests/touch-joystick.test.js runs it on a Dragon 64 and a CoCo 3 and reads its markers. It sets
* PIA0 up as the machine's own keyboard scan does - port B all outputs driving the columns, port A all inputs
* reading the rows - and stores the row byte with no button down and again after the button shows. Joystick 0's
* fire button pulls PA0 low and joystick 1's PA1 (js/machines/cocopia.js: `if (m.fire[0]) rows &= ~0x01`), so
* the second reading says which of the two is down, and a path that sets the button anywhere but fire[] cannot
* produce it. The same byte from the on-screen stick's FIRE and from a gamepad's button is the check that the
* two paths meet the machine in the same place. Ends in its HALT loop.
* (MAME has no touch panel, and its fire buttons are live inputs set from Lua while this firmware polls for the
* press, so there is no MAME trace to compare: the port itself is MAME-verified elsewhere - run.js --hires and
* diag.asm's axis reads - and this file is the host path's own oracle.)
        ORG     $8000
RESET   ORCC    #$50
        LDS     #$0F00          ; inside the smallest RAM option
        LDA     #$5A
        STA     MARK
        LDA     #$00
        STA     $FF03           ; PIA0 B control: the DDR comes next
        LDA     #$FF
        STA     $FF02           ; every column an output (all high, the idle state)
        LDA     #$04
        STA     $FF03           ; and then the data register
        LDA     #$00
        STA     $FF01           ; PIA0 A control: the DDR comes next
        LDA     #$00
        STA     $FF00           ; port A all inputs (the rows)
        LDA     #$04
        STA     $FF01           ; and then the data register
WAITIDLE LDA    $FF00           ; the rows with no button down (bit 0 high)
        ANDA    #$03
        CMPA    #$03            ; both button rows high? (any key would read low too, so the run keeps the
        BEQ     IDLE            ; keyboard clear)
        BRA     WAITIDLE
IDLE    LDA     $FF00
        STA     BEFORE
WAITF   LDA     $FF00           ; until a button shows: bit 0 or bit 1 low
        ANDA    #$03
        CMPA    #$03
        BEQ     WAITF
GOTIT   LDA     $FF00
        STA     AFTER
        LDA     #$A5
        STA     DONE
HALT    BRA     HALT
MARK    EQU     $0300
BEFORE  EQU     MARK + 1
AFTER   EQU     MARK + 2
DONE    EQU     MARK + 3
        ORG     $BFF2
        FDB     RESET,RESET,RESET,RESET,RESET,RESET,RESET
