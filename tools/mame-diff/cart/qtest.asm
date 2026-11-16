* qtest.asm (INCLUDEd in RAM code): the CART line as PIA1 CB1 sees it. A cartridge that ties CART to Q makes
* MAME toggle the line five times on every PIA1 write (cococart.cpp twiddle_q_lines); a cartridge that doesn't
* leaves it alone. Reads the CB1 flag before and after PIA1 writes, with either edge selected, then takes the
* FIRQ that CB1 raises with its interrupt enabled. Ends with CB1 back on the falling edge, interrupt disabled.
QTEST   LDA     $FF23           ; CRB: bit 7 = CB1 flag
        LDA     $FF22           ; clear it
        LDA     $FF23
        LDA     $FF21           ; a PIA1 write (CRA, unchanged)
        STA     $FF21
        LDA     $FF23           ; the flag after it
        LDA     $FF22
        LDA     $FF23
        LDB     $FF23
        ANDB    #$FC
        ORB     #$02            ; CB1: rising edge
        STB     $FF23
        LDA     $FF23
        LDA     $FF22
        LDA     $FF23
        LDA     $FF21
        STA     $FF21
        LDA     $FF23
        LDA     $FF22
        ORB     #$01            ; CB1 interrupt on (the write itself is a PIA1 write)
        STB     $FF23
        LDA     $FF23
        LDA     FCOUNT
        ANDCC   #$BF            ; FIRQ unmasked
        NOP
        NOP
        LDA     $FF21
        STA     $FF21
        NOP
        NOP
        NOP
        ORCC    #$40
        LDA     FCOUNT
        ANDB    #$FC            ; falling edge, interrupt off
        STB     $FF23
        LDA     $FF22
        LDA     $FF23
        RTS
