* CLOADM BASIC for the Dragon 64 in 32K mode (the socket "basic", d64_1.rom).
* A clean-room BASIC written from scratch for CLOADM: docs/clean-room-basic.md gives the rules, the design
* and the source of every behaviour fact. Built by tools/build-basic.js into a 16K image for $8000-$BFFF.
*
* Conventions: DP is 0 throughout and direct-page variables are addressed with "<". The text pointer TXTPTR
* points at the last character taken; CHRGET advances past spaces and returns the next one.

        SETDP   0

* ---------------- hardware [HW] ----------------
PIA0A   EQU     $FF00           ; keyboard rows (in), bit 7 the joystick comparator
PIA0CA  EQU     $FF01
PIA0B   EQU     $FF02           ; keyboard columns (out)
PIA0CB  EQU     $FF03           ; CB1: the VDG's field sync
PIA1A   EQU     $FF20           ; DAC (bits 2-7), cassette in (bit 0)
PIA1CA  EQU     $FF21           ; CA2: cassette motor
PIA1B   EQU     $FF22           ; VDG mode (bits 3-7), ROM select (bit 2), sound (bit 1)
PIA1CB  EQU     $FF23           ; CB2: sound enable
SAMF1S  EQU     $FFC9           ; SAM display offset bit F1 set: the text screen at $0400
SAMM1S  EQU     $FFDD           ; SAM memory size bit M1 set: 64K dynamic RAM

* ---------------- RAM layout (our own; docs/clean-room-basic.md section 3) ----------------
SCREEN  EQU     $0400           ; the 32 x 16 text screen
SCREND  EQU     $0600
PROGST  EQU     $1E01           ; the program starts here (the byte before it is 0)
RAMTOP  EQU     $8000           ; one past the top of the RAM BASIC uses in 32K mode
STRDEF  EQU     200             ; the default string space

LINBUF  EQU     $0200           ; the typed line (250 characters and a 0)
LINMAX  EQU     250
CRNBUF  EQU     $0300           ; the crunched line
FBUFFR  EQU     $0180           ; number to text conversion (40 bytes)

* RAM jump vectors: each a JMP to the handler, so a program can take over an interrupt
VIRQ    EQU     $0100
VFIRQ   EQU     $0103
VNMI    EQU     $0106
VSWI    EQU     $0109
VSWI2   EQU     $010C
VSWI3   EQU     $010F
USRTAB  EQU     $0112           ; DEFUSR0-9 addresses (20 bytes, to $0125)
ROLLTB  EQU     $0126           ; keys down per column at the last scan (8 bytes)

* ---------------- direct page ----------------
        ORG     $0000
TXTPTR  RMB     2               ; text pointer: the last character taken
CURLIN  RMB     2               ; the line running; $FFFF in direct mode
TXTTAB  RMB     2               ; the start of the program
VARTAB  RMB     2               ; the start of the simple variables (the end of the program + 1)
ARYTAB  RMB     2               ; the start of the arrays
ARYEND  RMB     2               ; the end of the arrays: free memory from here
FRETOP  RMB     2               ; the lowest string in use (strings are allocated downward)
STRBOT  RMB     2               ; the bottom of the string space (also the stack's top)
MEMTOP  RMB     2               ; one past the top of the string space
OLDLIN  RMB     2               ; CONT: the line and text pointer to go on from; OLDTXT 0 = cannot continue
OLDTXT  RMB     2
DATLIN  RMB     2               ; READ: the line of the DATA being read, and the pointer into it
DATPTR  RMB     2
CURPOS  RMB     2               ; the cursor's screen address
TIMER   RMB     2               ; counts fields (50 Hz)
WARMFL  RMB     1               ; $55 after a cold start: the reset button keeps the program
CASEFL  RMB     1               ; 0 upper case, $FF lower case (SHIFT-0)
TRCFLG  RMB     1               ; TRON
KEYTMP  RMB     2               ; keyboard scan workspace
BINVAL  RMB     2               ; a line number or 16-bit value being read
TMPPTR  RMB     2               ; scratch pointers
TMPPT2  RMB     2
TMPCNT  RMB     2
INQUOT  RMB     1               ; crunch: inside quotes / DATA
DIRFLG  RMB     1               ; nonzero while a direct-mode line runs
JMPFLG  RMB     1               ; a statement jumped: TXTPTR is the byte before a line's text
CONTMD  RMB     1               ; how CONT goes on (interp.inc)
KWLEN   RMB     1               ; crunch: the best keyword's length, token, table
KWTOK   RMB     1
KWFN    RMB     1
KWTMP   RMB     1
DPEND   RMB     0

* ---------------- the ROM ----------------
        ORG     $8100
        INCLUDE "boot.inc"
        INCLUDE "screen.inc"
        INCLUDE "keyboard.inc"
        INCLUDE "lineinput.inc"
        INCLUDE "errors.inc"
        INCLUDE "interp.inc"
        INCLUDE "program.inc"
        INCLUDE "crunch.inc"
        INCLUDE "tokens.inc"
ROMEND  RMB     0

* the hardware vectors ($FFF2-$FFFF reads $BFF2-$BFFF) [HW]
        ORG     $BFF2
        FDB     VSWI3,VSWI2,VFIRQ,VIRQ,VSWI,VNMI,RESET
