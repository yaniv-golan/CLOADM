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
* $0130-$0157: the temporary string descriptors (strings.inc)
FORSTP  EQU     $0158           ; FOR: the step and the limit, packed, before they go on the stack
FORLIM  EQU     $015D

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
* the floating-point accumulators (fp.inc): exponent, mantissa (4), guard byte, sign; ARG laid out as FAC
FACEXP  RMB     1
FACM    RMB     4
FACEXT  RMB     1
FACSGN  RMB     1
ARGEXP  RMB     1
ARGM    RMB     4
ARGEXT  RMB     1
ARGSGN  RMB     1
FPEXP   RMB     2               ; a result's exponent, in 16 bits
FPI     RMB     1               ; loop counters
FPJ     RMB     1
PROD    RMB     8               ; the product; the quotient
DVR     RMB     5               ; the remainder
FPE10   RMB     2               ; decimal exponent (FOUT, FIN)
FPDIG   RMB     9               ; FOUT's nine digits
FPND    RMB     1               ; FOUT's significant digits
FPCNT   RMB     1
FPK     RMB     1               ; FOUT's power of ten
FPN     RMB     4               ; FIN's integer
FPEX    RMB     2               ; FIN's exponent, and its sign
FPEXS   RMB     1
FPSGNI  RMB     1               ; FIN's sign
FPDP    RMB     1               ; FIN: a point seen
FPDROP  RMB     1               ; FIN: a digit dropped
VALTYP  RMB     1               ; the value just evaluated: 0 a number, $FF a string
STRPTR  RMB     2               ; a string value: its descriptor
ARGSTR  RMB     2               ; the left operand when it is a string
LEFTTY  RMB     1               ; the left operand's type
TEMPPT  RMB     2               ; the next free temporary descriptor
DSCTMP  RMB     5               ; a descriptor being built
VARNAM  RMB     2               ; PTRGET: the name
VARCRE  RMB     1               ; PTRGET: make a simple variable that does not exist
DIMFLG  RMB     1               ; PTRGET: DIM
NDIMS   RMB     1               ; the subscripts of an array reference
INTVAL  RMB     2               ; an integer operand
FORVAR  RMB     2               ; FOR, NEXT: the variable's address
NXRET   RMB     2               ; NEXT: its return address
ONCNT   RMB     1               ; ON
ONKIND  RMB     1
ONFND   RMB     1
ONLINE  RMB     2
GCTOP   RMB     2               ; the garbage collector
GCLIM   RMB     2
GCBEST  RMB     2
GCADR   RMB     2
GCDONE  RMB     1
SBSTRT  RMB     1               ; LEFT$, RIGHT$, MID$: the start and the count
SBCNT   RMB     1
FRACNZ  RMB     1               ; FTRUNC: a fraction was dropped; the sign
TRSGN   RMB     1
FPK2    RMB     1               ; SQR's count
LOGE    RMB     1               ; LOG's power of 2
EXPN    RMB     1               ; EXP's power of 2
QUAD    RMB     1               ; SIN's quarter
ATSGN   RMB     1               ; ATN
ATINV   RMB     1
ATADD   RMB     1
PWSGN   RMB     1               ; ^ by a whole number
PWN     RMB     2
SEED    RMB     4               ; RND's seed, low byte first
RNDR    RMB     4
EXECAD  RMB     2               ; EXEC's address
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
        INCLUDE "vars.inc"
        INCLUDE "expr.inc"
        INCLUDE "strings.inc"
        INCLUDE "print.inc"
        INCLUDE "flow.inc"
        INCLUDE "strfunc.inc"
        INCLUDE "mathfn.inc"
        INCLUDE "misc.inc"
        INCLUDE "fp.inc"
        INCLUDE "fpconv.inc"
        INCLUDE "tokens.inc"
ROMEND  RMB     0

* the hardware vectors ($FFF2-$FFFF reads $BFF2-$BFFF) [HW]
        ORG     $BFF2
        FDB     VSWI3,VSWI2,VFIRQ,VIRQ,VSWI,VNMI,RESET
