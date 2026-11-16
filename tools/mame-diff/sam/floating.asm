* floating.asm: the floating bus, $FF60-$FFBF with no cartridge fitted, for the lockstep comparison with
* MAME (run.js <profile> --floating). Our own firmware, in place of the BASIC ROMs (the SAM family's diag.asm
* layout: ORG $8000, vectors at $BFF2). The expected behaviour is MAME's coco.cpp floating_bus_read():
*   - a no-offset indexed read (the indexed opcodes $6x/$Ax/$Ex whose postbyte, masked with $BF, is $84: ,X,
*     0,X, ,U and 0,U) returns the byte at the address of the next instruction, which the 6809 fetches just
*     before the effective address;
*   - every other addressing mode returns the byte at $FFFF, the low byte of the reset vector.
* This firmware reads the window in every indexed form and extended, and stores each value at $2000+n with an
* absolute store, so the lockstep trace sees it in A (every instruction) and the run can also be read back
* from memory. RESET is at $80A7, so $FFFF holds $A7; the instruction after each read is STA <abs> ($B7), so
* a no-offset read returns $B7 and any other mode $A7 - the two values the comparison distinguishes.
* Ends in its HALT loop.
        ORG     $80A7           ; so $FFFF ($BFF2's vector pair ends 80 A7) holds $A7
RESET   ORCC    #$50
        LDS     #$7F00
        LDA     #$00
        STA     $FFDD           ; SAM M1=1: 64K dynamic RAM, as BASIC and our other firmware set at boot
        LDU     #$FF60

; --- no-offset indexed: the next instruction's opcode ($B7, this firmware's STA) ---
        LDX     #$FF60
        LDA     ,X
        STA     $2000
        LDA     0,X
        STA     $2001
        LDA     ,U
        STA     $2002
        LDA     0,U
        STA     $2003

; --- indexed with a value or no index register: $FFFF's byte ($A7) ---
; (,Y is not no-offset: its postbyte $A4 does not survive MAME's $BF mask.)
        LDY     #$FF60
        LDA     ,Y
        STA     $2004
        LDA     0,Y
        STA     $2005
        LDX     #$FF60
        LDA     1,X
        STA     $2006
        LDY     #$FF60
        LDA     1,Y
        STA     $2007

; --- indirect: the operand word is itself fetched through the window ---
        LDX     #$FF60
        LDA     [0,X]
        STA     $2008
        LDY     #$FF60
        LDA     [0,Y]
        STA     $2009

; --- and not indexed at all ---
        LDA     $FF60           ; extended
        STA     $200A
        LDA     $FF70
        STA     $200B
        LDA     $FFBF           ; the last address of the window
        STA     $200C
        LDB     $FF60           ; through B: the byte is not A-specific
        STB     $200D

HALT    BRA     HALT
        ORG     $BFF2
        FDB     HALT,HALT,HALT,HALT,HALT,HALT,RESET
        END     RESET
