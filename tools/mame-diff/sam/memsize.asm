* SAM memory-size (M1/M0) and page (P1) diagnostic (tools/mame-diff, written for CLOADM).
*
* The bug this checks: our SAM decoded P1 but never used it, and ignored the memory-size bits.
* This firmware drives both; the lockstep trace against MAME is the oracle — every register at every
* instruction must agree, so no expected value is written down here and none is taken from our core.
*
* SAM control bits are written at $FFC0+2*bit (even address clear, odd address set; MAME 0.289
* 6883sam.h alter_sam_state, MC6883 data sheet p. 16). The data byte is ignored.
*   P1 bit 10: clear $FFD4, set $FFD5      R0 bit 11: clear $FFD6, set $FFD7
*   M0 bit 13: clear $FFDA, set $FFDB      R1 bit 12: clear $FFD8, set $FFD9
*   M1 bit 14: clear $FFDC, set $FFDD      TY bit 15: clear $FFDE, set $FFDF
*
* What MAME 0.289's 6883sam.cpp does (:160-215 and :283-330):
*   read and write: `if (mode_64k && (state & (TY|P1)) == P1) offset |= 0x8000;`
*     so P1 redirects a $0000-$7FFF access to the upper half only when M1=1 and TY=0; with TY=1 (all
*     RAM) it does nothing, and with M1=0 it does nothing.
*   M1/M0 set m_counter_mask (4K/16K/64K/64K) on the VIDEO counter only; MAME's own TODO says they should
*     affect every memory access but do not.
*
* Every byte this firmware reads has been written first, in both halves, so the comparison never depends
* on how MAME and we fill fresh RAM (which differ). Results go to one RES slot each, stored immediately
* after the read, so the trace compares them at that instruction.
* Ends in HALT.
RES     EQU     $0100
        ORG     $8000
RESET   ORCC    #$50
        LDA     #$00
        STA     $FFDD           ; M1=1: 64K dynamic (as BASIC and every other firmware sets at boot)
        LDS     #$7F00
        CLRA
        TFR     A,DP
        CLR     $FFDE           ; TY=0
        CLR     $FFD4           ; P1=0
        CLR     $FFDA           ; M0=0
        LDX     #$0000
CLR     CLR     ,X+
        CMPX    #$3000          ; (MAME and we fill uninitialised RAM differently)
        BNE     CLR
* the upper half too: with P1 set, writes to $0000-$7EFF land at $8000-$FEFF, so the same loop clears
* RAM the machine cannot otherwise reach while it runs from ROM under TY=0
        STA     $FFD5           ; P1=1
        LDX     #$0000
CLRH    CLR     ,X+
        CMPX    #$7F00
        BNE     CLRH
        CLR     $FFD4           ; P1=0
        CLR     $FF01           ; PIA0: DDRs and data registers quiet
        CLR     $FF00
        CLR     $FF03
        LDA     #$FF
        STA     $FF02
        LDA     #$34
        STA     $FF01
        STA     $FF03
        CLR     $FF21           ; PIA1 likewise
        LDA     #$FE
        STA     $FF20
        LDA     #$34
        STA     $FF21
        CLR     $FF23
        LDA     #$FC
        STA     $FF22
        LDA     #$34
        STA     $FF23
*
* ---- PHASE 1: P1 with M1=1, TY=0 ----
* A known byte in each half; a redirected read or write then shows up as the other half's value.
        LDA     #$11
        STA     $1000           ; low RAM
        LDA     #$22
        STA     $FFD5           ; P1=1, so the next store goes to the upper half
        STA     $1000           ; ($22's value is irrelevant; the address is what matters) -> $9000
        CLR     $FFD4           ; P1=0
* case 1: a read of $1000 with P1 set comes from $9000
        STA     $FFD5           ; P1=1
        LDB     $1000
        STB     RES+0
* case 2: a write of $1000 with P1 set lands at $9000
        LDA     #$33
        STA     $1000
        CLR     $FFD4           ; P1=0
        LDB     $1000           ; the low half is untouched
        STB     RES+1
* case 3: with P1 clear, the upper half is not reachable through $1000
        LDA     #$44
        STA     $1100           ; low half, a clean location
        STA     $FFD5           ; P1=1
        LDB     $1100           ; comes from $9100, which holds $22 (written in case 1's setup)
        STB     RES+2
        CLR     $FFD4
        LDB     $1100
        STB     RES+3
* case 4: the page boundary. P1 is `offset |= 0x8000` (MAME 6883sam.cpp:171), so $7E00 becomes $FE00: bit 15
* is set and the low 15 bits are kept. Both halves are written here with distinct values, so the result does
* not depend on how a machine fills RAM it was never given — $FE00 is real RAM on a 64K machine and absent on
* a 32K one (where the write is lost and MAME reads 0 for absent RAM).
        LDA     #$77
        STA     $FFD5           ; P1=1, write through the page -> $FE00
        STA     $7E00
        CLR     $FFD4           ; P1=0
        LDA     #$88
        STA     $7E00           ; the low half, a different value
        STA     $FFD5           ; P1=1
        LDB     $7E00           ; $77 if the page redirects, $88 if it does not
        STB     RES+4
        CLR     $FFD4
        LDB     $7E00           ; with P1 clear, the low half again
        STB     RES+5
*
* ---- PHASE 2: the four M1/M0 combinations, P1 set, over a known low byte ----
        LDA     #$66
        STA     $0500
        STA     $FFD5           ; P1=1
        CLR     $FFDC           ; M1=0
        CLR     $FFDA           ; M0=0
        LDB     $0500
        STB     RES+8
        CLR     $FFDA
        STA     $FFDB           ; M0=1
        LDB     $0500
        STB     RES+9
        STA     $FFDD           ; M1=1
        CLR     $FFDA           ; M0=0
        LDB     $0500
        STB     RES+10
        STA     $FFDB           ; M0=1
        LDB     $0500
        STB     RES+11
        CLR     $FFD4           ; P1=0
*
* ---- PHASE 3: TY with M1 clear ----
* The case that settles it: MAME's RAM window is `mode_64k && TY` (6883sam.cpp:167), where mode_64k is
* M1 alone, so with M1 clear TY gives nothing and $9000 stays ROM. A TY-only window would show the byte written
* there instead. This code runs in place: with M1 clear the page and the window are both inert, so the fetch
* stays in ROM and only the data address's meaning changes. Both bytes are written before they are read, so no
* result depends on how a machine fills RAM it was never given.
        LDA     #$99
        STA     $9000           ; may be ROM (lost) or RAM, depending on the case; $98 distinguishes
        LDA     #$98
        STA     $1300           ; the low-half control, always RAM
        LDA     #$00
        STA     $FFDC           ; M1=0
        STA     $FFDF           ; TY=1
        STA     $FFD5           ; P1=1 (must do nothing here)
        LDB     $9000           ; MAME: ROM byte; a TY-only window: $99
        STB     RES+12
        LDB     $1300           ; always the low byte, $98
        STB     RES+13
        CLR     $FFDE           ; TY=0
        CLR     $FFD4           ; P1=0
*
* ---- leave M1=1, TY=0, P1=0 and HALT ----
        LDA     #$00
        STA     $FFDD
        CLR     $FFDA
        CLR     $FFD4
HALT    BRA     HALT
        ORG     $BF00
        FCB     $11
        ORG     $BFF2
        FDB     HALT,HALT,HALT,HALT,HALT,HALT,RESET
        END     RESET
