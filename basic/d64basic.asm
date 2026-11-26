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
RAMTOP  EQU     $8000           ; one past the top of the RAM BASIC uses in 32K mode (CLEAR's highest top [OWN])
STRTOP  EQU     $7FFE           ; the string space's top at a cold start [BB bb3 ram-pointers: $27 is 32766]
STRDEF  EQU     200             ; the default string space

LINBUF  EQU     $0200           ; the typed line (250 characters and a 0)
LINMAX  EQU     250
CRNBUF  EQU     $0300           ; the crunched line

* ---------------- system RAM, $0100-$01FF: laid out one after another, so nothing overlaps ----------------
* (TIMER falls at $0112 after the vectors; the region SYSR1 ends at or below one fixed address:)
CASEFL  EQU     $0149           ; lower case (SHIFT-0): 255 upper case, 0 lower case [BB bb6 famous-pokes]
        ORG     $0100
* RAM jump vectors: each a JMP to the handler, so a program can take over an interrupt
VIRQ    RMB     3
VFIRQ   RMB     3
VNMI    RMB     3
VSWI    RMB     3
VSWI2   RMB     3
VSWI3   RMB     3
TIMER   RMB     2               ; counts fields (50 Hz): $0112, as on the original [BB bb3 ram-pointers, bb6]
USRTAB  RMB     20              ; DEF USR0-9 addresses
ROLLTB  RMB     8               ; keys down per column at the last scan
FORSTP  RMB     5               ; FOR: the step and the limit, packed, before they go on the stack
FORLIM  RMB     5               ; (FOR pushes them as one: FORSTP must come just before FORLIM)
* the cassette (cassette.inc): a namefile block's contents, in its order [FMT]
CNAME   RMB     8               ; the file name, padded with spaces
CFTYP   RMB     1               ; the file type: 0 BASIC, 2 machine code
CFASC   RMB     1               ; $FF: saved as text
CFGAP   RMB     1               ; $FF: the motor stops between blocks
CFEXEC  RMB     2               ; the exec address
CFLOAD  RMB     2               ; the load address
SYSR1   RMB     0               ; (at or below CASEFL)
        ORG     CASEFL+1
FPT1    RMB     5               ; packed temporaries of the numeric functions (mathfn.inc; FPRUN finds FPTn as
FPT2    RMB     5               ; FPT1 + 5 (n - 1): they stay together)
FPT3    RMB     5
FPT4    RMB     5
FPT5    RMB     5
FPT6    RMB     5
POLYV   RMB     5               ; POLY's variable
TMPDSC  RMB     8*5             ; the temporary string descriptors (strings.inc)
TMPEND  RMB     0
FBUFFR  RMB     64              ; number to text (FOUT) and PRINT USING's work (FBUFFR+20 on)
* graphics (gfx.inc, sgfx.inc)
FGCOL   RMB     1               ; the foreground and background colours, 0-8 (FGCOL must come just before BGCOL)
BGCOL   RMB     1
GCSS    RMB     1               ; the colour set SCREEN last chose, x 4
LASTX   RMB     2               ; the last point drawn (16-bit x, then y)
LASTY   RMB     2
GXY     RMB     4               ; a point read (x, y; 16-bit each)
* sound (sound.inc, play.inc)
JOYV    RMB     4               ; JOYSTK(0)-(3) as JOYSTK(0) last read them
PLOCT   RMB     1               ; PLAY: the octave and the length (PLOCT must come just before PLLEN)
PLLEN   RMB     1
PLTMP   RMB     1               ; the tempo, and the volume x 4 (PLTMP must come just before PLVOL)
PLVOL   RMB     1
PLDOT   RMB     1               ; the length's dots
SYSEND  RMB     0               ; (must stay at or below LINBUF: tools/build-basic.js checks it)

* ---------------- direct page ----------------
* Fixed addresses that programs read and write, at the original's places [BB: bb3 ram-pointers, bb6 famous-pokes;
* OWNER-SPEC for the cursor's; docs/clean-room-basic.md, "The direct page"]. The other variables fill the regions
* between them in order; tools/build-basic.js fails if a region (its end marker DPRn) runs into the fixed address
* after it, so a variable added to a full region has to go to another one.
TXTTAB  EQU     $0019           ; the start of the program
VARTAB  EQU     $001B           ; the start of the simple variables (the end of the program + 1)
ARYTAB  EQU     $001D           ; the start of the arrays
ARYEND  EQU     $001F           ; the end of the arrays: free memory from here
STRBOT  EQU     $0021           ; the bottom of the string space (also the stack's top)
FRETOP  EQU     $0023           ; the lowest string in use (strings are allocated downward)
FORVAR  EQU     $0025           ; FOR, NEXT: the variable's address ($25 on the original: not yet known [OWN])
MEMTOP  EQU     $0027           ; one past the top of the string space
CURLIN  EQU     $0068           ; the line running; $FFFF in direct mode
DEVNUM  EQU     $006F           ; where output goes: 0 the screen, $FF the tape (CSAVE ,A); any other value the
*                                 screen too (the original's $FE, the printer, is not built) [OWN]
WARMFL  EQU     $0071           ; $55 after a cold start: the reset button keeps the program
CURPOS  EQU     $0088           ; the cursor's screen address (16 bits)
BLINK   EQU     $008F           ; the cursor's blink countdown
KEYDLY  EQU     $0097           ; the keyboard's debounce delay, in passes (16 bits)
TXTPTR  EQU     $00A6           ; text pointer: the last character taken
TRCFLG  EQU     $00AF           ; TRON: 79 on, 0 off
        ORG     $0000
OLDLIN  RMB     2               ; CONT: the line and text pointer to go on from; OLDTXT 0 = cannot continue
OLDTXT  RMB     2
DATLIN  RMB     2               ; READ: the line of the DATA being read, and the pointer into it
DATPTR  RMB     2
KEYTMP  RMB     2               ; keyboard scan workspace
BINVAL  RMB     2               ; a line number or 16-bit value being read
TMPPTR  RMB     2               ; scratch pointers
TMPPT2  RMB     2
TMPCNT  RMB     2
INQUOT  RMB     1               ; crunch: inside quotes / DATA
JMPFLG  RMB     1               ; a statement jumped: TXTPTR is the byte before a line's text
CONTMD  RMB     1               ; how CONT goes on (interp.inc)
KWLEN   RMB     1               ; crunch: the best keyword's length, token, table
KWTOK   RMB     1
KWFN    RMB     1
KWTMP   RMB     1
DPR1    RMB     0               ; (at or below TXTTAB)
        ORG     MEMTOP+2
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
DPR2    RMB     0               ; (at or below CURLIN)
        ORG     CURLIN+2
DSCTMP  RMB     5               ; a descriptor being built
DPR3    RMB     0               ; (at or below DEVNUM)
        ORG     DEVNUM+1
VARCRE  RMB     1               ; PTRGET: make a simple variable that does not exist
DPR4    RMB     0               ; (at or below WARMFL)
        ORG     WARMFL+1
VARNAM  RMB     2               ; PTRGET: the name
DIMFLG  RMB     1               ; PTRGET: DIM
NDIMS   RMB     1               ; the subscripts of an array reference
INTVAL  RMB     2               ; an integer operand
NXRET   RMB     2               ; NEXT: its return address
GCTOP   RMB     2               ; the garbage collector
GCLIM   RMB     2
GCBEST  RMB     2
GCADR   RMB     2
GCDONE  RMB     1
SBSTRT  RMB     1               ; LEFT$, RIGHT$, MID$: the start and the count
SBCNT   RMB     1
FRACNZ  RMB     1               ; FTRUNC: a fraction was dropped; the sign
TRSGN   RMB     1
FPK2    RMB     1
LOGE    EQU     FPK2            ; LOG's power of 2 (LOG, SIN and ATN each finish before another starts:
*                                 one byte serves them all)
QUAD    EQU     FPK2            ; SIN's quarter
ATSGN   EQU     FPK2            ; ATN
DPR5    RMB     0               ; (at or below CURPOS)
        ORG     CURPOS+2
ATINV   RMB     1
ATADD   RMB     1
PWSGN   RMB     1               ; ^ by a whole number
PWN     RMB     2
DPR6    RMB     0               ; (at or below BLINK)
        ORG     BLINK+1
EXECAD  RMB     2               ; EXEC's address
INPVAR  RMB     2               ; INPUT: the text pointer in the variable list, its start
INPST   RMB     2
ITMCOL  RMB     1               ; GETITM: ':' ends an item (DATA)
DPR7    RMB     0               ; (at or below KEYDLY)
        ORG     KEYDLY+2
SEED    RMB     4               ; RND's seed, low byte first
RNDR    EQU     PROD            ; (RND's product is in the seed before its arithmetic uses PROD)
INPKND  RMB     1               ; INPUT 1, LINE INPUT 0
INPPTR  RMB     2               ; INPUT: the pointer in the typed line
CNLEN   RMB     1               ; the cassette (cassette.inc): the name's length, 0 for any file
CBTYP   RMB     1               ; a block's type and length (CBLEN must follow CBTYP)
CBLEN   RMB     1
CBCNT   RMB     1               ; the bytes still to read
CSUM    RMB     1               ; the checksum
CBYTE   RMB     1               ; the byte being read
DPR8    RMB     0               ; (at or below TXTPTR)
        ORG     TXTPTR+2
CCNT    RMB     1               ; its bits still to read
CLEAD   RMB     1               ; a leader has been heard
CLDBAS  RMB     1               ; a program is being loaded (2: a text line had no number); $FF: a file left open
CBIDX   RMB     1               ; the bytes in the text block
CEND    RMB     2               ; the end of the data to write; CLOADM's offset
LSTCNT  RMB     1               ; LIST: the characters of the line's text shown so far
DPR9    RMB     0               ; (at or below TRCFLG)
        ORG     TRCFLG+1
USDSC   RMB     2               ; PRINT USING: the format's descriptor, the place in it
USPOS   RMB     1
USANY   RMB     1               ; a field was met
USKIND  RMB     1               ; the field: 0 a number, 1 !, 2 %..%
USNB    RMB     1               ; digits before and after the point
USNA    RMB     1
USFLG   RMB     1
USNEG   RMB     1
USK     RMB     1
USW     RMB     1
USEXP   RMB     2
* ON's and RENUM's work shares PRINT USING's bytes: each is used inside its one statement only, after its
* expressions are evaluated (ON) or with none (RENUM), and no expression runs a statement
ONCNT   EQU     USDSC           ; ON
ONKIND  EQU     USDSC+1
ONFND   EQU     USPOS
ONLINE  EQU     USANY           ; (2 bytes)
RNNEW   EQU     USDSC           ; RENUM: the first new number, the first old one, the step
RNOLD   EQU     USPOS
RNINC   EQU     USKIND
RNLEN   EQU     USNA            ; RENUM: a reference's digits
* and so does the work of DRAW and its command string (mini.inc, draw.inc) and of GET and PUT (getput.inc): each
* inside its one statement; the expressions they evaluate (=var; in a command string, the corners) run no PRINT
MSPTR   EQU     USDSC           ; the command string: the next character, the characters left, the X substrings
MSCNT   EQU     USPOS           ; open (their places are on the stack)
MSDEP   EQU     USANY
DRFLG   EQU     USKIND          ; DRAW: the prefixes for the next move (1: B, 2: N), a move's length
DRLEN   EQU     USEXP
GPDIR   EQU     USNB            ; GET ($FF) or PUT (0); the action (a truth table); the rows; the array's next bit
GPLUT   EQU     USNA
GPROWS  EQU     USNEG
GPRB    EQU     USK
BASESP  RMB     2               ; the stack the OK prompt and CONT use: frames above it survive a STOP
FRMSP   RMB     2               ; the stack and the text at the start of the statement running
STMTXT  RMB     2
GMENT   RMB     2               ; graphics (gfx.inc): the current mode's GMTAB entry, its start page's address,
GBEG    RMB     2               ; and the colour byte the plot routine writes
GCOLB   RMB     1
DRANG   RMB     1               ; DRAW's angle (0-3 quarter turns) and scale (1-62, in quarters), kept from one DRAW
DRSCL   RMB     1               ; to the next (draw.inc)
DPEND   RMB     0

* Two-byte calls: a JMP to each of the ROM's busiest routines at the top of the direct page, just below the RAM
* vectors and copied with them at a cold start (boot.inc), so "JSR <ZCHRGET" does for "JSR CHRGET"
* (tools/build-basic.js checks the direct-page variables end below them)
        ORG     $0100-3*10
ZTRAMP  RMB     0
ZCHRGET  RMB     3
ZCHRGOT  RMB     3
ZCHROUT  RMB     3
ZFNARGN  RMB     3
ZFPRUN   RMB     3
ZPRTSTR  RMB     3
ZLINGET  RMB     3
ZCHKCOM  RMB     3
ZUSCHR   RMB     3
ZEVNUM   RMB     3

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
        INCLUDE "gfx.inc"
        INCLUDE "sgfx.inc"
        INCLUDE "line.inc"
        INCLUDE "circle.inc"
        INCLUDE "paint.inc"
        INCLUDE "mini.inc"
        INCLUDE "draw.inc"
        INCLUDE "getput.inc"
        INCLUDE "io.inc"
        INCLUDE "using.inc"
        INCLUDE "cassette.inc"
        INCLUDE "fp.inc"
        INCLUDE "fpconv.inc"
        INCLUDE "sound.inc"
        INCLUDE "play.inc"
        INCLUDE "tokens.inc"
ROMEND  RMB     0

* the hardware vectors ($FFF2-$FFFF reads $BFF2-$BFFF) [HW]
        ORG     $BFF2
        FDB     VSWI3,VSWI2,VFIRQ,VIRQ,VSWI,VNMI,RESET
