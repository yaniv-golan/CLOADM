* coco-halt.asm: our own code, in place of the DOS ROM (run.js coco3 --fdc cocofdc --halt). The controller's
* HALT and NMI during sector reads, as the software that relies on them reads: the CPU halted until each byte's
* DRQ, the end of the command on NMI (INTRQ while the control latch's DDEN bit is set), at the CoCo 3's two CPU
* rates ($FFD8: 0.89 MHz, $FFD9: 1.78 MHz). Three read loops:
*   N9   NitrOS-9's floppy booter (level1/modules/boot_1773.asm, tag v3.3.0: ReadSect, L0123): the command, the
*        control latch with DDEN and READY, a short delay, HALT enable, then LDA DATAREG,Y / STA ,X+ / NOP / BRA
*   DOS  extended addressing, HALT enabled straight after the command (LDA $FF4B / STA ,X+ / BRA)
*   WAIT the first DRQ polled in the status register before HALT is enabled (the floppy loader,
*        js/machines/nitros9.js)
* Each read records at $6000+: the status, the number of bytes the loop stored (the data register's reads), and
* the first and last byte stored, then the number of NMIs. Drive 0 is spec.js's double-sided JVC disk: sectors 1-6
* of track 0 at each rate. Expected (and what MAME and we record): every N9 and WAIT read stores the 256 bytes of its
* sector; a DOS read stores 257, the first one stale (the control latch's DRQ input only follows the WD1773 from
* its first DRQ on, so HALT can't hold the read before it).
NMICNT  EQU     $0F00
NMIFLG  EQU     $0F01
NMIRET  EQU     $0F02
        ORG     $C000
        JMP     START
        JMP     NMIH
        JMP     FIRQH
        JMP     IRQH
* NMI: during a read (NMIFLG set) it leaves the read loop, dropping the interrupt's frame; otherwise it returns
NMIH    INC     NMICNT
        TST     NMIFLG
        BNE     NMIOUT
        RTI
NMIOUT  CLR     NMIFLG
        LEAS    12,S
        JMP     [NMIRET]
FIRQH   RTI
IRQH    RTI
* the WD1773's few microseconds after a register write (54 cycles in boot_1773.asm's Delay2)
DELAY   PSHS    B
        LDB     #8
DL      DECB
        BNE     DL
        PULS    B,PC
* wait while busy (status bit 0); the status goes to ,U+
WAITNB  LDA     8,Y
        BITA    #$01
        BNE     WAITNB
        STA     ,U+
        RTS
* after a read: status, bytes stored, first and last byte -> ,U
RESULT  LDA     8,Y
        STA     ,U+
        TFR     X,D
        SUBD    #$1000
        STD     ,U++
        LDA     $1000
        STA     ,U+
        LDA     -1,X
        STA     ,U+
        LDA     #$29            ; the control latch as before the read (INTRQ cleared its HALT enable)
        STA     ,Y
        RTS
ARM     LDA     #1              ; an NMI now ends the read at NMIRET
        STA     NMIFLG
        LDX     #$1000
        RTS
* N9: B = sector
RDN9    STB     10,Y
        JSR     DELAY
        LDD     #N9END
        STD     NMIRET
        BSR     ARM
        LDB     #$80            ; READ SECTOR
        STB     8,Y
        LDB     #$39            ; drive 0, motor, DDEN, READY
        STB     ,Y
        JSR     DELAY
        ORB     #$80            ; HALT enable
        STB     ,Y
        NOP
        NOP
N9LOOP  LDA     11,Y
        STA     ,X+
        NOP
        BRA     N9LOOP
N9END   LBRA    RESULT
* DOS: B = sector
RDDOS   STB     10,Y
        JSR     DELAY
        LDD     #DOSEND
        STD     NMIRET
        BSR     ARM
        LDB     #$80
        STB     8,Y
        LDB     #$A9            ; drive 0, motor, DDEN, HALT enable
        STB     ,Y
DOSLOOP LDA     $FF4B
        STA     ,X+
        BRA     DOSLOOP
DOSEND  LBRA    RESULT
* WAIT: B = sector
RDWAIT  STB     10,Y
        JSR     DELAY
        LDD     #WTEND
        STD     NMIRET
        BSR     ARM
        LDB     #$80
        STB     8,Y
        JSR     DELAY
WTDRQ   LDA     8,Y
        BITA    #$02
        BEQ     WTDRQ
        LDB     #$A9
        STB     ,Y
WTLOOP  LDA     $FF4B
        STA     ,X+
        BRA     WTLOOP
WTEND   LBRA    RESULT
* the three loops on sectors 1-6 at the rate in use
TESTS   LDB     #1
        LBSR    RDN9
        LDB     #2
        LBSR    RDN9
        LDB     #3
        LBSR    RDDOS
        LDB     #4
        LBSR    RDDOS
        LDB     #5
        LBSR    RDWAIT
        LDB     #6
        LBSR    RDWAIT
        RTS
START   LDU     #$6000
        LDY     #$FF40
        CLR     NMICNT
        CLR     NMIFLG
        LDA     #$29            ; drive 0, motor, DDEN (NMI on INTRQ)
        STA     ,Y
        LDA     #$D0            ; force interrupt
        STA     8,Y
        JSR     DELAY
        LDA     8,Y
        LDA     #$00            ; restore: its INTRQ is an NMI that returns
        STA     8,Y
        JSR     DELAY
        JSR     WAITNB
        STA     $FFD8           ; 0.89 MHz
        LBSR    TESTS
        STA     $FFD9           ; 1.78 MHz
        LBSR    TESTS
        STA     $FFD8
        CLR     ,Y              ; motor off
        LDA     NMICNT
        STA     ,U+
        STU     $5FFE
HALT    BRA     HALT
