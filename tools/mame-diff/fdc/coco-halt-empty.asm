* coco-halt-empty.asm: our own code, in place of the DOS ROM (run.js coco3 --fdc cocofdc --halt --empty). A read
* sector with HALT on DRQ on drive 2, which has no disk, as Disk BASIC issues it: the command, then the control latch with
* HALT enable. A read on drive 0 first leaves the latch's DRQ input low (it follows the WD1773 from its first DRQ
* on), so HALT is asserted at once, and the DRQ it waits for never comes: no disk, no index pulse, no INTRQ. HALT,
* delayed by the cartridge slot, arrives inside the LDA of the data register, after a check point, so the CPU stops
* inside that instruction. Expected (and what MAME and we do): the trace stops there, at EMPTY's LDA, and nothing
* runs after it while the machine goes on; HALT is never reached. Drive 0 is spec.js's double-sided JVC disk (its
* disks are in drives 0, 1 and 3).
NMIFLG  EQU     $0F01
NMIRET  EQU     $0F02
        ORG     $C000
        JMP     START
        JMP     NMIH
        JMP     FIRQH
        JMP     IRQH
* NMI: during a read (NMIFLG set) it leaves the read loop, dropping the interrupt's frame; otherwise it returns
NMIH    TST     NMIFLG
        BNE     NMIOUT
        RTI
NMIOUT  CLR     NMIFLG
        LEAS    12,S
        JMP     [NMIRET]
FIRQH   RTI
IRQH    RTI
* the WD1773's few microseconds after a register write
DELAY   PSHS    B
        LDB     #8
DL      DECB
        BNE     DL
        PULS    B,PC
* wait while busy (status bit 0)
WAITNB  LDA     8,Y
        BITA    #$01
        BNE     WAITNB
        RTS
START   LDY     #$FF40
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
* drive 0, sector 1, Disk BASIC's order (HALT enabled straight after the command); the NMI ends it
        LDB     #1
        STB     10,Y
        JSR     DELAY
        LDD     #D0END
        STD     NMIRET
        LDA     #1
        STA     NMIFLG
        LDX     #$1000
        LDB     #$80            ; READ SECTOR
        STB     8,Y
        LDB     #$A9            ; drive 0, motor, DDEN, HALT enable
        STB     ,Y
D0LOOP  LDA     $FF4B
        STA     ,X+
        BRA     D0LOOP
D0END   LDA     #$29            ; the control latch as before the read (INTRQ cleared its HALT enable)
        STA     ,Y
        STX     $5FFE
* drive 2 (no disk), sector 1: the command, then HALT enable; HALT holds the LDA below for good
        LDB     #1
        STB     10,Y
        JSR     DELAY
        LDD     #HALT           ; (an INTRQ, which should not come, would end the run at HALT)
        STD     NMIRET
        LDA     #1
        STA     NMIFLG
        LDX     #$2000
        LDB     #$80            ; READ SECTOR
        STB     8,Y
        LDB     #$AC            ; drive 2, motor, DDEN, HALT enable
        STB     $FF40
        NOP
EMPTY   LDA     $FF4B
        STA     ,X+
        BRA     EMPTY
HALT    BRA     HALT
