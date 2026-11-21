* The Reset button (a reset with RAM kept) on the SAM machines (tools/mame-diff, written for CLOADM).
*
* run.js <profile> --reset runs it against MAME: MAME's Lua presses Reset (machine:soft_reset) a few frames after
* the firmware has settled in SYNC (PHASE counts how often); ours is reset at the cycle MAME's first instruction
* after the reset starts, because when a button is pressed is outside the machine (sam/spec.js reset()). From there
* every instruction is compared: what the 6809 keeps over a reset (A, B, X, Y, U, S; only DP, CC and PC are
* reset), what the PIAs' control registers read after it, and that RAM is kept.
*
* It follows the warm-start convention of Color BASIC and Dragon BASIC (as their published disassemblies are
* commonly described; not re-checked here against a primary source): RSTFLG ($71) = $55 and a NOP ($12) at the
* address in RSTVEC ($72-$73) -> JMP there; anything else -> a cold start.
*   power-on  cold path (PHASE 0): marks RAM, sets the vector to a warm routine copied to $3000, SYNC (PHASE 1)
*   Reset 1   warm path: the routine at $3000 reads back the PIAs' control registers, points the vector at a
*             byte that is not a NOP, SYNC (PHASE 2)
*   Reset 2   cold path again (the NOP check fails), PHASE 2: reads the marks RAM kept, then HALT
* The Lua prelude zeroes $0071-$0073 and $0100-$011F in MAME before the first instruction, so the power-on read
* of RSTFLG and PHASE sees what our zero-filled RAM holds (MAME fills fresh RAM differently).
* No PIA interrupt is ever enabled, so SYNC waits until the reset.
RSTFLG  EQU     $71
RSTVEC  EQU     $72
PHASE   EQU     $0100
MARK    EQU     $0110
WCOUNT  EQU     $0111
SEEN    EQU     $0112
WARMAT  EQU     $3000
        ORG     $8000
RESET   LDA     RSTFLG
        CMPA    #$55
        BNE     COLD
        LDX     RSTVEC
        LDA     ,X
        CMPA    #$12
        BNE     COLD
        JMP     ,X
COLD    ORCC    #$50
        LDS     #$7F00
        CLRA
        TFR     A,DP
        LDA     PHASE
        BNE     AGAIN
* power-on: mark RAM, copy the warm routine, set the vector, set up the PIAs, then wait in SYNC
        LDA     #$A5
        STA     MARK
        CLR     WCOUNT
        LDX     #WSRC
        LDY     #WARMAT
COPY    LDA     ,X+
        STA     ,Y+
        CMPX    #WEND
        BNE     COPY
        LDA     #$55
        STA     RSTFLG
        LDX     #WARMAT
        STX     RSTVEC
* PIA control registers with their data/DDR bit set and no interrupt enabled (bit 0 and bit 3 with CA2/CB2 as
* inputs stay clear): a reset must clear them again
        LDA     #$34
        STA     $FF01
        STA     $FF03
        STA     $FF21
        STA     $FF23
        LDA     #1
        STA     PHASE
* registers the reset must leave alone
        LDD     #$1234
        LDX     #$5678
        LDY     #$9ABC
        LDU     #$DEF0
        SYNC
WAIT1   BRA     WAIT1
* after Reset 2: what RAM kept
AGAIN   LDA     MARK
        LDB     WCOUNT
        STD     SEEN
        LDX     RSTVEC
        LDY     #$4321
HALT    BRA     HALT

* the warm routine, run from RAM at $3000 (position-independent: it only uses absolute data addresses)
WSRC    NOP
        LDA     $FF01
        LDB     $FF03
        STD     SEEN
        LDA     $FF21
        LDB     $FF23
        STD     SEEN+2
        INC     WCOUNT
        LDX     #WARMAT+1
        STX     RSTVEC
        LDA     #2
        STA     PHASE
        LDD     #$CAFE
        LDX     #$BEEF
        LDY     #$F00D
        LDU     #$D00D
        SYNC
WSELF   BRA     WSELF
WEND
        ORG     $BFF2
        FDB     RESET,RESET,RESET,RESET,RESET,RESET,RESET
