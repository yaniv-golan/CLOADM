* nmi.asm: when the 6809 starts accepting NMI (our own code, in place of the DOS ROM; nmi-boot.asm as BASIC;
* run.js dragon64 --fdc --nmi). After reset NMI is disarmed until the program first loads S. In MAME 0.264
* (m6809.cpp execute_set_input, m6809.lst, base6x09.lst) an NMI edge while disarmed is dropped, not kept for
* later; LDS, LEAS and TFR r,S arm it, and EXG with S does not. The NMI comes from the Dragon DOS controller's
* INTRQ (control latch $FF48 bit 5), raised and dropped with Force Interrupt. No stack is used until S is set.
NMICNT  EQU     $0F00
        ORG     $C000
        JMP     START
        JMP     NMIH
        JMP     OTHERH
        JMP     OTHERH
NMIH    INC     NMICNT
OTHERH  RTI
START   LDA     #$FF
        TFR     A,DP
        CLR     NMICNT
        LDA     #$24 ; NMI from INTRQ enabled, drive 0 motor on
        STA     <$48
        LDB     #$D0
        STB     <$40
* 1: an edge before S was ever loaded is dropped (A = 0)
        LDB     #$D8 ; Force Interrupt, immediate: INTRQ rises, the controller's NMI edge
        STB     <$40
        LDB     #40
D1A    DECB
        BNE     D1A
        LDB     <$40
        LDB     #$D0 ; Force Interrupt, none: INTRQ falls
        STB     <$40
        LDB     #20
D1B    DECB
        BNE     D1B
        LDB     <$40
COUNT1  LDA     NMICNT ; the NMIs taken so far
* 2: EXG X,S sets S but does not arm NMI (A = 0)
        LDX     #$7F00
        EXG     X,S
        LDB     #$D8 ; Force Interrupt, immediate: INTRQ rises, the controller's NMI edge
        STB     <$40
        LDB     #40
D2A    DECB
        BNE     D2A
        LDB     <$40
        LDB     #$D0 ; Force Interrupt, none: INTRQ falls
        STB     <$40
        LDB     #20
D2B    DECB
        BNE     D2B
        LDB     <$40
COUNT2  LDA     NMICNT ; the NMIs taken so far
* 3: nor does EXG S,Y (A = 0)
        LDY     #$7E00
        EXG     S,Y
        LDB     #$D8 ; Force Interrupt, immediate: INTRQ rises, the controller's NMI edge
        STB     <$40
        LDB     #40
D3A    DECB
        BNE     D3A
        LDB     <$40
        LDB     #$D0 ; Force Interrupt, none: INTRQ falls
        STB     <$40
        LDB     #20
D3B    DECB
        BNE     D3B
        LDB     <$40
COUNT3  LDA     NMICNT ; the NMIs taken so far
* 4: TFR X,S arms it: the edge is taken (A = 1)
        LDX     #$7F00
        TFR     X,S
        LDB     #$D8 ; Force Interrupt, immediate: INTRQ rises, the controller's NMI edge
        STB     <$40
        LDB     #40
D4A    DECB
        BNE     D4A
        LDB     <$40
        LDB     #$D0 ; Force Interrupt, none: INTRQ falls
        STB     <$40
        LDB     #20
D4B    DECB
        BNE     D4B
        LDB     <$40
COUNT4  LDA     NMICNT ; the NMIs taken so far
* 5: and every edge after (A = 2)
        LDB     #$D8 ; Force Interrupt, immediate: INTRQ rises, the controller's NMI edge
        STB     <$40
        LDB     #40
D5A    DECB
        BNE     D5A
        LDB     <$40
        LDB     #$D0 ; Force Interrupt, none: INTRQ falls
        STB     <$40
        LDB     #20
D5B    DECB
        BNE     D5B
        LDB     <$40
COUNT5  LDA     NMICNT ; the NMIs taken so far
* 6: LDS arms NMI on both CPUs, so on the 6809 this is the third taken (A = 3) and on the 6309 the first
*    (A = 1). MAME's 6309 uses the base core's LD16 handler, which sets lds_encountered (base6x09.lst
*    LD16), so this is the case that exercises the 6309's own NMI entry: its frame, its vector and its
*    timing. On the 6809 the earlier TFR already armed it, so the edge here is simply taken too.
        LDS     #$7F00
        LDB     #$D8 ; Force Interrupt, immediate: INTRQ rises, the controller's NMI edge
        STB     <$40
        LDB     #40
D6A    DECB
        BNE     D6A
        LDB     <$40
        LDB     #$D0 ; Force Interrupt, none: INTRQ falls
        STB     <$40
        LDB     #20
D6B    DECB
        BNE     D6B
        LDB     <$40
COUNT6  LDA     NMICNT ; the NMIs taken so far
HALT    BRA     HALT
