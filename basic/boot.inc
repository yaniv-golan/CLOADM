* ---------------- cold and warm start ----------------
* RESET: set up the PIAs and the SAM [HW]; a warm start (the reset button, with WARMFL intact) keeps the
* program, a cold start clears everything.

RESET   ORCC    #$50            ; no interrupts while setting up
        CLRA
        TFR     A,DP
        LDS     #LINBUF         ; a temporary stack until the memory pointers are set
* The PIAs, from PIATAB: each register (its address's low byte) and the value written to it, in order
        LDX     #PIATAB
        LDU     #PIA0A
PIAI    LDD     ,X++
        STB     A,U
        CMPX    #PIATBE
        BLO     PIAI
* SAM: the text screen at $0400, 64K RAM
        STA     SAMF1S
        STA     SAMM1S
        LDA     <WARMFL
        CMPA    #$55
        BEQ     WARM

COLD    LDX     #0              ; clear the direct page and the system RAM below the screen
COLD1   CLR     ,X+
        CMPX    #SCREEN
        BNE     COLD1
        LDX     #ZINIT          ; the two-byte calls and the RAM vectors
        LDU     #ZTRAMP
COLD2   LDA     #$7E            ; a JMP to each address of the list
        STA     ,U+
        LDD     ,X++
        STD     ,U++
        CMPX    #ZINITE
        BNE     COLD2
        LDD     #STRTOP
        STD     <MEMTOP
        LDD     #STRTOP-STRDEF
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
        COM     CASEFL          ; upper case: 255 [BB bb6 famous-pokes]
        JSR     CLS
        LDX     #BANNER
        JSR     <ZPRTSTR
        BRA     RDYJ

* the reset button with BASIC already running: keep the program and the variables
WARM    LDS     <STRBOT
        CLR     <TRCFLG
        JSR     CLS
RDYJ    JMP     READY

* the two-byte calls' targets (d64basic.asm, ZTRAMP, in its order), then the RAM vectors' handlers: an address
* each, and COLD2 writes the JMP in front of it
ZINIT   FDB     CHRGET,CHRGOT,CHROUT,FNARGN,FPRUN,PRTSTR,LINGET,CHKCOM,USCHR,EVNUM
        FDB     GETBYT,SNERR,RPAREN,FCERR,CHKNUM,MOVMF
        FDB     IRQSRV,FIRQSV,NMISRV,NMISRV,NMISRV,NMISRV       ; the RAM vectors: IRQ, FIRQ, NMI, SWI, SWI2, SWI3
ZINITE  RMB     0

* PIA 0: port A in (keyboard rows), port B out (keyboard columns); CB1 (field sync) interrupts
PIATAB  FCB     $01,$00         ; control register A: the DDR
        FCB     $00,$00         ; port A all inputs
        FCB     $01,$34         ; CA2 output low, data register, CA1 interrupt off
        FCB     $03,$00
        FCB     $02,$FF         ; port B all outputs
        FCB     $03,$35         ; CB2 output low, data register, CB1 interrupt on (falling edge)
        FCB     $02,$FF         ; no column driven
* PIA 1: port A bits 1-7 out (DAC), port B bits 1-7 out; PB2 high keeps the 32K-mode ROM selected, so it is
* written to the data register before port B becomes an output
        FCB     $21,$00
        FCB     $20,$FE
        FCB     $21,$34         ; CA2 (motor) low, data register
        FCB     $23,$04         ; data register
        FCB     $22,$04         ; PB2 = 1, VDG text mode
        FCB     $23,$00         ; the DDR
        FCB     $22,$FE
        FCB     $23,$34         ; CB2 (sound) low, data register, CB1 interrupt off
PIATBE  RMB     0

BANNER  FCC     "CLOADM BASIC"  ; (a placeholder: the wording comes later)
        FCB     13
        FCN     ""

* ---------------- interrupts ----------------
* IRQ: the field sync (50 Hz): count TIMER and acknowledge PIA 0 CB1 by reading port B; 104 cycles in all
IRQSRV  LDA     PIA0CB
        BPL     IRQ1            ; not the field sync
        LDA     PIA0B           ; acknowledge
        LDX     TIMER
        LEAX    1,X
        STX     TIMER
        MUL                     ; 36 cycles more (11 + 11 + 11 + 3): the whole interrupt, entry to RTI, takes the
        MUL                     ; original's 104, which lengthens the period it falls in by as much (octave 1's C to
        MUL                     ; G, whose median periods hold it) [BB bb2 snd-play-pitch]
        ABX
IRQ1    RTI
* FIRQ: the cartridge line; acknowledge PIA 1 CB1
FIRQSV  PSHS    A
        LDA     PIA1B
        PULS    A
        RTI
NMISRV  RTI
