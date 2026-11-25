* ---------------- cold and warm start ----------------
* RESET: set up the PIAs and the SAM [HW]; a warm start (the reset button, with WARMFL intact) keeps the
* program, a cold start clears everything.

RESET   ORCC    #$50            ; no interrupts while setting up
        CLRA
        TFR     A,DP
        LDS     #LINBUF         ; a temporary stack until the memory pointers are set
* PIA 0: port A in (keyboard rows), port B out (keyboard columns); CB1 (field sync) interrupts
        CLR     PIA0CA          ; control register 0: the DDR
        CLR     PIA0A           ; port A all inputs
        LDA     #$34            ; CA2 output low, data register, CA1 interrupt off
        STA     PIA0CA
        CLR     PIA0CB
        LDA     #$FF
        STA     PIA0B           ; port B all outputs
        LDA     #$35            ; CB2 output low, data register, CB1 interrupt on (falling edge)
        STA     PIA0CB
        LDA     #$FF
        STA     PIA0B           ; no column driven
* PIA 1: port A bits 1-7 out (DAC), port B bits 1-7 out; PB2 high keeps the 32K-mode ROM selected, so it is
* written to the data register before port B becomes an output
        CLR     PIA1CA
        LDA     #$FE
        STA     PIA1A
        LDA     #$34            ; CA2 (motor) low, data register
        STA     PIA1CA
        LDA     #$04
        STA     PIA1CB          ; data register
        STA     PIA1B           ; PB2 = 1, VDG text mode
        CLR     PIA1CB          ; the DDR
        LDA     #$FE
        STA     PIA1B
        LDA     #$34            ; CB2 (sound) low, data register, CB1 interrupt off
        STA     PIA1CB
* SAM: the text screen at $0400, 64K RAM
        STA     SAMF1S
        STA     SAMM1S
        LDA     <WARMFL
        CMPA    #$55
        BNE     COLD
        BRA     WARM

COLD    LDX     #0              ; clear the direct page and the system RAM below the screen
COLD1   CLR     ,X+
        CMPX    #SCREEN
        BNE     COLD1
        LDX     #ZINIT          ; the two-byte calls and the RAM vectors
        LDU     #ZTRAMP
        LDB     #6*3+3*10
COLD2   LDA     ,X+
        STA     ,U+
        DECB
        BNE     COLD2
        LDD     #RAMTOP
        STD     <MEMTOP
        LDD     #RAMTOP-STRDEF
        STD     <STRBOT
        LDD     #300            ; the debounce delay [OWN]
        STD     <KEYDLY
        INC     <BLINK          ; the countdown at 1: the first update at the prompt shows the cursor [OWN]
        LDX     #PROGST
        STX     <TXTTAB
        CLR     -1,X
        JSR     NEWPRG          ; an empty program, cleared variables, the stack reset
        JSR     GINIT           ; the graphics mode, colours and last point
        LDA     #$55
        STA     <WARMFL
        JSR     CLS
        LDX     #BANNER
        JSR     <ZPRTSTR
        JMP     READY

* the reset button with BASIC already running: keep the program and the variables
WARM    LDS     <STRBOT
        CLR     <TRCFLG
        LDX     #SCREEN
        STX     <CURPOS
        JSR     CLS
        JMP     READY

* the two-byte calls' JMPs (d64basic.asm, ZTRAMP), then the RAM vectors' initial contents: JMP handler
ZINIT   FCB     $7E
        FDB     CHRGET
        FCB     $7E
        FDB     CHRGOT
        FCB     $7E
        FDB     CHROUT
        FCB     $7E
        FDB     FNARGN
        FCB     $7E
        FDB     FPRUN
        FCB     $7E
        FDB     PRTSTR
        FCB     $7E
        FDB     LINGET
        FCB     $7E
        FDB     CHKCOM
        FCB     $7E
        FDB     USCHR
        FCB     $7E
        FDB     EVNUM
VECINI  FCB     $7E             ; (written as data: copied to RAM, so each must be the 3-byte JMP)
        FDB     IRQSRV
        FCB     $7E
        FDB     FIRQSV
        FCB     $7E
        FDB     NMISRV
        FCB     $7E
        FDB     NMISRV
        FCB     $7E
        FDB     NMISRV
        FCB     $7E
        FDB     NMISRV

BANNER  FCC     "CLOADM BASIC"  ; (a placeholder: the wording comes later)
        FCB     13
        FCN     ""

* ---------------- interrupts ----------------
* IRQ: the field sync (50 Hz): count TIMER and acknowledge PIA 0 CB1 by reading port B; 104 cycles in all
IRQSRV  LDA     PIA0CB
        BPL     IRQ1            ; not the field sync
        LDA     PIA0B           ; acknowledge
        LDX     <TIMER
        LEAX    1,X
        STX     <TIMER
        MUL                     ; 38 cycles more (11 + 11 + 11 + 3 + 2): the whole interrupt, entry to RTI, takes
        MUL                     ; the original's 104, which lengthens the period it falls in by as much (octave 1's
        MUL                     ; C to G, whose median periods hold it) [BB bb2 snd-play-pitch]
        ABX
        NOP
IRQ1    RTI
* FIRQ: the cartridge line; acknowledge PIA 1 CB1
FIRQSV  PSHS    A
        LDA     PIA1B
        PULS    A
        RTI
NMISRV  RTI
