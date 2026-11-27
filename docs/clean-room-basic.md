# Clean-room BASIC for the Dragon 64 (P1: the language)

[CLOADM](../README.md) › Clean-room BASIC

A BASIC ROM for the Dragon 64's 32K mode (the socket `basic`, file name `d64_1.rom`), written from scratch in 6809
assembly for CLOADM, so that people without a ROM dump still get BASIC. It must run Dragon 64 BASIC programs the
way the original does. The work has three phases:

| Phase | Scope |
|---|---|
| **P1** (this document) | the language: cold start, the editor, program storage, the interpreter, floating point, the numeric and string functions, PRINT / INPUT / DATA, errors, PEEK / POKE / EXEC / USR, the text screen and the keyboard. Cassette if it fits, otherwise P1b |
| P2 | graphics (PMODE, PCLS, LINE, CIRCLE, DRAW, PAINT, GET / PUT, ...) and sound (SOUND, PLAY, AUDIO) |
| P3 | compatibility for machine-code programs that call fixed ROM addresses or read BASIC's RAM variables, ranked by a separate census |

## 1. Clean-room rules

These are hard rules for everyone who works on this ROM.

* **Never seen:** any BASIC or DOS ROM image, its bytes, a disassembly or listing of one ("Color BASIC Unravelled",
  "Dragon Unravelled", "Inside the Dragon"'s ROM chapters, annotated sources, MAME or XRoar ROM tables), and the
  tables in `js/media/basic.js` and `tests/fixtures/basic-standin.js`, which cite those books. Nobody on this work
  opens them for this work.
* **Allowed sources** (every fact used is logged in [section 11](#11-provenance-log) with its source):
  * **[UM]** published user documentation of the language: the Dragon 32 and Dragon 64 user manuals, BASIC
    reference manuals and tutorials written for users;
  * **[6809]** general knowledge of the 6809 (Motorola's data sheet and programming manual);
  * **[MBF]** published descriptions of the Microsoft Binary Format (5-byte floating point);
  * **[BB]** black-box observations: programs run on a real ROM by a separate party (a maintainer, on their own
    machine), of which we only see the recorded screen text ([section 7](#7-black-box-comparison));
  * **[FMT]** published descriptions of the cassette file format (the bit encoding, the block layout, the
    namefile's fields), never a ROM's code; the repository's own tape code (`js/media/cassette.js`) may be run as an
    oracle;
  * **[HW]** the hardware as this repository already models it from data sheets: SAM, VDG, PIAs, the keyboard
    matrix (`js/machines/keyboards.js`);
  * **[OWNER-SPEC]** a functional specification supplied by the maintainer (2026-11-25): a description of
    behaviour written by a separate party (the firewall of a two-team clean room), used where black-box
    observations say nothing. The facts this ROM takes from it are in [section 14](#14-the-cursor);
  * **[DOC]** published documentation of the machine-code interface: Dragon Data Ltd, "Dragon 32 Information for
    Machine Code Users!" (March 1983; the scan at colorcomputerarchive.com, SHA-256 `19de5481...d44ac`, read from its
    page images), and published memory maps. Only what the pages say (an address and what calling it does), never a
    routine's code;
  * **[OWN]** our own decisions, where nothing visible to a BASIC program depends on them.
* **No ROM of any kind** in the repository, CI or tests other than our own: the image this source builds is
  committed as `basic/cloadm-basic-d64.rom` ([open question 1](#10-open-questions)). The public suite passes with no other ROM.
* **Only functional results are recorded.** Expected results in the repository are what our test programs print,
  their error messages, and bytes our programs write to RAM; never a value read from the original ROM's addresses
  (`$8000-$FEFF`). A black-box case must not read the ROM in any way: `tools/basic-bb/lint.js` refuses one that could,
  and the harness stops one that runs code it wrote (section 7), so the outputs we receive never carry ROM contents.

## 2. Source and build

* **Source:** `basic/` at the repository root (not served, so not in `sw.js`): `basic/d64basic.asm` is the main file,
  which `INCLUDE`s one file per module (section 4). Plain 6809 assembly for the repository's own assembler
  (`js/asm/`), no macros, no conditional assembly beyond the assembler's `IF` on defines.
* **Build:** `tools/build-basic.js` assembles it with `Emu.assemble(src, '6809', { include })`, lays the segments into
  a 16 K image for `$8000-$BFFF` (unused bytes `$FF`), and fails if any segment falls outside that range or two
  segments overlap. It exports `buildBasic() -> { rom, symbols, listing }` for the tests, and run on its own writes
  the image to `basic/cloadm-basic-d64.rom` (committed; `--out FILE` writes elsewhere). The committed file has a name
  of its own, never the original ROM's (`d64_1.rom`): it must not be taken for a dump of the original, and a folder of
  ROMs given to `--roms` must not have it claim the socket by name beside the person's own dump. To run it there, write
  a copy under the socket's name (`--out d64_1.rom`), where it shows as "loaded, unrecognised". The
  keyword table (`basic/tokens.json`) and the mathematical constants (`tools/basic-consts.js`) become generated
  includes. There is no browser build step: nothing under `js/` changes for P1.
* **Size budget:** P1 is planned at about 11-12 K of the 16 K, leaving room for P2's graphics and sound (the original
  fits all of it in 16 K, so ours must be compact) and for P3's fixed addresses. With the cassette in, and after a
  size pass that changed no behaviour, it is 12,400 bytes: the code ends at `$B162`, 3,728 bytes below the vectors
  (`node tools/basic-size.js`). What the size pass relies on [OWN]:
  * **Two-byte calls.** Sixteen busy routines each have a `JMP` at the top of the direct page (`ZTRAMP`, `$D0-$FF`),
    so a call is `JSR <ZCHRGET`: two bytes for three, and three cycles more. The first size pass made ten (`CHRGET`,
    `CHRGOT`, `CHROUT`, `FNARGN`, `FPRUN`, `PRTSTR`, `LINGET`, `CHKCOM`, `USCHR`, `EVNUM`, at `$E2-$FF`), the second
    six more below them (`GETBYT`, `SNERR`, `RPAREN`, `FCERR`, `CHKNUM`, `MOVMF`, at `$D0-$E1`); none is called from
    timed code. The `JMP`s are written at a cold start from a list of addresses in the ROM (`ZINIT`, `boot.inc`), the
    RAM vectors' with them. `tools/build-basic.js` fails if the direct-page variables reach them.
  * **Scratch bytes shared.** `ON`'s, `RENUM`'s, `DRAW`'s, `PAINT`'s and `GET`/`PUT`'s work uses `PRINT USING`'s
    bytes; `LOG`, `EXP`, `SIN` and `ATN` share one byte; `RND`'s product is in `PROD`. Each is used inside one
    statement or function that finishes before another of them starts (`d64basic.asm` says so at each).
  * **`FPRUN`** (`mathfn.inc`) runs a list of one-byte steps (store, load, multiply, add, divide, subtract, each
    with a temporary or a constant), in place of a load and a call for each step. The numeric functions do the same
    operations in the same order as before, so their results are the same bits.
  * **Two tables for five series.** A series with alternating signs is evaluated in -x^2 with unsigned coefficients;
    every step of Horner's rule then differs from the signed one only in its sign, and the result is the same bits.
  * A line number is printed by `PRINT USING`'s decimal converter (`U32DEC`), which uses `FACM`: line numbers are
    only printed between statements. `FOUT` makes its nine digits with it too (the integer is always 100000000 to
    999999999), so there is no table of powers of ten for digits.
  * **A second size pass** (no behaviour changed; the black-box records compare as before) took the image, with all
    of P2 and the low-RAM layout in, from 16,040 to 15,157 bytes: the code ends at `$BC27`, 971 bytes below the
    vectors. Besides the six two-byte calls and `FOUT`'s digits: one scanner (`NXTOK`) for `IF`'s `ELSE`, `RENUM`
    and `READ`; a quoted `DATA` or `INPUT` item read by `STRLIT`; the graphics colours and last point in the direct
    page (`FOUT`'s digits, reached by index only, in the system block instead); `RND`'s multiplication by `FMUL`'s
    64-bit product (`MULMAN`); one sign reader and a multiply-by-ten-and-add for `FIN`; one adjuster for the decimal
    exponent; `MUL16` with two `MUL`s. `PLAY`'s settings stay in the system block: moving them would shorten the gap
    between notes. Its second part (15,531 to 15,157) is many small pieces of the same kind: tails and loops shared (`ON`'s
    `GOSUB` frame, one mover for the program's lines, one array search, one reader for an optional colour and for a
    point), the error entries and `(`, `)`, `,` checks chained with `$8C`, messages printed from the text after
    their call (`PRMSG`), more of the numeric functions' steps as `FPRUN` steps, the PIAs set from a table at
    reset, and long jumps a short branch reaches. The timed code is as it was: the field interrupt, the tone loop,
    the keyboard scan and its delays, the cassette's bit loops.
  * **A speed pass** (no result changed: the same floating-point bits, screens and records; only timing moves) made
    the interpreter's hot path cheaper after a cycle profile of `FOR`/`NEXT`, by the black-box measure of
    `famous-pokes` ([BB] bb6): 2000 empty passes took the original 113 fields and ours 142. `ROUND` returns at once
    when the guard byte is 0; `MOVFM` and `MOVAM` store to the direct page; `NEXT` compares the variable with the
    limit packed (`NXCMP`: two non-zero numbers of one sign; the others through `FCMPM`); the statement loop clears
    the string temporaries itself and `EXECST` dispatches with `LDX A,X` (so a statement token ends at `$BF`, which
    `tools/build-basic.js` checks). `famous-pokes` now gives 119 fields (bb2's `snd-timer` 500-pass loop: 30 against
    the original's 29); 15,568 bytes, the code ending at `$BDC2`, 560 bytes below the vectors. `FDIV` keeps its
    restoring division and its 41 quotient bits but compares before it subtracts, on a 32-bit remainder whose bit 32
    is one byte, and rotates the bits into the quotient a byte at a time: about 3,900 cycles a division where it took
    5,900 (the mean over random operands), landed once `ram-pointers2` gave the original's figure ([BB] 2026-11-26:
    500 passes of `X=I/3`, 177 fields; ours 294, now 232; reading a constant divides by ten, so `X=I+2.5` and
    `X=I*2.5` gain too). Ours is never to be faster than the original, since loops time games:
    after this pass 500 `GOSUB`/`RETURN` passes took 79 fields against the original's 83 ([BB] `ram-pointers2`), so
    `GOSUB` waits 142 cycles more (`GSDLY`, a counted delay in `GOSUB1`, `ON ... GOSUB` too) and takes 83.
    That made 15,572 bytes, the code ending at `$BDC6`.
  * **The original's speed on eight loops** ([BB] `ram-pointers2`, 2026-11-26: its timing program, each loop started
    just after a field begins, counted in fields of 17,784 cycles). No result changed here either. Ours takes the
    original's count on each, and `tests/basic-ram.test.js` checks every one: the original's count or up to two
    fields more, never fewer.

    | Loop | Passes | The original | Ours before | Ours now |
    |---|---|---|---|---|
    | `FOR I=1 TO n:NEXT` | 2000 | 113 | 118 | 113 |
    | `X=I+2.5` | 500 | 205 | 259 | 205 |
    | `X=I*2.5` | 500 | 224 | 257 | 224 |
    | `X=I/3` | 500 | 177 | 232 | 177 |
    | `A$=STR$(I)` | 300 | 174 | 285 | 174 |
    | `GOSUB 200` (`200 RETURN`) | 500 | 83 | 83 | 83 |
    | `I=I+1:IF I<1000 THEN 80` | 999 | 516 | 518 | 516 |
    | `B$=MID$("HELLO",2,2)+"X"` | 300 | 137 | 176 | 137 |

    What was made faster: the expression levels keep the character after an operand in A instead of each reading
    it again (`EVAL` reads it once, each level again only after its own operation); `FDIV` holds the remainder's top
    half in D and its bit 32 in the carry, and marks each quotient byte's end with a bit instead of a counter (about
    2,600 cycles a division, the mean over random operands, where it took 3,900); `FADD` shifts whichever number has
    the smaller exponent where it is instead of exchanging the two first; `NORM` moves bytes two at a time and
    shifts a number with nothing below its top byte (a small whole number) in the registers; `FIN` gathers its
    digits in `FACM` itself; `MOVFM`, `MOVAM` and `MOVMF` no longer save D; `QINT` shifts a number below 256 in A;
    `GETSPA` and `FRETMP` push less. `FOUT` gives a whole
    number below 1E9 its digits as they are (`QINT`, then the decimal converter), without scaling it to nine
    digits by steps of ten: the same digits, since each of those steps is exact for a whole number
    (`FONINE` keeps the scaling for `PRINT USING`'s exponent form, which reads all nine digits). Where that left
    ours faster than the original, a counted delay brings it back, as `GSDLY` did: `IFDLY` in `IF`, `ADDDLY` before
    an addition or subtraction in an expression, `MULDLY` before a product, `FOIDLY` in `FOUT`'s whole-number path,
    11 cycles before a quotient, and `GSDLY` is now 39 steps (all since refitted or replaced by the cost model below). The own case `expr-levels` holds the expression
    levels to it (a signed operand after a relation, an operator after a `NOT`'s operand, `NOT` after `AND` and
    `OR`; a `NOT` straight after a relation or another operator, `1<NOT 0`, was `?SN ERROR` on ours, before and
    after this change: the original takes it, [BB bb9 expr-not], and ours now does, section 11 row 52; with row 53's `PRINT USING`
    fixes, 66 bytes more: 15,905, the code ending at `$BF13`). With all of it,
    15,618 bytes (46 more), the code ending at `$BDF4`, 510 bytes below the vectors. The delays match these eight
    loops only: another program may run a little faster or slower than on the original, and a sound whose length
    hangs on where in a field it starts can come out differently (`snd-play-length`'s `T64` note now ends before a
    whole period, where the original's lasts three; a phase, not a different behaviour). Left: a cheaper `BREAK` test between statements (not used for
    these loops: about 55 cycles a statement for 18 bytes, and every loop would then need a delay, or a longer
    one, to stay at the original's count).
  * **Digits in a constant** ([BB] bb8 `cas-cloadm2`, bb3 `crunch-else`). Three PEEK loops ran far faster on ours
    than on the original, none of their statements among the eight loops: `cas-cloadm2`'s `FOR I=0 TO
    1022:P=PEEK(I AND 32767):IF P=112 OR P=114 THEN ...` (A: 1023 passes, run three times), its direct `S=0:FOR I=0
    TO 599:S=S+PEEK(28928+I AND 32767):NEXT` (B: 600 passes) and `crunch-else`'s `FOR I=7000 TO 9000:IF PEEK(I AND
    32767)=131 AND PEEK(I+1 AND 32767)=88 THEN ...` (C: 743 passes). The records' frames time them, the typist being
    paced alike on both: for A, from the `S` a `CLOADM`'s search shows to the screen the next `CLOADM` clears (or from
    the start, less the 63 or so fields every bb5-bb8 case starts later on the original); for B, from `BIGMC`'s last
    top-row flag to the case's end; for C, the whole case less the 62 fields of every bb3 case. Ours was short by
    324-326, 186 and 328 fields: about 700 cycles a digit. That first wait (`FIDLY`, one cost for a digit that is not
    0, before the point, after a digit that was not 0) was a guess the bb10 probes below replace.
  * **The original's cost model** ([BB] bb10 `time-literals`, `time-ops`, `time-mul`, `time-int`, `time-motor`; bb9
    `rnd-timing`). Each probe is loops of 500 or 1000 passes that differ in one item, each started just after a field
    begins, counted in fields of 17,784 cycles (one field is 18 cycles a pass in 1000 passes, so a difference of two
    counts is good to about 25 cycles). Fitted to them, in cycles, with the residuals:

    | Item | The original's cost | Residual | Evidence |
    |---|---|---|---|
    | A digit that is not 0, the number so far not 0 | 906 + 102 for each byte of the number so far + 66 for each place the digit is below 8 (1: three, 2-3: two, 4-7: one, 8-9: none) | 33 at most over six differences (11, 111, 11111, 655361 against 1; `VAL` and `READ` of 32767 against 1) | `time-literals`, `time-ops` |
    | A 0 after a digit | 925 (`X=10`), 971 (`X=105`), 1001 (`X=1005`, each of two) | | `time-literals` |
    | The same in `VAL` and `READ` | `VAL("32767")` and `READ` of `DATA 32767` both 257 fields over the same with 1: 4,570 cycles for the four digits, as constants' digits | | `time-ops` |
    | The point and a place | 3,202 (`X=1.1` against 11), 3,290 (`X=11.1` against 111); about 700 less where the quotient has few 1s (`X=I+2.5` of `ram-pointers2`: 2.5's quotient by 10 has 2, 1.1's 20) | | `time-literals`, `ram-pointers2` |
    | `Y*Z` | 1,440 + 328 for each byte of Z (the right operand) that is not 0 + 43 for each bit of it set; Y does not count | 21 at most over five operands; each pair both ways round within 2 fields when Z is the same | `time-mul` |
    | `INT` | 835 + 23 for each place it drops (3.5, 1000.5, 1E6+.5, 1E9+.5: 30, 22, 12 and 2 places); 1,191 below 1; 195 more for a negative number with a fraction | 43 | `time-int` |
    | `AND` | 2,720 (`X=I AND 1` against `X=I`), about the same with 32767: its operands' size does not count | | `time-ops` |
    | `PEEK(...)` against `(...)` | 836 | | `time-ops` |
    | `MOTOR ON` | about 25.4 fields, interrupts on (`TIMER` reads 25 after it), and as long again for a second `MOTOR ON` (51); `MOTOR OFF` of a motor that is off takes nothing (0); ten `MOTOR ON:MOTOR OFF` 254; the motor runs 25.44, 50.72 and 25.31 fields | | `time-motor` |

    Two of the probes' items do not fit ours' own structure, and the waits were fitted to all the loops at once
    (each wait's effect on a loop is its steps times the passes, so the fit is linear): the zero digit's cost in `X=10` and
    `X=105` against `ram-pointers2`'s `IF I<1000`, and `READ 32767` and `X=655361` against `cas-cloadm2`'s loop B,
    which hold each other within a field of their bounds. What ours does now, by the same items: `FPNX10` waits
    nothing beyond `FIFST` steps (of 5 cycles) for the first digit and stores it as it is; for another it waits
    `FIDLY` less `FIBYT` for each byte at the top of the number so far that is 0, plus `FINRM` for each place the
    digit is below 8, `FIDP` less after the point, and `FIZERO` for a 0. A quotient while a number's places are read
    waits 14 cycles more for each 1 bit (`FDIV`, the point's flag `FPDP` set). `MULMAN` makes a row of the product for
    each byte of FAC, the right operand, that is not 0 (it was ARG's), each waiting `MBDLY` steps and `MBIT` more for
    each bit set, and a product waits `MULDLY` (`RND`'s seed is FAC there: its time hangs on the seed's bytes and bits,
    as the original's, `rnd-timing`); `RND(n)`'s product has f as its right operand. `FTRUNC` waits 19 cycles for each
    place it drops, `INTB1` x 19 for a number below 1; `QINT`, the conversion to an integer (`AND`, `OR`, `NOT`, an
    address, `GETBYT`, `STR$`), 17 cycles for each place under 16 bits (0 at once); `AND` waits `ANDDLY` (`OR` does
    not). `MOTOR ON` turns the motor on with the interrupts left on and always waits (`MOTDLY`, 25.6 fields). Waits
    the model made unnecessary are gone: `ADDDLY`, `IFDLY`, the 11 cycles before a quotient, `FIN`'s 29-cycle pad. Where
    that left ours faster than the original, ours was made faster still first, so no loop got slower than it had to
    (no result changed: the same bits, screens and records): a relation's -1 or 0 is loaded from a constant, `NORM`
    shifts a number below 65536 in D, `FIN` puts a number below 256 at the top before normalising and stores a first
    digit without multiplying, `SHFTR` makes 6 or 7 places a byte and 2 or 1 back, `FNDLIN` compares in D, `EVAL`'s
    stack check is inline. Then a counted wait for a loop of its own where one was still short: `DIVDLY` (a quotient,
    `X=I/3`), `MIDDLY` (`MID$`), `GSDLY` (52), `FOIDLY` (625), `RNDDLY` (`RND`), and `NXDLY` in `NEXT` for a variable
    below 256 (bb2 `snd-timer`'s 500 empty passes take 29 fields on the original against `ram-pointers2`'s 2000 in 113:
    its early passes cost more; with `SHFTR`'s shorter way ours had them cheaper, 28).

    Every timed loop, before (this pass) and now, against the original, in fields (`tests/basic-timing.test.js` checks
    the probes: the original's count or up to 8% more, never fewer; `tests/basic-ram.test.js` the eight loops, up to
    two more, and `cas-cloadm2`'s spans, up to 1% more):

    | Loop | The original | Ours before | Ours now |
    |---|---|---|---|
    | empty (1000); bb2 `snd-timer`'s typed 500 | 56; 29 | 57; 29 | 56; 29 |
    | `X=1`, `X=11`, `X=10`, `X=111`, `X=11111` | 150, 216, 202, 285, 427 | 163, 216, 177, 270, 381 | 150, 220, 206, 289, 440 |
    | `X=105`, `X=1005`, `X=655361`, `X=1.1`, `X=11.1` | 265, 323, 486, 396, 470 | 231, 257, 400, 357, 414 | 265, 332, 486, 412, 486 |
    | `X=I`, `X=PEEK(I AND 32767)`, `X=(I AND 32767)`, `X=I AND 1`, `X=I+1` | 128, 593, 546, 281, 213 | 136, 553, 511, 251, 245 | 134, 604, 559, 281, 216 |
    | `A$=STR$(I)`, `L=LEN(STR$(I))` (500) | 285, 314 | 293, 318 | 292, 317 |
    | `VAL("32767")`, `VAL("1")`, `READ` 32767, `READ` 1 | 476, 219, 429, 172 | 456, 240, 400, 184 | 481, 226, 429, 173 |
    | `X=Y`; `Y*Z` with Z = 2, 255, all 32 bits, alternate bits, the first and last (Y = Z) | 133; 236, 251, 365, 325, 255 | 142; 269, 266, 313, 311, 280 | 140; 244, 258, 377, 335, 259 |
    | `Y*Z` the other pairs (2·F, F·2, 255·F, F·255, 2·.3, .3·2, 255·.3, .3·255, 2·M, M·2, F·M, M·F) | 367, 236, 363, 251, 325, 236, 322, 251, 256, 236, 253, 365 | 268, 305, 267, 303, 268, 304, 267, 303, 268, 280, 305, 279 | 369, 243, 368, 259, 329, 243, 327, 259, 259, 243, 258, 370 |
    | `X=Y`; `INT` of .5, 3.5, 1000.5, 1E6+.5, 1E9+.5, -1000.5 | 132; 199, 217, 208, 197, 180, 219 | 140; 183, 193, 192, 189, 187, 216 | 138; 200, 223, 213, 199, 186, 231 |
    | `MOTOR`: typed ON then `TIMER`, ON:ON, ON:T=TIMER:OFF; in a program A, B, C, D, E | 26, 50, 25; 25, 51, 0, 254, 1 | 1, 1, 1; 1, 1, 0, 10, 1 | 26, 51, 26; 26, 52, 0, 259, 1 |
    | `RND` (500) of 0, 6, 1E9, .5, -1, -3, -1.99999999 | 162, 299, 276, 217, 115, 116, 178 | 133, 208, 209, 168, 131, 132, 138 | 163, 308, 280, 233, 118, 120, 185 |
    | `ram-pointers2`: FOR, ADD, MUL, DIV, STR, GOSUB, IF, MID | 113, 205, 224, 177, 174, 83, 516, 137 | 113, 206, 225, 177, 175, 83, 518, 139 | 114, 207, 225, 177, 175, 83, 517, 138 |
    | `cas-cloadm2` spans A1, A2, B | 1887, 1874, 2396 | 1889, 1877, 2399 | 1893, 1879, 2418 |

    "Ours now" is the timing change built alone (16,080 bytes); merged with the numbers and cassette changes (16,102
    bytes, the code ending at `$BFD8`; `MOVMF` keeps its old time with a `BRN` where the numbers change took out its
    zero test) seven loops take a field or two more: `X=PEEK(I AND 32767)` 605, `X=I AND 1` 282, `VAL("32767")`
    482, `INT(.5)` 202, `RND(.5)` 234, `RND(-3)` 121, `RND(-1.99999999)` 186. `SIN` and `COS` are about a third
    slower than before (1000 of `X=SIN(1)`: 1497 fields, now 1670): the turns' `INT` and the series' products wait
    as `INT` and a product do; no record times them (open, for bb11).
    Nothing is faster than the original. The slowest against it: `RND(.5)` 7.4% (7.8% merged; its `INT(.5)` and `INT` of 1 wait
    for the places as `INT` does), `INT(-1000.5)` 5.5% (ours adds the -1 slower), `X=Y` and `X=I` 5.3% and 4.7% (ours
    reads a variable and assigns slower: no wait in it to take back), `X=1.1` 4.0%. 171 bytes (16,080, the code
    ending at `$BFC2`); by module: `fp.inc` +57, `fpconv.inc` +67, `mathfn.inc`
    +24, `expr.inc` +13, `flow.inc` +6, `strfunc.inc` +5, `cassette.inc` +3, `program.inc` -4, `interp.inc` 0. Open, for bb11: whether a 0 at a number's end costs less than one inside it (`X=10`,
    `X=100`, `X=1000`, `X=1001`, `X=10001`), which would let `IF I<1000` and `X=105` both sit closer; a digit's cost by
    its own value alone (`X=12`, `X=13`, `X=14`, `X=18`, `X=19`); a place's quotient by its bits (`X=2.5`, `X=1.5`,
    `X=1.1`, `X=1.3`, `X=3.7`); `X=I+Y` with Y's exponent 1 to 30 below I's (the addition's alignment, which ours does
    not model); `OR` alone (`X=I OR 1`, `X=I OR 32767`); a variable read and an assignment (`X=Y` with 1, 5 and 20
    variables before X and Y, `PRINT` against `X=`); `MOTOR ON` timed from a field's start to the motor's run; and
    `SKIPF`'s end, from the motor stopping to the screen settling on `OK` (in bb8 `cas-cloadm2` ours takes about 25
    fields more there than the original, most of loop B's 23, so that span sits at its 1% bound: estimated from the
    top-row flags, not measured).
    Open, for bb12: bb8 `rnd-seq` recorded again (its case changed after the record); `cas-ascii-save`'s echo (the
    original shows `A$="Z":GOTO 10` twice before a clear, ours once: when does it echo a line?); where `PLAY` stops
    (the original leaves the DAC at the level of the write it stopped after, any of the four of a period, and the next
    sound starts from it: bb10 `snd-play-dac` shows 46, 62, 31 and 0 after four notes; ours writes the volume's high
    level at the end [OWN, from bb2], so a note's length to the cycle and the level left after it are wanted:
    `T255L255A` to `L1A` and `PRINT PEEK(65312)` straight after, with the sound off); and the smallest numbers
    printed: the original prints the bytes 1,89,199,220,238 as `5.00000001E-39` where our steps give `5E-39`, and
    no scaling of steps of 10^s from below 10^-t then by 10 gives that with `.333333333` and `rnd-seq`'s
    `.903043481` too, so a product at the smallest exponent may round as ours does not: `R=X*1E9` and `X*10`
    stored and their five bytes read, for X of exponent byte 1, 2 and 3. Also recorded again, on an emulator whose PIA 1
    PB0 is the printer's BUSY (ready, as CLOADM 0.4.1 has it; it read as the 6551's idle receive data, busy):
    bb10 `stmt-printer` and bb6 `famous-pokes`, whose waits for a printer came from that (after 0.4.1 lands: every
    round so far ran on an emulator before the fix, bb10 at `faa2087`, bb11 at `5a71788`). If the original then prints
    to the printer after `POKE 111,254`, ours printing on the screen becomes a difference on a well-known POKE, for
    the owner, with its byte cost.
    Replayed, the records match as before but for two: bb8 `cas-cloadm2` now matches whole, and bb2 `snd-sound`'s
    `SOUND 200,4` no longer does: it starts about 400 cycles later in its field (the two numbers' conversion waits), so
    its length, counted in fields, comes out a field longer and without the original's short first period (a phase,
    as `snd-play-length`'s above).
* **The budget, and a size pass that keeps every cycle** [OWN]. `node tools/basic-size.js` gives three figures:
  occupied (the bytes the build lays down, the 14 of the vectors included), reserved (the published entry points,
  `$8006-$8029` and `$A000-$A00D`, 50: never counted free; section 3) and free (only the gap between `ROMEND` and
  `$BFF0`). Before this pass 16,102 occupied, the code ending at `$BFD8`, 24 free; after it 16,100, `$BFD6`, 26 free
  (with `$8000-$80FF` then all reserved). With only the published entry points kept: 16,123 occupied (the seven
  jumps' 21 bytes and `$A000`'s 2 included), the code ending at `$BF0E`, 226 free; with `EDIT`, 16,329, `$BFDC`,
  20 free. Its routines run from a
  label to the next or to their module's end, a label that emits no bytes counting (`tests/basic-size.test.js`; it
  once gave `play.inc`'s last label, `PLD5`, `tokens.inc`'s 611 bytes). The pass changed no cycle on any path, errors
  included, nor the cycle of any write to the screen or the PIAs (every black-box case's writes, stamped with their
  cycle, are the same before and after): `CRBLK` calls `CMSTD` with `BSR` and its three callers call it with `LBSR`
  (9 + 7 cycles, as 8 + 8: the cycle is given back before the call, so nothing inside it moves); `FOUT` sets U first
  and stores the sign through it (`STA -1,U`, the 5 cycles of the extended store, a byte less). A short call's cycle
  given back after it is not enough: `CLDONE`'s `CASOFF` by `BSR` and `RNEND` by `LBRA` kept the path's 12 cycles
  but stopped the motor a cycle sooner, so it was not kept. What was measured and not taken, on this basis: moving a
  two-byte call's slot to another routine (`COMMA` for `PRTSTR`, `LPAREN` for `MOVMF`) can never keep the cycles,
  since a call through a slot takes 11 (`JSR <`, 7, then the slot's `JMP`, 4) against `JSR`'s 8: the routine that
  gains the slot is 3 slower at every call and none of its entries can be made 3 cycles shorter. The other calls a
  short branch reaches (`CHKSP`, `CPYSS`, `ROUND` in `FADD`, `CQUIET` in `CFNAME`, both `CASOFF`s, `FCMPP` in
  `FOUT`, `PRINT USING`'s `LBLE`) have no same-size cycle to give back before the call on every path into it. `CPYXU`
  moved beside its four `fpconv.inc` callers saves 4 bytes gross and needs a byte of padding at each; a `JSR` and
  `RTS` made a `JMP` is 9 cycles faster and leaves the callee a different stack.
* **`EDIT`** ([BB] bb10 `stmt-edit`, section 11 row 70; `edit.inc`, a module of its own after `$A000`, so the
  routine at `$A000` that the table of published calls goes before stays there) took 206 bytes: 16,329, the code
  ending at `$BFDC`, 20 bytes below the vectors. The line is spelt out by `LSTLIN` itself, its output sent into the line buffer
  by pointing the two-byte call `ZCHROUT` at a store for that one call, so no `LIST` code was added or slowed; the
  count lives in B, which `KEYWT` keeps; ENTER hands the line to the main loop where a typed line goes (`MAINLN`, which
  now sets `CURLIN` to `$FFFF` after the line is typed instead of before: nothing reads it during the wait).
* **Running it:** `m.setRoms({ basic: rom, basic64: null })` on a `dragon64` machine (Node), or
  `node tools/build-basic.js --out /tmp/d64_1.rom` then `node cli/cloadm.js --roms /tmp/d64_1.rom --type 'PRINT 2+2\n' --screen`.

## 3. Memory map

### ROM (`$8000-$BFFF`)

| Range | Use |
|---|---|
| `$8000-$8005` | `$FF`: nothing is published there [DOC]; not counted as free (too small for a module) |
| `$8006-$8029` | the published entry points, a 3-byte jump each [DOC pp. 4-5]: a `JMP` to our routine where it does what the page says, `$FF` where none of ours does (the table below; `tests/basic-entry.test.js`) |
| `$802A-...` | the modules, in the order of section 4, packed, around the table at `$A000` |
| `$A000-$A00D` | the published indirect calls, a word each [DOC pp. 4-5]: `$A000` our keyboard poll, the rest `$FFFF` (the table below; `basic/vectbl.inc`). `tools/build-basic.js` puts it in between two routines, before one that nothing runs on into (the instruction before it an `RTS`, `RTI`, `BRA`, `LBRA`, `JMP` or `PULS` of PC) that starts at `$A000` (`SCRNST` today), so it costs no byte; the build fails if no routine starts there (code that grows below `$A000` then goes in a module after it, as `EDIT` does). A mutant's build (tests only) puts it before the last such routine below `$A000` that its short branches still reach over and the code still fits after, the bytes between left `$FF`, or goes without it |
| `...-$BFEF` | free space: only this gap counts as free (`node tools/basic-size.js`) |
| `$BFF0-$BFFF` | the hardware vectors (the SAM maps `$FFF0-$FFFF` here [HW]) |

The published entry points ([DOC] Dragon Data Ltd, "Dragon 32 Information for Machine Code Users!" (March 1983), printed pages 4-5; [provenance 69](#11-provenance-log)):

| Address | What the page says | Ours |
|---|---|---|
| `$8006` (and `JSR [$A000]`) | polls the keyboard: A = the key's code, or 0 if no new key | `KEYIN` |
| `$8009` | blinks the cursor when its count reaches 0 | `$FF`: inside `KEYWT` here |
| `$800C` | writes A to the text screen, scrolling if needed; the cursor moves on | `CHROUT` (the screen while `DEVNUM` is not 255; like anything printed, it shows the text screen again, a picture shown before giving way to it) |
| `$800F` | writes A to the printer | `$FF`: no printer output yet |
| `$8012` | updates the joystick readings in `$015A-$015D` | `$FF`: `JOYSTK` keeps them in `JOYV` |
| `$8015`, `$8018` | the cassette relay on, off | `RLYON`, `RLYOFF` (the motor alone, the interrupt mask left as it was; `CASON` and `CASOFF` also mask and unmask interrupts). Each writes the whole of PIA 1's control register A (`$3C` or `$34`: CA1's interrupt off, the data register selected) and uses A |
| `$801B` (and `JSR [$A00C]`) | prepares for writing | `$FF`: inside `CWBLK` here |
| `$801E` | writes the byte in A | `CWBYTE` |
| `$8021` (and `JSR [$A004]`) | prepares for input, bit sync | `$FF`: inside `CRBLK` here |
| `$8024` | reads the next byte into A | `CRBYTE` |
| `$8027` | reads the next bit into the carry | `CRBIT` |
| `JSR [$A006]` | reads a block: waits for `$3C`, reads into memory at the address at `$7E`, checks the checksum, Z set if it is right | `$FFFF`: `CRBLK` reads to X |
| `JSR [$A008]` | writes a block | `$FFFF`: `CWBLK` takes its own RAM |

Also published, on page 7, and recorded here for P3 (no address of ours is fixed for them yet): `JSR $8B2D` gives the
floating-point accumulator as an integer in D, `JMP $8C37` returns D as `USR`'s value, and RAM hooks at
`$015E-$01AF`, of which the page names `$0167` (input a character), `$016A` (output a character), `$0182` (read a
line), `$018B` (evaluate), `$018E` (the error trap), `$0194` (`RUN`) and `$019A` (the next statement).

P3 has to place code at fixed addresses that ours may already occupy. The plan for that is to keep every module
relocatable (no absolute address inside a module except through a label) so P3 can reorder modules and leave holes
where its entry points go; `tools/build-basic.js` checks for overlap, so a collision fails the build instead of
corrupting the image.

### RAM (our own layout; P3 may move variables to match what programs read)

| Range | Use |
|---|---|
| `$0000-$00FF` | the direct page: the interpreter's variables (pointers, the two floating-point accumulators, the text pointer, flags, P2's current mode, start page and colour byte, `DRAW`'s angle and scale) up to `DPEND` (`$D0`: none free below the two-byte calls, 4 below `$68`, 4 at `$99-$9C`, where `RND`'s seed was), laid out around the fixed addresses programs use, the original's ([section 15](#15-interface-contract-basics-pointers-in-low-ram)): `$19-$28` the program and memory pointers, `$68` the line running, `$6F` the output device, `$71` the cold-start flag, `$88-$89` the cursor's address, `$8F` its blink countdown, `$97-$98` the cursor's delay ([section 14](#14-the-cursor)), `$9D-$9E` `EXEC`'s address (`CLOADM`'s exec address), `$A6-$A7` the text pointer, `$AF` `TRON`; then the two-byte calls' `JMP`s at `$D0-$FF` (`ZTRAMP`; section 2, the size budget), written with the RAM vectors at a cold start. P2's colours, colour set, last point and the point read are here too. DP is 0 throughout |
| `$0100-$01D4` | the system RAM block, laid out by `RMB` in `d64basic.asm` (so nothing overlaps; the build fails if it reaches `BLKBUF`): the RAM jump vectors (IRQ, FIRQ, NMI, SWI, SWI2, SWI3), so a program can hook an interrupt [OWN; addresses to align in P3]; `TIMER` at `$0112`; `RND`'s seed at `$0116-$0119`, as on the original ([BB] bb8 `rnd-seq`; `$0114-$0115` unused); the `DEF USR` addresses; the cassette's name block, ending just below `$0149`, the lower-case flag; the 8 temporary string descriptors; `FOR`'s step and limit; the numeric functions' temporaries; the number conversion and `PRINT USING` buffer; it ends at `SYSEND` (`$01D5`), which the build keeps at or below `BLKBUF` |
| `$01DA-$02D8` | `BLKBUF`, the cassette's one block buffer, as on the original ([BB] bb8 `cas-cloadm2`: `CLOADM` leaves the namefile's exec address at 485; `cas-data-errors`: `OPEN "O"` builds its namefile over the last record written): every block read (a namefile, the blocks of a file passed over, a text file's blocks while their lines go in, a data file's records) and the records a data file or `CSAVE ,A` gathers to write; below the line buffer, which a typed `CLOADM` or `SKIPF` is still running from |
| `$02DC-$03D9` | the line input buffer, as on the original ([BB] `ram-pointers2` (2026-11-26)): the typed line from `$02DD` (250 characters + terminator), and the crunched line written over it from `$02DC`, a byte behind (`CRUNCH` reads ahead of where it writes; `'`, two bytes for one, can only close that gap) |
| `$03DA-$03F3` | above the longest line (`LINBUF` + 250, its 0 and `CRUNCH`'s two more) and below the screen: `FOUT`'s nine digits, the keyboard's rollover table, the four `JOYSTK` values and `PLAY`'s octave, length, tempo, volume and dots (extended addresses, as before: no timing changed) |
| `$0400-$05FF` | the text screen, 32 x 16 [HW: the SAM's reset display offset] |
| `$0600-$1DFF` | the graphics pages: `PCLEAR n` reserves n 1.5 K pages from `$0600` (1-8; 4 at cold start) and the program follows them |
| `$1E00` | 0 (the byte before the program; after `PCLEAR n`, `$0600 + n x $600`) |
| `$1E01-...` | the program (`TXTTAB`; `$0601 + n x $600` after `PCLEAR n`), then simple variables, then arrays, then free memory |
| `...` | the stack (S), growing down from below the string space |
| string space | `CLEAR` sets its size (default 200 bytes), at the top of RAM up to `$7FFF` |

That the program starts at `$1E01` and the default string space is 200 bytes is to be confirmed by black-box
results (`MEM` at cold start, open question 3); both are single constants.

### Program, variable and string layouts

* **A program line:** link to the next line (2 bytes, big-endian), line number (2), the crunched text, a 0 byte. Two
  0 bytes (a 0 link) end the program [MBF descriptions of Microsoft BASIC's program format; confirmed by the token
  probe, which reads program memory, section 7].
* **A simple variable:** 7 bytes: the name (2 bytes; bit 7 of the second set for a string) and the value: a packed
  5-byte number, or a string descriptor (length, 0, address hi, address lo, 0).
* **An array:** the name (2), its total size (2), the number of dimensions (1), each dimension's size (2 each), then
  the elements (5 bytes each, numbers or descriptors).
* **Strings:** in string space, allocated downward; garbage collection compacts live strings when space runs out.

`VARPTR` returns the address of the value, so the descriptor layout is visible to programs; it is checked by a
black-box case (`VARPTR` then `PEEK` of five bytes) and changed to match if it differs.

## 4. Modules

| File | Contents |
|---|---|
| `d64basic.asm` | equates (hardware registers, the RAM layout), the direct page and the system RAM block, `INCLUDE`s, the vectors |
| `boot.inc` | cold start (PIAs, SAM, pointers, banner), warm start (reset with a valid flag), the RAM vectors, the 50 Hz field interrupt (`TIMER`) |
| `screen.inc` | character output: the 32 x 16 screen, scrolling, `CLS`, lower case shown inverse [HW]; printing line numbers |
| `keyboard.inc` | the matrix scan through PIA 0, debounce, SHIFT, SHIFT-0 lower-case toggle, the blinking cursor, BREAK and SHIFT-@ between statements [UM, HW] |
| `lineinput.inc` | the input line editor: typing, left arrow erases, SHIFT-left arrow erases the line, BREAK, CLEAR [UM] |
| `errors.inc` | the error codes and messages, `?XX ERROR` / `?XX ERROR IN n` [UM] |
| `interp.inc` | the main loop: direct mode, statement dispatch, `CHRGET`, `END`, `STOP`, `CONT`, `REM`, `DATA` when run, `TRON` / `TROFF`, `GOTO`, `GOSUB` / `RETURN`, `RUN`, `NEW`, `CLS` |
| `program.inc` | finding, storing, replacing and deleting lines; `NEW`; `LIST` and `DEL` (and their range); `RENUM`; uncrunching keywords |
| `crunch.inc` | crunching a typed line to tokens |
| `vars.inc` | finding and creating variables, arrays, `DIM`, `LET` |
| `expr.inc` | the expression evaluator: precedence, relations, `NOT` / `AND` / `OR`, `&H` / `&O`, function dispatch, type checks, integer conversions |
| `strings.inc` | temporary descriptors, string space allocation and garbage collection, literals, joining, comparison |
| `print.inc` | `PRINT` (`;`, `,`, `TAB(`, `@`), `?`, `PRINT #-1` |
| `flow.inc` | `IF` / `THEN` / `ELSE`, `FOR` / `NEXT`, `ON ... GOTO/GOSUB` |
| `strfunc.inc` | `LEN`, `ASC`, `CHR$`, `LEFT$`, `RIGHT$`, `MID$`, `STR$`, `VAL`, `INSTR`, `STRING$`, `HEX$`, `INKEY$`, `CLEAR` |
| `mathfn.inc` | `INT`, `FIX`, `ABS`, `SGN`, `SQR`, `LOG`, `EXP`, `SIN`, `COS`, `TAN`, `ATN`, `^`, `RND` (constants: the generated `mathconst.inc`) |
| `misc.inc` | `PEEK`, `POKE`, `EXEC`, `USR` / `DEF USR`, `DEF FN` / `FN`, `VARPTR`, `MEM`, `POS`, `TIMER` |
| `io.inc` | `READ` / `DATA` / `RESTORE`, `INPUT`, `LINE INPUT` (and from the tape, `#-1`) |
| `using.inc` | `PRINT USING` |
| `fp.inc` | the floating-point core: unpack / pack, add, subtract, multiply, divide, compare, normalise and round |
| `fpconv.inc` | integers to and from FAC, number to text (`FOUT`) and text to number (`FIN`), the powers of ten |
| `tokens.inc` | generated from `tokens.json`: the token equates, keyword tables and dispatch tables. A keyword table is the words in token order from `$80`, each ending in a letter with bit 7 set: a word's token is its place in the table (a token with no word between two others is one `$FF` byte) |
| `cassette.inc` | `CSAVE` (`,A` for text), `CLOAD`, `CSAVEM`, `CLOADM`, `SKIPF`, `MOTOR`, data files (`OPEN`, `CLOSE`, `EOF`, the tape side of `PRINT #-1` and `INPUT #-1`): reading and writing bits, blocks and files on the tape (section 12) |
| `gfx.inc` | P2's graphics pages, modes and points: `PCLEAR`, `PMODE`, `SCREEN`, `COLOR`, `PCLS`, `PSET`, `PRESET`, `PPOINT`, `PCOPY`, the mode table, the plot routine and the return to the text screen at `OK` ([clean-room-basic-p2.md](clean-room-basic-p2.md), section 3) |
| `sgfx.inc` | `SET`, `RESET`, `POINT`: semigraphics points on the text screen |
| `line.inc` | `LINE` (`B`, `BF`, `-(x,y)`), the line routine `LINETO` that `DRAW` and `CIRCLE` draw with, the span filler of `BF` and `PAINT` ([clean-room-basic-p2.md](clean-room-basic-p2.md), section 5) |
| `circle.inc` | `CIRCLE`: the 64-chord polygon (its sine table: the generated `sine.inc`) |
| `paint.inc` | `PAINT`: the scan-line seed fill, its seeds on the 6809 stack |
| `mini.inc` | the command-string reader `DRAW` and `PLAY` share: characters, numbers, `=var;`, `X var$;` (P2, section 6) |
| `draw.inc` | `DRAW` |
| `getput.inc` | `GET`, `PUT` and their actions |
| `sound.inc` | the tone loop (a cycle-exact square wave, its length counted in cycles), `SOUND`, `AUDIO`, `JOYSTK` (section 7 there) |
| `play.inc` | `PLAY`: its commands, the note table and the length arithmetic; `PLAY`'s defaults, set by `CLRVAR` |
| `edit.inc` | `EDIT` [BB bb10 stmt-edit]; after `$A000`, so code added to it never moves the routine at `$A000` (section 3) |

Statements and functions that belong to P2 (graphics, sound, joysticks) exist in the keyword table from the start, so
programs crunch and list correctly, and give `?FC ERROR` (to be decided, open question 6) until P2 implements them.

## 5. Floating point

* **Format** [MBF]: 5 bytes: an exponent byte (excess 128; 0 means the number is 0) and a 32-bit mantissa, most
  significant byte first, normalised so its top bit is 1; that bit is not stored and the sign is kept there instead.
* **Working form:** two unpacked accumulators in the direct page, each an exponent byte, a 4-byte mantissa with the top
  bit explicit, a sign byte, and an extra low byte of guard bits for rounding. Results are rounded to 32 bits when
  packed.
* **Operations:** add and subtract (align by shifting right, guard bits kept), multiply (32 x 32 with the 6809's
  `MUL`, 8 x 8 partial products), divide (restoring shift-and-subtract), compare, normalise, round, int-to-float and
  float-to-int (`INT` floors, `FIX` truncates). Overflow gives `?OV ERROR`, division by zero `?/0 ERROR`,
  underflow gives 0.
* **Reference model:** `tests/basic/fpmodel.js`, a bit-exact JavaScript model of *our* arithmetic written from the
  format description (BigInt mantissas, explicit guard bits and rounding), not from any ROM. The ROM's routines are
  tested against it on thousands of random and edge operands through a test harness that calls the routines
  directly (section 6), so the 6809 code is proved to compute what the model says.
* **Matching the original:** the original's exact rounding cannot be read off anything we are allowed to see, so it
  is matched through black-box results: printed values of chosen expressions (`1/3`, `2/3`, `10/3*3`, `.1+.2`,
  `1E38*10`, `SQR(2)`, the boundaries of nine-digit printing and of E notation, rounding ties, `-0`, very small numbers).
  Where the model and the original differ in an arithmetic result, the model is changed first, then the ROM.
* **Scaling by powers of ten:** printing scales the number into `[1E8, 1E9)`: below 1 by steps of `1E9` up, then
  steps of 10, each rounded; from 1E9 up by single quotients by 10 only, each rounded [BB bb10 `num-print-big`: the
  original prints 8E37's bytes (254,112,189,194,30) as `8E+37` and 9.99999999E17's (188,94,11,107,58) as
  `9.99999999E+17`, as 29 and 9 such quotients give; our old steps of 1E9 from 1E17 down printed
  `8.00000001E+37` and `1E+18`; all 27 of its values and the 497 printed values of every record whose bytes are
  shown fit the rule but one, below]. One printed value is open: 5E-39's bytes (1,89,199,220,238, exponent byte 1)
  print as `5.00000001E-39` on the original, `5E-39` on ours; up to two steps of 1E9 and then steps of 10 give the
  original's, four give ours, but every other record below 1 needs the steps of 1E9 (open question 12). Reading a number scales its digits by one rounded product or quotient by 10 for
  each place of its decimal exponent, as the original does [BB bb9 `rnd-args`, `rnd-neg`: its readings of 1E38, 1E30,
  1E-30, 1.00000001 and .999999999]; `finTen` in `tests/basic/fpmodel.js` states that rule with exact fractions.
  Every other literal of bb10 `num-literal-bytes` (30 from `DATA`, 10 typed) is stored as that rule gives.
* **A 0 keeps a mantissa** [BB bb10 `num-literal-bytes`]: below the smallest number the original stores 2.9E-39 as
  0,124,160,41,60 (the exponent byte 0, the last quotient's mantissa cut to 32 bits) and 1E-39 and 1E-40 as
  0,32,0,0,0 (10's mantissa: the divisor's, left in FAC by a quotient known to be too small before it is worked out,
  and by a 0 divided). Ours does the same: `MOVMF` stores the mantissa whatever the exponent byte, and `FDIV` gives 0
  at once, FAC's mantissa left, when the exponent difference is below 0 (where it is -1 no record decides: below
  0 is our choice, the first value a quotient cannot reach the smallest number from). A product or quotient with a 0
  operand keeps FAC's mantissa too (our inference for the product; the quotient's is the 1E-40 record). `-0`, `0`
  and a sum to 0 are 0,0,0,0,0, as recorded. The value printed is 0 either way.
* **Printing** [UM, BB]: up to nine significant digits, a leading space for a positive number and `-` for a negative
  one, a trailing space after a number in `PRINT`, E notation outside a range (to be pinned by black-box cases:
  `PRINT 1E8, 1E9, .01, .001, 123456789, 1234567890`), the exponent as `E+nn` / `E-nn`.
* **Transcendental functions:** our own polynomial or rational approximations (coefficients we derive and document,
  with their error bounds). The original's coefficients are not visible to us, so `SIN`, `LOG` and the others may
  differ from it in the last printed digit for some arguments. Black-box cases measure how often; the target is the
  same printed value for the cases in the manuals and close agreement elsewhere (open question 4).
  **`SIN`, `COS` and `TAN` work in turns** [BB bb10 `fn-trig-big`, `fn-last-bit`]. The original gives values, not
  `?FC ERROR`, for any argument: 0 from 1E10 on (x / 2 pi past 2^32: no fraction left), a sixteenth of a turn's
  sine at 1E9 (`SIN(1E9)` .707106781), and its low bits show where it rounds: `SIN(.001)` is 82 units below the
  nearest, as v rounded at 1/4's place in turns gives, `SIN(100)` 56 off and `COS(100)` 84 (x / 2 pi rounded at 16's
  place). The steps, which give all 39 of `fn-last-bit`'s `SIN`, `COS` and `TAN` values bit for bit and every
  `fn-trig-big` value: y = x / 2 pi (a quotient, not a product by 1/2 pi: the product misses 9 of the 39), f = y -
  `INT(y)`; f from 1/2 on becomes f - 1/2 with the result's sign changed; then 1/4 - |1/4 - f|, each step rounded;
  then the series. `COS(x)` is `SIN(x + pi/2)`, the sum rounded (so `COS(1E9)` is .923879533 and `COS(-1E9)`
  .707106781). `TAN(x)` is the sine of f over the sine of 1/4 - f (plus 1 when below 0) turns, from the same f, not
  `SIN(x) / COS(x)`: `TAN(1E9)` is 1 and `TAN(100)` 35 units from `SIN(100) / COS(100)`. The series is our own: a
  six-term least-squares fit of sin(2 pi u) / u in u^2, its v^5 and v^3 coefficients then moved 9 and 1 units so
  that every recorded value matches and `COS(0)` is 1 (no record has it; the fit as it is misses `COS(6)` and
  `TAN(6)` by a unit and gives `COS(0)` a unit below 1). Ours works in half turns (2f, 1/2 and 1), which gives the same
  bits. `tests/basic/fpmodel.js` models the steps (`sin`, `cos`, `tan`); `tests/basic-math.test.js` holds the ROM to
  it bit for bit, to the 39 values, to the `fn-trig-big` values and to the error the steps allow (the old bounds of
  2 units were ours, and the original is outside them). With its 40 bytes of constants (30 of the old ones gone) it is 2 bytes larger than the Cody and Waite reduction
  it replaces.
  **`LOG` and `^`: open** (question 12). `fn-last-bit`'s `ATN` values are all ours already, and its `EXP` values all
  but `EXP(2)` (one unit); its `LOG` differs at .1, .5, 2 (one unit), .9 (7) and 1.1 (29), and `SQR` (x^.5, through
  `LOG`) at .1, .5, 2, 3 and 1E30 (one or two). The original's `LOG(1.1)` is 27 units from the nearest: a reduction
  to a mantissa from 1/2 to 1 with a `- 1/2` after the series cancels near 1. A model of that kind (t = 1 - sqrt 2 /
  (m + sqrt 1/2), t times a four-term series in t^2, then - 1/2, + the exponent, x ln 2) fits all 13 but `LOG(.9)`
  with a plain fit of its series, so it is close; it would need 20 bytes of its own coefficients, which the ROM has
  not got (20 free with `EDIT`), so it is left. bb10 `num-print-big` also shows that `^` is `EXP(y LOG x)` even for a
  whole y: the original's 2^66 is 195,0,0,0,44 and 2^126 255,0,0,0,44, which ours' `EXP` gives from 66 and 126
  times the original's `LOG(2)` (128,49,114,23,249, ours ...248), while 2^60 stays exact; ours multiplies whole
  powers exactly. Both wait for the `LOG` model.
* **`RND`:** the sequence after cold start is visible to programs, so ours is the original's, inferred from the values
  the black-box case `rnd-seq` (bb8) recorded (open question 5): a 32-bit seed at `$0116-$0119`, high byte first;
  each step makes it seed x `$40E64DAB` + `$05B0658B` (mod 2^32), with `MULMAN`'s 64-bit product. `RND(0)` is the new
  seed / 2^32 with the product's bits 40-47 as the 8 bits below it, normalised and then rounded as any result is;
  `RND(n)` for n above 0 takes one step and gives `INT(f x INT(n) + 1)`: n made whole first, f rounded to 32 bits,
  the product rounded before the 1 is added, the sum rounded before `INT` (bb9 `rnd-args`); `RND(-n)` makes the seed
  the argument's four mantissa bytes as unpacked (so -1 and -2 give the same sequence) and then gives what `RND(0)`
  gives; an exponent byte of 0 is 0 whatever its sign bit (bb9 `rnd-neg`). A cold start sets the seed to `$4FC75259`
  and `$0115`, which `RND` neither reads nor writes, to 128 (bb9 `rnd-state`). All 434 values of bb8 and the 171 of
  bb9 `rnd-args` are reproduced with their five bytes and the seed after (`tests/basic-rnd.test.js`), the arguments
  as the original reads them (below).

  **What the records settle.** Every conclusion comes from a black-box record ([BB]: the case and batch named); the
  original's code is never looked at. The cases `rnd-args`, `rnd-neg`, `rnd-state`, `rnd-long` and `rnd-timing`
  (bb9) print the result's five bytes as stored and the bytes at `$0115-$0119` after each call, not only the printed
  value. The seeds the cases set are chosen by undoing a step of the inferred generator, so the next state is a
  chosen value.

  | # | Question | How it is asked | The record | Ours | Test on ours |
  |---|---|---|---|---|---|
  | 1, 2 | Whole against fractional arguments; arguments between 0 and 1 | `rnd-args`: 19 arguments (0, 1, 2, 3, 6, .1, .5, .999, 1.1, 1.5, 2.5, 3.9, 2.999999, 65535, 1E9, 2^32-1, 2^32, 1E10, 1E38) from 9 chosen seeds | n is made whole first: at f = .8, `RND(1.5)` is 1, `RND(2.5)` and `RND(2.999999)` 2, `RND(3.9)` 3; `RND(.1)`, `RND(.5)` and `RND(.999)` are 1 from every seed (bb9 `rnd-args`) | the same (before: n as given, so `RND(1.5)` was 2 at f = .8) | `tests/basic-rnd.test.js` (CPU: all 171 values) |
  | 3, 4 | The order of x, `INT` and + 1 | `rnd-args`: seeds whose fraction is just at 1/3, 2/3, .8, .4 and 1 - 2^-32, and n near 2^32 and beyond float precision | `INT(f x INT(n) + 1)`, each step rounded to 32 bits: at f = 1 - 2^-32 `RND(1)` is 2, `RND(2)` 3, `RND(3)` 3 and `RND(1E10)` 1E10 - 4; at f = 2/3 `RND(1E10)` is 6666666668 (bb9 `rnd-args`). Every one of the 171 values fits that and no other order tried | the same (before: `INT(f x n) + 1`, 19 values off) | as above |
  | 5 | Does every argument take exactly one step | the seed bytes after each call in `rnd-args`, `rnd-neg` | one step for every argument, whole, fractional, below 1 or negative (bb9) | one step | as above |
  | 6-8 | What of a negative argument sets the sequence; powers of two; repeats | `rnd-neg`: -1, -2, -4, -.5, -3, -1.5, -6, -12345 twice, -24690, -1E-30, -1E30, -1.00000001, -65535, -(2^32-1), -.999999999, each with the seed after and the next two values | the mantissa's four bytes, top bit set: -1, -2, -4 and -.5 give one sequence, -3, -1.5 and -6 another, -12345 and -24690 a third; a repeat repeats (bb9 `rnd-neg`). The seeds -1E-30, -1E30, -1.00000001 and -.999999999 leave show the original reads them one or two units above the nearest (below) | the same mantissas; those four read as the original reads them (one rounded step of ten a place, open question 11), so `rnd-neg` matches | `tests/basic-rnd.test.js` (CPU: the 16, with the original's readings of the four) |
  | 9 | Zero in its forms | `rnd-neg`: `RND(0)`, `RND(-0)`, `RND(1-1)`, a variable with its exponent byte POKEd to 0 (mantissa left), and the same with its sign bit set | all five are `RND(0)`: no reseed, even with the sign bit set (bb9 `rnd-neg`) | the same (before: the sign bit set reseeded) | as above |
  | 10-13 | `$0115-$0119` at a cold start; which bytes take part; which `RND` writes; each changed alone | `rnd-state` | 128 79 199 82 89 at a cold start; `$0115` POKEd to 85 changes neither the result nor itself; each of `$0116-$0119` changed alone changes the result; `RND` writes 278-281 only (bb9 `rnd-state`) | the same (before: `$0115` was 0) | `tests/basic-rnd.test.js` (the case replayed), `tests/basic-ram.test.js` (`RNDX` at `$0115`) |
  | 14 | NEW, CLEAR, RUN, warm reset | `rnd-state`: the seed set by POKE, then read after NEW, CLEAR and as RUN starts | none of them touches `$0115-$0119` (bb9). A warm reset is not asked: the harness has no reset directive | the same | as above |
  | 15, 16, 18 | The five bytes, the guard byte, rounding and normalisation across arguments | every case above prints the five bytes | the 434 values of bb8 `rnd-seq` and the 171 of bb9 `rnd-args` | the same | `tests/basic-rnd.test.js` |
  | 17 | A next state with leading zero bytes, or 0 | `rnd-args`: next states `$00123456`, `$00001234`, `$00000012` and 0 | normalised with the guard byte shifted in: 2.77777753E-04, 1.08521454E-06, 4.33556125E-09 and 3.3651304E-11 (94,20,0,0,0) | the same | `tests/basic-rnd.test.js` |
  | 19 | Time against seed and argument | `rnd-timing`: 500 passes each of `RND(0)`, `RND(6)`, `RND(1E9)`, `RND(.5)`, and `RND(-1)`, `RND(-3)`, `RND(-1.99999999)` (fixed seeds), in fields | 162, 299, 276, 217, 115, 116, 178 (bb9) | 163, 308, 280, 233, 118, 120, 185: the original's or up to 7.4% more (before: 133, 208, 209, 168, 131, 132, 138), from the general cost model bb10 pinned (section 2): the product's time by its right operand's bytes and bits (the seed in the step, f in `RND(n)`'s product), `INT`'s by its places, and one wait of `RND`'s own | `tests/basic-timing.test.js` |
  | 20 | Other RAM or workspace changes | bb8 `rnd-seq` (addresses only); `rnd-state`: address 4 set to 77, then whether `RND(0)` changes it | address 4 is 0 at a cold start and `RND(0)` leaves the 77 (bb9); bb8's change of it came from something else in that case | the same | `rnd-state` replayed |

  **Reading a number, as `RND` showed it** (bb9 `rnd-args`, `rnd-neg`). `RND(-x)` seeds from x's mantissa, so it shows
  how the original read x, and `RND(n)` for large n shows it too. The original reads 4294967296 as 2^32 exactly: ours
  dropped its tenth digit, rounding the nine before it up (4294967300), and now keeps the first digit past 32 bits
  as well, the whole rounded when next used (`FIN`; later digits still only count as places, not evidenced). The
  original reads 1E38 as `$96769953` (two units above the nearest), 1E30 as `$C9F2C9CF` (two above), 1E-30 as
  `$A2425FF8`, 1.00000001 as `$80000016` and .999999999 as `$FFFFFFFD` (one above each): exactly what one rounded
  product or quotient by 10 a place gives, for all five. Ours now reads that way too (`FIN`; it read to the nearest,
  by steps of 1E9 and one exact power of ten), and of the 13 lines of `rnd-args` and `rnd-neg` that differed, 12
  match (open question 11). The 13th was printing, not reading: seed 3's `RND(1E38)` is the original's five bytes
  (254,112,189,194,29), which it prints as `8E+37` and ours printed as `8.00000001E+37`; with `FOUT`'s single steps
  of 10 from 1E9 up [BB bb10 `num-print-big`] it prints `8E+37`, and `rnd-args` matches its record whole. `tests/basic-fp.test.js` holds `FIN` to the rule exactly: the five readings as fixed [BB bb9]
  entries, and every random text and every printed number read back to the five bytes `finTen` gives.

  **Its time** (bb9 `rnd-timing`, 500 passes, in fields, each loop started just after a field begins). What the seven
  said: the original's step costs more the more of the seed's bytes and bits are not 0 (`RND(-1)`, `RND(-3)` and
  `RND(-1.99999999)` seed `$80000000`, `$C0000000` and `$FFFFFFEA`: 115, 116 and 178 fields), and `RND(n)` adds a
  product whose time hangs on f's bytes and bits and two `INT`s whose time hangs on the places they drop (`RND(.5)`,
  n made 0, has no product). bb10 measured those costs outside `RND` (section 2, the original's cost model: `X=Y*Z` by
  Z's bytes and bits, Y not counting; `INT` by places), and ours now has them everywhere rather than in `RND` alone:
  `MULMAN`'s rows are the right operand's bytes, each waiting for its bits (the seed is that operand in the step, and
  f in `RND(n)`'s product, now `n x f` with f on the right: the same bits), and `FTRUNC` waits for each place. `RND`
  itself waits `RNDDLY`, for what is left of `RND(0)`.

  | Loop (500 passes) | The original | Ours before bb9 | Before | Now |
  |---|---|---|---|---|
  | `R=RND(0)` | 162 | 133 | 133 | 163 |
  | `R=RND(6)` | 299 | 171 | 208 | 308 |
  | `R=RND(1E9)` | 276 | 189 | 209 | 280 |
  | `R=RND(.5)` | 217 | 165 | 168 | 233 |
  | `R=RND(-1)` | 115 | 131 | 131 | 118 |
  | `R=RND(-3)` | 116 | 132 | 132 | 120 |
  | `R=RND(-1.99999999)` | 178 | 135 | 138 | 185 |

  `RND(.5)` is the furthest over (7.4%): its `INT` of .5 and of 1 wait as `time-int`'s `INT`s do, which suggests the
  original's `RND` takes a shorter way for them. The bb11 probes that would say: `R=RND(4)`, `RND(5)`, `RND(7)`,
  `RND(255)`, `RND(256)` and `RND(65535)` (the same places, different bits), `R=RND(.25)`, `RND(.75)` (n made 0
  again), and `R=RND(A)` with A of -1, -1.5, -1.75 and -1.875 (one more seed bit each).

  Long runs: `rnd-long` folds the five bytes of 10,000 consecutive `RND(0)` from a cold start, and 2,000 each from
  the seeds 0 and `$FFFFFFFF`, into checksums. The original reached the case's `#timeout` after its first block
  (bb9): its five checksums (20039, 64791, 3300, 2091, 34106) and seed bytes are ours, and the case's `#timeout` is
  now 6,000 seconds. `tests/basic-rnd.test.js` checks those 10,000 calls on the CPU against the model, byte for
  byte, and folds them into the original's checksums. Only the Dragon 64's 32K-mode BASIC is in scope (open
  question 7: the 64K mode is out of scope); the harness runs the Dragon 64 only, so a Dragon 32 comparison would
  need `run.js` to load a Dragon 32 and a Dragon 32 dump on the maintainer's machine (not done).

## 6. Tests

All of them run with no ROM, on our ROM assembled at test time.

* **`tests/basic-fp.test.js`:** the floating-point routines against `fpmodel.js`. A small driver (`tests/basic/`
  helpers) loads operands into RAM, sets the PC to a routine through its symbol (from `buildBasic().symbols`), runs
  to an `RTS` trap address, and reads the result; thousands of operations per run, plus a hand-checked edge table
  (zero, signs, largest and smallest numbers, overflow, exact halves). Each expected value in the edge table is
  worked out by hand from the format description, not computed by the model.
* **`tests/basic-lang.test.js`:** the language cases. Each case is a file in `tests/basic/cases/`: a BASIC program or a
  sequence of direct commands, and its expected transcript in `tests/basic/expected/`. The runner types the case into
  a Dragon 64 running our ROM through the keyboard (the typist, so the keyboard scan is exercised too), runs to the
  `OK` prompt, and compares the transcript. Every expected file carries its source on its first line (`# [UM p.45]`,
  `# [BB 2026-12-01]`); a case whose output comes from our own reading of the manual is marked so and is replaced by
  the black-box result when one arrives.
* **`tests/basic-cassette.test.js`:** the cassette statements typed in through the keyboard with the emulated deck as
  the tape (section 12). What our ROM writes is decoded from the deck's recording by the repository's own tape code
  (`samplesToCas`, `formats.parseCas`), and the expected header and data bytes are written out by hand from the
  program typed; tapes built by `buildCas` from known bytes are loaded with `CLOAD` and `CLOADM`; the error paths
  (`?IO ERROR` on a bad checksum, `?FM ERROR`, `?DS ERROR`; BREAK not ending a search) and name search and `SKIPF`.
* **`tests/basic-pause.test.js`:** the keyboard checks between statements: SHIFT-@ pauses a running program until
  another key, @ alone does not, BREAK stops it (`BREAK IN n`); with mutants of the ROM that must fail it.
* **`tests/basic-cursor.test.js`:** the cursor ([section 14](#14-the-cursor)): the countdown, the transformation of
  every byte, the RAM it reads (address, countdown, the byte under it, the cursor's delay at `$0097-$0098`), the keyboard, the delay
  in cycles, on the Dragon 64 and the Dragon 32, with mutants of the ROM that must fail it.
* **`tests/basic-entry.test.js`:** the published entry points ([section 3](#3-memory-map)): the jumps at
  `$8006-$8029` and the words at `$A000-$A00D` against the manual's table written out by hand, and the stubs called
  from machine code (`EXEC`): screen output, the relay on with interrupts on and off with them masked (each left as
  it was), a byte written to the tape (16 DAC writes), the keyboard poll through `$8006` and `[$A000]` with no key
  and with a key pressed (the read stubs, `$8024` and `$8027`, are checked as jumps only); and six mutants in the
  test (`$8015` to `CASON`, `$8018` to `CASOFF`, `$800C` to `SCROLL`, `$801E` to `CWDLY`, `$8006` and `$A000` to
  `CHROUT`), each failing a call. Also where the build puts the table when a mutant's code before it grows or
  shrinks.
* **`tests/basic-editor.test.js`:** the keyboard and screen through the matrix: typing, erasing, SHIFT-0, BREAK during
  a program and during `LIST`, scrolling, `CLS`, the cursor.
* **`tests/basic-edit.test.js`:** `EDIT`: the bb10 record `stmt-edit` replayed, ours identical to it, with a mutant of
  each rule (row 70) that must not be; and our own limit (an insertion into a full line takes nothing).
* **Mutants:** each suite is run against deliberately broken builds (a wrong rounding mode, a precedence swap, an
  off-by-one in `MID$`, a missing scroll) that must fail it; the list is kept in the report of each milestone.
* **The regression hashes** (`tests/regress.test.js`) stay unchanged: nothing in the emulator changes.

## 7. Black-box comparison

`tools/basic-bb/run.js` runs a list of cases on any Dragon 64 BASIC ROM, headless, and records only what the
screen shows. The maintainer runs it on the real ROM on their own machine and gives us the results file; we run it
on ours, and `tools/basic-bb/compare.js` reports the differences.

```
node tools/basic-bb/run.js --rom FILE [--cases tests/basic/cases] [--only a,b] --out results.jsonl
node tools/basic-bb/compare.js real.jsonl ours.jsonl [--shots DIR]
```

* **Input:** the case files (plain text, one line per typed line). Lines starting with `#` are directives or
  comments: `#type TEXT` (keys while a program runs, for `INPUT` and `INKEY$`; `\n` is ENTER), `#keys A+B` (matrix
  keys held together: `SHIFT+LEFT`, `SHIFT+0`, `CLEAR`), `#break`, `#frames N`, `#wait-text REGEX`, `#timeout S`, `#expect-timeout` (from there on a wait that times out ends the case as its result: status `ok`, with `ended` giving the step), `#printer-ready` (from there on PIA1 PB0, the Dragon printer's BUSY input, reads 0, ready: Dragon Data, "Dragon 32 Information for Machine Code Users", March 1983, the `$FF22` entry; on the Dragon 64 that line is also the ACIA's receive data, idle high, so a printer otherwise looks busy; in the harness only),
  `#nowait` (the next line is not waited for with OK), `#screenshot NAME` (the picture as it is now: a PNG and the SHA-256 of its pixels, which `compare.js` compares, writing both PNGs of a differing one with `--shots DIR`; for graphics, P2; composite colour is off, so the pixels are the VDG's own colours); `# bb-only` marks a probe that only the black-box run uses. A case marked `# local-only` (one whose output on the original holds ROM text, such as the message `CLS` past 8 prints) is never written to a results file: `run.js` runs it only with `--local` and prints its shape (the lines typed, `OK`, blank lines and error codes as they are; any other line as `<text N>`), which the maintainer reports by hand. Nothing of the boot screen is ever recorded (a ROM's banner is ROM text): before a case or a corpus program starts, the harness blanks the text screen's memory from outside, types `CLS`, and requires the screen to hold only the `OK` prompt; otherwise the run stops as `no-clean-start` with nothing recorded (`Basic.cleanStart`). A typed line is judged by what follows it (OK back, the screen settled), never by whether the typist saw every key taken: a BASIC that stops reading the keyboard once it runs the line (PLAY sounding, CLOAD) leaves the typist at `not-consumed`, which is only noted in the result (`typist`). A line of which the machine took no key at all ends the case as `stalled` at that line: the machine had stopped reading the keyboard before it, and a still screen would otherwise pass every wait after it. A screen cleared while recording (a frame that leaves at most one row with text after one with two or more: `CLS`, or a cassette operation clearing the screen for its own display) is kept: the screen as it was just before goes into the result's `clears`, which `compare.js` compares when both records have the field. `run.js` ends with how many cases are results, naming any that stopped (`timeout` or `stalled`, with the step).
  For sound and joysticks (P2): `#wav NAME` ... `#wav-stop` records the sound between them as **measures only**
  (below), and `#joy N V` sets joystick axis N (`JOYSTK`'s numbering: 0 right x, 1 right y, 2 left x, 3 left y) to V
  (0-63) before the next line. For the cassette: `#tape NAME`, `#tape-blank`, `#tape-rewind` and `#tape-blocks NAME` (below).
  A typed program line is waited for until the screen settles, any other line until `OK` is back. While a graphics
  mode is shown (PIA1 PB7, A/G, high), the text is read from the text screen at `$0400` behind the picture, so a prompt
  or an error is seen whether or not the ROM went back to text.
* **Sound measures** (`#wav`; `soundMeasures` in `tests/basic/harness.js`; P2 section 14, decision 5): a write tap on
  the PIAs records each write to the DAC (PIA1 port A's output register, `$FF20` or a mirror: bits 2-7, 0-63) and each
  change to whether the DAC is heard (sound enabled, PIA1 CB2 high, and the multiplexer on the DAC, PIA0 CA2 and CB2
  low), with its CPU cycle. Only measures leave the machine, never the levels or their order (a wave played from a
  table would carry the table). Segmentation: the heard writes make runs, a run ending at a gap of more than 20,000
  cycles or where sound is not heard; in a run a full cycle starts at each rising crossing of the middle of its
  lowest and highest level; a run splits into tones where two periods in a row differ by more than 3% from the current
  tone's median (one odd period, an interrupt in the tone loop, does not split it; the period that spans the change
  counts in neither tone). For each tone: its start and length in cycles, its period (the median of its periods),
  how many periods and writes, how many distinct levels, the lowest and highest level, and its first level (where its
  wave starts: one level a tone, like the lowest and highest, never the levels in order). For the window: its length,
  the DAC writes and those heard, a SHA-256 of every event (to tell runs apart) and the sound switch at `#wav-stop`.
  `compare.js` compares the periods within 0.5%, the lengths and the silences between tones within one field (17,784
  cycles), the lowest and highest levels and the end state exactly. When the first record's tones have a first level
  (records made since that field was added), also each tone's first level and number of distinct levels exactly (the
  wave's own, wherever in a field the note starts) and its writes within a field's worth of them plus one
  (ceil(writes / length x 17,784) + 1, from the first record's tone: a tone's length may differ by a field, where the
  field interrupt ends the note's count, and the writes come at the tone's rate); in an older record, made when the
  wave's shape was ours alone (P2 decision 3), none of the three is compared, so its verdict stays as it was. The hash
  is not compared.
* **The printer:** a record holds `printer`, `{ length, hex }`, the bytes the machine's printer port received since
  the clean start (the Dragon's parallel port: PIA0 port B at each rise of PIA1 PA1, the strobe, in a write that leaves the DAC's bits PA2-PA7 as they were; a sound's or the cassette's writes change those bits, so whatever they do to PA1 adds no byte: under the rule before this one the bb10 run of `snd-play-dac` on the original recorded 4,389 bytes of $7F and 0 that were its notes; a record made under this rule says so, `rule: 2`, and only such a record's bytes are compared), only when the case printed:
  what its own `LLIST` and `PRINT #-2` sent. `compare.js` compares them exactly when the first record has the field;
  a first record without it (nothing printed, or made before the field) is not compared. Our ROM sends nothing to the
  printer yet (section 13).
* **The cassette** (`tapeDeck` in `tests/basic/harness.js`): `#tape NAME` puts in, at its start, the tape the
  fixture `tests/basic/tapes/NAME.json` makes (`tools/basic-bb/tapes.js`: the files for `buildCas`, each `lines` of
  text ended by carriage returns or `data` as a string or bytes, and an optional `corrupt` list that flips a data byte
  of a block and leaves its checksum, for a read error). **Fixtures are our own content only**: our own BASIC programs
  as ASCII text (a fixture may not hold a tokenised program), our own data files, a few bytes of our own machine code;
  never anything from a ROM, and each says so in its `provenance`. `#tape-blank` puts in a blank tape and records what
  the machine writes; `#tape-rewind` then makes that recording (decoded to `.cas` by the repository's decoder,
  `recordingToSamples` and `samplesToCas`) the tape, at its start, so a case can `CSAVE` and `CLOAD` back (after
  `#tape NAME` it plays the fixture again from its start). `#tape-blocks NAME` adds a **tape summary** to the result's
  `tapes`, never the tape's bytes: while recording, each block written since `#tape-blank` or the last summary, as its
  type, length, checksum verdict (`ok`), leader (the `$55` bytes between it and the block before), then for a namefile
  its name, file type, ASCII and gap flags, exec and load addresses, and for a data block only the SHA-256 of its data
  (data could in principle carry bytes from the ROM; the hash is enough to tell ours from the original's); `bad`, the
  blocks with a wrong checksum; and the motor's runs since the tape went in or the last summary, `{ start, length }` in
  fields (17,784 cycles, to 0.01; `start` from the first run's, `length` null while it still runs, `carried` for a run
  already going when the window began). A case keeps each summary's window to one typed line, so how fast lines are
  typed never counts. `compare.js` compares the summaries' blocks exactly and the motor runs' number, and their starts
  and lengths within one field (a carried run's length, which ends when the next line is typed, is not compared). For a
  real Dragon, `node tools/basic-bb/tapes.js NAME --wav FILE` (or `--cas FILE`) writes the fixture's tape, and the
  typing sheet says when to put a tape in, record and rewind; the summaries come only from `run.js`.
* **How it runs:** a fresh machine per case (cold start, then `CLS` typed, so the banner is not compared), the lines
  typed through the keyboard matrix at the typist's pace, so the ROM's own editor and crunching take them, exactly as a person typing.
  Nothing depends on the ROM's internals: no PC hooks, no RAM addresses, no tokenized loading.
* **What it records:** the transcript, every line that reached the screen in order: each line as it scrolls off
  the top (a scroll is recognised by what the CPU does, whatever the ROM: a write to the top row of a byte it has
  just read from the same column of the row below), then the final screen. A write over text in the top row that
  is not a scroll is flagged, so a lost line is never silent. Inverse letters are written in lower case (that is
  how the Dragon shows lower case), other inverse characters with a combining low line.
* **Output** (one JSON object per line):
  `{"case":"fp-print-01","machine":"dragon64","rom":"<crc32 of the ROM file>","frames":412,"status":"ok",
  "transcript":["PRINT 1/3"," .333333333","OK"],"screen":["...16 lines..."],"flags":[]}`.
  It holds nothing but screen text, the pictures (`shots`) and sound measures (`sounds`) a case asked for, the tape
  summaries (`tapes`), the printer's bytes when the case printed (`printer`: its own program and output, as BASIC sent
  them), and the ROM's CRC (to tell runs apart); no ROM bytes.
* **The token probe** (`tests/basic/cases/probe-tokens.bas`): one program line per keyword (after `END:`, so never
  run), then a program that searches RAM below `$8000` for a marker it placed in a `REM` and prints each following
  line's number, bytes in hex and whether its link points at the next line. This gives
  every keyword's token value and confirms the program line layout, without looking at the ROM. Similar probes
  give the program's start address (`MEM`, and a marker search), the variable and descriptor layouts (`VARPTR`), and
  the RND sequence.
* **The lint** (`tools/basic-bb/lint.js`, also run by `run.js` and the tests): refuses `EXEC`, `USR`, `DEFUSR`,
  `CLOADM` (except as the tape rule below allows), `CSAVEM` and `VARPTR`, and a `PEEK` or `POKE` whose address is not a literal below 32768 or an
  expression ending in `AND 32767` with no `OR` (computed addresses included), so a case can neither read the ROM nor
  find a string descriptor to point into it. A `# bb-only` probe may also `POKE` the literal addresses 65494-65497
  (`$FFD6-$FFD9`), the SAM's CPU-rate bits, which change the speed but not the memory map (MC6883 data sheet; the
  map-type bits `$FFDE-$FFDF` stay refused): the `famous-pokes` probe times a loop at each rate. A line starting with `END:` is not checked (it is never run past the
  `END`); the token probe lists its keywords that way. For graphics (P2 section 12) it also refuses a `PCLEAR` that
  is not a literal 0-9, a `PMODE` start page that is not a literal 1-8 or whose mode's pages do not fit in the pages
  the case reserves (its smallest `PCLEAR`, else 4), a `PCOPY` page outside them, a `POKE` into the cold-start pages
  (`$0600-$1DFF`, otherwise allowed) in a case that uses `PCLEAR`, and a point of `PSET`, `PRESET`, `SET`, `RESET`,
  `LINE`, `CIRCLE`, `PAINT`, `GET`, `PUT`, `PPOINT` or `POINT`, or a `CIRCLE` radius, that is not a literal (x up to
  511, y and the radius up to 255) or an expression ending in `AND n` with n up to 255: whatever the ROM does with a
  point off the picture, page 8's start plus 255 rows and 511 points stays below `$8000`, so no picture, `PPOINT`,
  `POINT` or `GET` can show the ROM. `DRAW`'s moves are in strings and are reviewed by hand to stay near the picture
  (the clipping case puts its picture in pages 3-6 of 8, so an unclipped point lands in a reserved page). Every
  directive must be one the harness knows, and `#joy`, `#frames`, `#timeout` and `#wait-text` well formed. For the
  tape: a `#tape NAME` fixture must exist under `tests/basic/tapes/` and be well formed (a provenance, BASIC as ASCII
  text), `#tape-rewind` and `#tape-blocks` need a tape in, and `CSAVEM` is refused in either spelling (`CSAVE M`).
  `CLOADM` (or `CLOAD M`) is allowed only when every tape the case can read is a fixture (no `#tape-blank`), every
  file on those fixtures is machine code loading within memory a first line `CLEAR n,top` set aside, with its offset
  if one is given (a literal 0 or more): it then loads our own bytes, which `PEEK` may read back, and with `EXEC`
  refused and the run-time guard nothing runs them (`cas-cloadm`, `cas-cloadm2`).
* **The run-time guard** (`tests/basic/harness.js`, always on for the black-box cases): the CPU running any
  instruction from RAM written since the case began (machine code reached through a POKEd vector, say) stops the
  case with status `refused`, and nothing of its screen is recorded. Our own EXEC and USR cases live apart, in
  `tests/basic/own/`, and are never run on the real ROM.
* **By hand on a real Dragon:** `node tools/basic-bb/sheet.js CASE.bas` prints a case as a typing sheet (what to type
  and press, step by step); the screen's lines are written down in order under `=== case`, and
  `node tools/basic-bb/import.js written.txt --out real-hardware.jsonl` turns them into the same JSONL, for
  `compare.js`. So reference results can come from real hardware as well as from the maintainer's runs. The sheet
  spells out the P2 directives too ("photograph the screen", "start recording the speaker", "set the joystick"):
  those results are compared by eye and ear, not imported.
* **Corpus mode** (`tools/basic-bb/corpus.js`): real tokenized programs on `.cas` tapes, which stay on the
  maintainer's machine. Each is CLOADed on a fresh machine (the tape's first BASIC program: by its name when machine
  code comes first; a tape with none is `no-basic`), LISTed (every line that scrolls by), then RUN for a fixed
  number of frames with no input (or the keys of a `NAME.keys` sidecar), the screen sampled every N frames: its text
  and the SHA-256 of its pixels. The text is written as hashes, except for the programs named in `--full` (those whose
  owners allow it); nothing of a program or the ROM is written but these, the tape's SHA-256 and the ROM's CRC. The
  maintainer runs it with the real ROM and with ours, and `compare.js` reports per program whether the listing is
  identical, the first RUN sample where the two part, and the error lines.
  ```
  node tools/basic-bb/corpus.js --rom d64_1.rom --corpus DIR --out real.jsonl [--frames 1500] [--every 50] [--full NAMES]
  node tools/basic-bb/corpus.js --ours --corpus DIR --out ours.jsonl
  node tools/basic-bb/corpus.js ... --only 'A Game, The'    # one tape (repeat --only; or --only-file NAMES, one a line)
  node tools/basic-bb/compare.js real.jsonl ours.jsonl
  node tools/basic-bb/corpus-stats.js real.jsonl    # counts over all programs: statuses, lint kinds, keyword use
  ```
  Each record also counts how often the program uses each keyword (counts only, from the listing, found as BASIC
  crunches a line; `CIRCLE` arcs and `PUT` actions apart), so `corpus-stats.js` shows which statements real programs
  depend on, and how many use graphics, sound or machine code.
  Each step is judged by its result (the OK prompt back, the listing there), never by whether the typist saw every
  key taken: a BASIC busy with the tape can leave that unseen though the line ran; the record notes it as `typist`.
  Two rules keep the ROM out of the results. The listing is linted first (`EXEC`, `USR`, `DEFUSR`, `CLOADM`,
  `CSAVEM`, `VARPTR`, and a `PEEK` of anything but a literal in RAM or the I/O page `$FF00-$FFDF` or `... AND 32767`):
  such a program is not RUN (status `rom-read-possible`, the kinds and line numbers only). And a guard, after the
  census tool's structural rule, watches the RUN: program code (machine code the program put in RAM, not code BASIC
  itself ran in RAM while it booted, loaded and listed) reading `$8000-$FFFF` outside the I/O page, or ROM code it
  called reading ROM data and returning to it, stops the recording there (status `rom-read`). Two consecutive bytes
  whose value is where control goes next (an interrupt vector, a jump through a table) only pick a target and are
  allowed. What the lint cannot see: a program that `POKE`s BASIC's own pointers to show the ROM; corpus programs
  `POKE` freely, so this is a stated residual risk, not a check, accepted on the condition that only
  the programs with redistribution permission go in `--full` (all others are recorded as hashes).
* **The keyword probe** (`probe-keywords.bas`): writes every byte value `$80-$FE` (and `$FF` with each) into `REM`
  lines and `LIST`s them, so `LIST` spells out every token, including keywords we do not know about.

## 8. P1 test list

Grouped by milestone; each item is at least one case file. [UM] items are written from the manual first and
replaced by black-box output when it arrives.

1. **Boot and screen:** cold start screen and `OK`; typing and erasing; SHIFT-left arrow; CLEAR; scrolling past line
   16; lower case (SHIFT-0) shown inverse; BREAK at the prompt.
2. **Editor and program:** entering, replacing, deleting (a bare line number) and inserting lines out of order; `LIST`,
   `LIST n`, `LIST n-`, `LIST -n`, `LIST n-m`; `NEW`; a line too long; line number 63999 and above (`?SN ERROR`?);
   crunching and listing every keyword (spacing preserved, `?` listed as `PRINT`); strings and `REM`/`DATA` not
   crunched.
3. **Control flow:** `RUN`, `RUN n`, `END`, `STOP` / `CONT`, `BREAK IN n` / `CONT`, `GOTO`, `GOSUB` / `RETURN`
   (nesting, `?RG ERROR`), `ON ... GOTO/GOSUB` (out of range falls through), `IF ... THEN n`, `IF ... THEN stmt`,
   `ELSE`, nested `IF`s, `FOR` / `NEXT` (`STEP`, negative and fractional steps, `NEXT` with several variables, a loop
   that runs once when the start is past the end, `?NF ERROR`), `?UL ERROR`, `TRON` / `TROFF`.
4. **Numbers:** printing (positive, negative, 0, integers, fractions, nine-digit rounding, E notation both ways,
   `-0`), input of numbers in every form (`1E3`, `.5`, `1.`, `&H` hex if the dialect has it), arithmetic and
   precedence (`2+3*4`, `2^3^2`, `-2^2`, unary minus, relational results -1 / 0, `AND` / `OR` / `NOT` on integers),
   `?OV`, `?/0`, `?FC`.
5. **Variables:** two significant letters (`AB` and `ABC` the same variable), reserved words inside names, string and
   numeric with the same name, `DIM`, default dimension 10, `?BS ERROR`, `?DD ERROR`, multi-dimensional arrays,
   `CLEAR n`, `?OM ERROR`.
6. **Strings:** concatenation, comparison, every string function and its edge cases (`MID$` past the end, `LEFT$`
   of 0, `CHR$(256)` `?FC`, `STRING$`, `INSTR` with a start), `?ST`, `?LS` (over 255), garbage collection under
   pressure (a loop that builds strings past the space).
7. **Functions:** every numeric function at chosen arguments, `RND` sequences, `DEF FN`, `PEEK` / `POKE` of RAM,
   `EXEC` and `USR` of a machine-code routine POKEd into RAM, `VARPTR`, `MEM`, `POS`, `TIMER`.
8. **I/O:** `PRINT` with `;`, `,` (the tab stops), `TAB(`, a number's surrounding spaces, `PRINT USING` (every format
   character in the manual), `INPUT` (prompt, several values, `?REDO`, `??`, `?EXTRA IGNORED`), `INKEY$`, `DATA` /
   `READ` / `RESTORE`, `?OD ERROR`, quoted and unquoted `DATA` strings.
9. **Errors:** every P1 error code's message, in direct mode and in a program (`IN n`), and the state after it (`CONT`
   refused, variables kept).
10. **Cassette (P1b, `tests/basic-cassette.test.js`):** `CSAVE` then `CLOAD` round trip through the emulated deck,
    `CSAVE ,A`, `CSAVEM` / `CLOADM` (with an offset), `SKIPF`, `MOTOR`, a file our ROM saves read back by the
    repository's `.CAS` decoder, and `.CAS` files built by the repository's encoder loaded by our ROM.

## 9. Milestones

Estimates are in working sessions of this agent (one long session each), from the start of each milestone.

| # | Milestone | Done when | Estimate |
|---|---|---|---|
| M0 | Design doc, `basic/` skeleton, `tools/build-basic.js`, the black-box harness and the token probe | the doc is pushed; the harness runs on our ROM in CI and on any ROM locally | 1 |
| M1 | Cold start, screen output, keyboard, the line editor, `OK`, error printing (`?SN ERROR` for everything typed) | boot and screen cases pass, keyboard through the matrix | 1 |
| M2 | Crunch / list, program storage, `LIST` `NEW` `RUN` `END` `STOP` `CONT` `REM` `GOTO` `GOSUB` `ON` | editor and control-flow cases that need no expressions pass | 1-2 |
| M3 | The floating-point core and number conversion (`fp.inc`, `fpconv.inc`) with `fpmodel.js` | `basic-fp.test.js` passes; printing cases pass | 2 |
| M4 | Expressions, variables, arrays, `LET`, `PRINT`, `IF`, `FOR` / `NEXT` | number, variable and control-flow cases pass | 2 |
| M5 | Strings and garbage collection; string functions | string cases pass | 1-2 |
| M6 | Numeric functions, `RND`, `DEF FN`, `PEEK` `POKE` `EXEC` `USR` `VARPTR` `MEM` `TIMER` | function cases pass | 2 |
| M7 | `INPUT`, `DATA` / `READ` / `RESTORE`, `PRINT USING`, `EDIT`, `CLEAR`, `TRON` | I/O cases pass; P1 list complete apart from cassette | 2 |
| M8 | Black-box round: align with the real ROM's results, fix differences, document the ones we keep | the comparison report is clean or every difference is explained | 1-2, depends on the results |
| M9 (P1b) | Cassette | cassette cases pass | 1-2 |

Each milestone is pushed when it is green, and reported with its head SHA, tree hash and CI attempt 1.

## 10. Open questions

All answered by the project owner and kept here with the decision, except where marked open.

1. **Shipping the ROM. Decided:** the built image is committed as `basic/cloadm-basic-d64.rom` (a name of its own, never the original's), written by
   `node tools/build-basic.js` as `examples/*.bin` are, and `tests/basic-rom-file.test.js` fails if it is not what the
   source builds (`basic/` is not served, so `sw.js` is unaffected until it is). On the page, later and not in P1:
   the machine starts on the built-in firmware as now and switches to our BASIC only when something needs BASIC (a
   BASIC program or shared BASIC link, typing BASIC), plus a "Use CLOADM BASIC" choice in the ROM panel; the person's
   own ROM always wins. How the page offers it is decided before any wiring.
2. **The banner. Decided:** our own plain placeholder; the final wording comes later through UX. The boot lines are
   excluded from the comparison (each case starts with `CLS`).
3. **RAM layout facts. Decided:** deferred to P3 and the probes.
4. **Transcendental functions. Decided:** last-digit differences are acceptable for now; the target is bit-exact after
   the black-box alignment, and every remaining difference is listed with the case that shows it.
5. **`RND`. Answered** (bb8, `rnd-seq`): the original's sequence is recovered from its recorded values (section 5,
   provenance item 15) and ours reproduces every one, with its bytes. How: each `RND(0)` value with exponent 128 is
   its seed exactly (or one above, rounded), so pairs of consecutive ones fit a 32-bit linear congruential step;
   solving the pairs modulo 2^32 gave one multiplier, `$40E64DAB`, for all of them and an increment of `$05B0658B`
   (the off-by-one pairs are rounding). The seed bytes the case saw `RND(0)` change at 278-281 (5, 173, 54, 120)
   are that step from the value printed before, exactly. The bits a small value gains when it is normalised were
   matched against every byte of the computation: bits 40-47 of the product fit all of them. The cold-start seed is
   the first value's step undone; `RND(1)` and the next `RND(0)` values show that `RND(n)` takes one step; `RND(-1)`
   and `RND(-2)` give the same values, the step from `$80000000`, and `RND(-12345)` the step from `$C0E40000`, the
   argument's mantissa. bb9 settled the rest (section 5): how `RND(n)` scales, the zero forms, `$0115` (128 from a
   cold start, never used by `RND`) and recorded its time (not yet matched); address 4, which bb8 saw change during one `RND`, is left alone by
   `RND(0)` in bb9 `rnd-state`.
6. **P2 keywords in P1. Decided:** they crunch, `LIST` and save correctly; at run time they give whatever error the
   black-box shows, `?FC ERROR` until then.
7. **The 64K-mode BASIC. Decided:** out of scope (32K mode only).
8. **The serial port. Decided:** later.
9. **The black-box round trip. Decided:** runs are done on the maintainer's machine, hours per round trip, so cases
   go in batches: a pushed commit whose cases pass the lint, and the command to run. Reference results may also come
   from a real Dragon, by hand (section 7).
10. **The cassette's visible details. Settled by bb8** (`cas-multi`, `cas-left-open`, `cas-in-program`, `cas-cloadm2`,
   `cas-data2`, `cas-data-errors`; the fixtures `multi-text`, `bad-then-good`, `mc-big`), as section 12 now describes:
   the motor stops after every namefile read (all files, also while searching or skipping) and after each block of a
   gapped file passed, skipped or loaded, and after every namefile written (`CSAVE` too); a written block's run fits
   a 256-byte leader, the half second's wait and the original's bit times (ours were shorter); the leader counts the
   tape decoder reads (1, 2 or 258) were settled by bb10: a pause before a block of 10 or more bytes splits its
   leader off (section 12, "Writing"). A file of several data blocks leaves the letter by their number
   (`F LONG`). A
   text file's line without a number is `?DS ERROR` when the next line is begun (at once when more follows in its
   block), the lines before it kept. A bad block in a file passed over is `?IO ERROR` (`SKIPF`, a named `CLOAD`). A
   file left open by `?IO ERROR` or an `OPEN` is refused by `OPEN`, `CSAVE` and `SKIPF` with `?AO ERROR` and stays
   open; `CLOAD` and `CLOADM` go ahead; `RUN` closes it (an output file written out), `NEW` and an error do not. In
   a running program `CLOAD`, `CLOADM` and `SKIPF` show nothing (a `CLOAD` of a text program shows the blocks after
   its first, the program then gone) and go on as in direct mode (`CLOAD` to `OK`, the others with the statement);
   `CLOADM`'s offset moves the exec address too, kept at `$9D`. Data files show nothing in a program, write and read their
   records in the one block buffer (`$01DA`), `OPEN "O"` keeping the buffer's bytes 11-14 as the namefile's exec and
   load; `INPUT #-1` drops what is left of a record; `OPEN "I"` of machine code or a tokenised program is `?FM
   ERROR`; `OPEN` to `#0` or `#-2` is no error and opens nothing; `EOF` of an output file is `?FM ERROR`.
   Still open: the blink's exact frame (ours at the first leader byte heard, the original's some frames later; the
   flags' rows match); the pause after a namefile when its name is shown (ours about 0.2 field, the original's
   0.13-0.15 in direct mode as in a program) and the search's clear between files (ours about 0.17 field quicker);
   what `CLEAR` and `MOTOR` do to an open file (no record); `CLOAD` with an output file open (ours: forgotten).
11. **Reading numbers by steps of ten. Decided:** read as the original does. bb9 shows it reads 1E38, 1E30, 1E-30,
   1.00000001 and .999999999 one or two units above the nearest, as one rounded product or quotient by 10 a place
   gives (section 5; provenance item 56; [BB] bb9 `rnd-args`, `rnd-neg`). Ours read them to the nearest (steps of
   1E9, then one exact power of ten); it now takes one rounded step of 10 a place. A printed number read back can then
   move by two in the ninth digit where its reading takes 15 steps or more: the old check that it moves by at most
   one was our own assumption, never a record. It is replaced by an exact one: `tests/basic-fp.test.js` checks the
   bytes read, and the text printed again, against `finTen` (`tests/basic/fpmodel.js`), a model written from the rule
   with exact fractions, and keeps the five readings as fixed entries with their bytes.
12. **bb10's numbers. Open** (section 5): what is left of `num-print-big`, `num-literal-bytes` and `fn-last-bit`.
   (a) `FOUT` of 5E-39's bytes (exponent byte 1): the original's `5.00000001E-39` fits at most two steps of 1E9 before
   the steps of 10, the other records below 1 need all of them. Probe: the printed value of chosen bytes with
   exponent bytes 1 to 40 (a mantissa each, POKEd into a variable), and of 1E-30 to 1E-38 times 1, 3, 7. (b) `LOG`'s
   reduction and `^`: the bytes of `LOG(x)` for x from .5 to 1 in steps of 1/64 and at 1.0001, .9999, 1.01, .99; `X^Y`
   for X = 2, 3, 10 and Y = 1-12, 30, 60-70, -1, -2, .5 (whether a whole power is ever exact); `(-2)^3`, `(-2)^2`
   bytes. (c) `COS(0)`, `SIN(pi/2)`, `SIN` at 1/8, 1/4 and 3/8 of a turn, and `TAN` where its cosine is 0 (ours
   `?/0 ERROR`), as bytes. (d) Octal: `&O9`, `&O18` and `VAL("&O19")` (ours takes 9 as a digit and adds: 17, 16, 17;
   the record has only `&O8`, 8).

## 11. Provenance log

Every behaviour fact the ROM relies on, with its source. A fact without a source is not used.

| # | Fact | Source |
|---|---|---|
| 1 | The BASIC ROM occupies `$8000-$BFFF` in 32K mode; the CPU's vectors at `$FFF0-$FFFF` read `$BFF0-$BFFF` | [HW] `js/machines/sam.js`, the SAM data sheet's map type 0 |
| 2 | The text screen is 32 x 16 at `$0400` after reset; VDG character codes: `$40-$7F` normal, `$00-$3F` inverse | [HW] the SAM's reset display offset, the MC6847 data sheet |
| 3 | The keyboard matrix: PIA 0 port B drives the columns, port A reads the rows; the layout | [HW] `js/machines/keyboards.js`, `js/machines/sam.js` |
| 4 | The 50 Hz field sync interrupt reaches the CPU as IRQ through PIA 0 CB1 | [HW] `js/machines/cocopia.js` |
| 5 | 5-byte floating point: excess-128 exponent, 0 = zero, sign in the mantissa's top bit | [MBF] |
| 6 | Program line layout: next-line link, line number, text, 0; end marked by a 0 link | [MBF] descriptions of Microsoft BASIC; to be confirmed by the token probe [BB] |
| 7 | The prompt is `OK`; errors print as `?XX ERROR`, in a program `?XX ERROR IN n`; BREAK prints `BREAK IN n` | [UM] |
| 8 | The error codes and their meanings (NF, SN, RG, OD, FC, OV, OM, UL, BS, DD, /0, ID, TM, OS, LS, ST, CN, UF, FD, AO, DN, IO, FM, NO, IE, DS, NE) | [UM] error message appendix |
| 9 | Variable names: two significant characters; `$` for strings; arrays default to 10 | [UM] |
| 10 | Keyword list (statements and functions) | [UM]; token values from the probe [BB] |
| 11 | SHIFT-0 toggles lower case, shown as inverse; SHIFT-@ pauses; BREAK stops; CLEAR clears the screen; left arrow erases | [UM] |
| 12 | Number printing: leading space or `-`, trailing space, nine digits, E notation | [UM]; the exact boundaries from [BB] |
| 14 | The numeric functions: series after a reduction (turns for `SIN`, `COS` and `TAN`, row 59; base 2 for `LOG` and `EXP`: `LOG` is (ln m / ln 2 + e) ln 2, `EXP` 2^n e^((t - n) ln 2) for t = x / ln 2 rounded, n = `INT(t)`, which gives the real's `SQR(1E10)`, `SQR(144)`, `SQR(65536)` and `EXP(11.5129255)` bit for bit); the constants (pi, ln 2, sqrt 3 to 36 digits, 1/k!) | [OWN], `tools/basic-consts.js`; the base 2 from [BB] bb2, `fn-sqr-bits`; measured against the exact values (`tests/basic-math.test.js`: within 2 units in the last place, `EXP` within 3 + abs(x) (the rounding of t, as the real's), `^` within 64) |
| 15 | `RND`: the seed (`$0116-$0119`, high byte first; `$4FC75259` at a cold start) becomes seed x `$40E64DAB` + `$05B0658B` mod 2^32; `RND(0)` is it / 2^32 with the product's bits 40-47 below it, normalised and rounded; `RND(n)`, n above 0, one step then `INT(x INT(n) + 1)`, each step rounded; `RND(-n)` seeds from the argument's mantissa bytes, then as `RND(0)`; an exponent byte of 0 is 0 whatever its sign | [BB] bb8 `rnd-seq`: inferred by fitting its 434 values and bytes and the seed bytes it saw change (open question 5); bb9 `rnd-args`, `rnd-neg` (2026-11-27): the argument made whole, the order and the roundings fitted to its 171 values and bytes, the zero forms; `tests/basic-rnd.test.js` |
| 13 | The floating-point algorithms (rounding, guard bits, division, scaling by powers of ten). Printing scales a number into [1E8, 1E9) by steps of 1E9 below 1, then by single steps of 10, each rounded, and from 1E9 up by single quotients by 10 only (row 57): the real prints its `SQR(1E10)`, 1E5 - 6 x 2^-15, as `99999.9999`, which four rounded steps give (one product by 1E4 gives `99999.9998`); a number printed and read back (one rounded step of ten a place, row 56) can then print up to two units away in the ninth digit | [OWN], [MBF]; the steps from [BB] bb1, `fn-math` and bb2, `fn-sqr-bits`; tested bit for bit against `tests/basic/fpmodel.js` (`tests/basic-fp.test.js`) |
| 16 | The cassette statements and their syntax: `CSAVE "name"[,A]`, `CLOAD ["name"]`, `CSAVEM "name",start,end,exec`, `CLOADM ["name"[,offset]]`, `SKIPF ["name"]`, `MOTOR ON` / `OFF`; `?IO ERROR` for a tape that will not read | [UM] |
| 17 | The tape's bits: one full cycle per bit, 1200 Hz for 0 and 2400 Hz for 1, least significant bit first | [FMT] published descriptions of the Dragon / CoCo cassette format; the same in the repository's tape code (`js/media/cassette.js`, run as the test oracle) |
| 18 | A block: a leader of `$55` bytes, the sync byte `$3C`, the block type (`$00` namefile, `$01` data, `$FF` end of file), the length, up to 255 data bytes, the checksum (the sum of type, length and data, modulo 256) | [FMT] |
| 19 | The namefile block's 15 bytes: the name padded with spaces to 8, the file type (0 BASIC, 1 data, 2 machine code), the ASCII flag, the gap flag (`$FF` each for a text file), the exec address and the load address (big-endian) | [FMT] |
| 20 | A text (ASCII) program is its `LIST` text, lines ended by a carriage return, in gapped blocks (the motor stops between them) | [FMT] |
| 21 | Our writer: 256 leader bytes before every block and one `$55` after it; a square wave on the DAC, 812 cycles for a 0 and 434 for a 1 (about 1094 and 2048 Hz) plus the byte's own work; about half a second of motor run before a block written after the motor was stopped, and the motor stopped after every namefile | [FMT] for the block layout, which the repository's encoder (`buildCas`) also writes; the wave is [OWN]; the leader, the bit times and the wait (`CH0`, `CH1`, `CDELAY`) fit the original's motor runs of blocks of known bytes to within 0.01 field: [BB] bb4 `cas-save-load`, `cas-files`, bb8 `cas-data2`, `cas-data-errors` (2026-11-26) |
| 22 | The cassette hardware: the DAC (PIA 1 port A bits 2-7) drives the output, PA0 reads the input, CA2 runs the motor; the CPU clock is 888625 Hz | [HW] `js/machines/cocopia.js`, the machine's `tickHz` |
| 23 | `CLS c` fills the screen with colour c, 0-8; a colour's block is the semigraphics-4 character with all four elements lit and the colour in bits 4-6 (0: black, no element lit). A colour is truncated (8.5 is 8, 9.5 is 9). A colour 9-255 is no error: the screen is not cleared, one line of text is printed, the same for every colour, then an empty line; past 255, below 0 and `1E3`, `?FC ERROR` | [UM] for `CLS c`; [HW] the MC6847 data sheet for the character; [BB] bb2, `screen-cls` for 0-8 and the local-only `screen-cls-range` and its boundary run (8/9, 255/256, -1, 8.5, 9.5, 255.9, 1E3) for the shape past 8 (on the original that line is ROM text, 21 characters); ours prints our own line there, `MADE WITHOUT PEEKING` (`OK BOOMER` for 67, [OWN]), never the original's text: a deliberate difference (section 13) |
| 24 | `BREAK` and `BREAK IN n` follow one carriage return whatever the column, after `STOP` and after BREAK (in a program and in `INPUT`): an empty line when the cursor was at the start of a line, else just the end of that line (`PRINT "X";:STOP` shows `X`, then `BREAK IN 10`); an error message does not | [BB] bb1, `flow-cont` (and `io-data`, `review-fixes` for errors); bb2, `flow-stop-col` |
| 25 | `CONT` after a program ran off its end is no error: it ends again (`OK`) | [BB] bb1, `flow-cont` |
| 26 | `SQR(x)` is not a square root rounded once: `SQR(1E10)` prints `99999.9999` and is 1E5 - 6 x 2^-15; `SQR(144)` is 12 - 3 x 2^-28, `SQR(65536)` 256. Ours is `x^.5`, `EXP(.5 LOG x)` with `LOG` and `EXP` in base 2 (row 14), which gives those bits; `SQR(1E8)` (the real's is 1E4 + 2 units, ours 1 unit) and `SQR(.5)` still differ in the last place (`TAN(1)` now matches: row 59) | [BB] bb1, `fn-math`; bb2, `fn-sqr-bits` |
| 27 | `DEF FN` with a string name (`DEF FN A$(X)=...`) is `?TM ERROR` when the `DEF` runs | [BB] bb1, `fn-misc` |
| 28 | `RESTORE` takes no line number: `RESTORE 20` is `?SN ERROR`; a bad number in `DATA` is `?SN ERROR` in the `DATA`'s line | [BB] bb1, `io-data` |
| 29 | `PRINT USING` E notation: with no `+` or `-` in the field, its first place is the sign's (a space or `-`): `"##.##^^^^";12345` is ` 1.23E+04`. When that place is the last before the point it shows `0` for a positive number (`"#.##^^^^"`: `0.12E+04`, `-.12E+04`); with no `#` before the point it is the first place after it, always `0`, and a `-` does not fit (`".##^^^^"`: `.01E+05`, `%-.01E+05`). Ten places print right (` 100000000E-08`); eleven print a value ten times too small (`  100000000E-09`), and ours reproduces it: the digits stay FOUT's nine, the exponent is counted for ten digits and the tenth place shows nothing, so the body is one shorter and lies a place further right. The same rule holds for other values and a sign of the field's own; in a field with a point the tenth place, a decimal, shows `0` instead (`"#######.####^^^^";12345` is ` 123450.0000E-01`). A field with ten places before the point and none after it is [OWN] (as with no point). Twelve print garbage (`%1000000000E-10`, then `?SN ERROR IN 0`: the field has run over the original's own memory); ours keeps `?FC ERROR` there (section 13). On a fresh machine of its own [BB bb10 `using-wide12`] the same field gives `%1000000000E-10` for 1 and `%1234500000E-06%-1000000000E-10` for 12345 and -1, then `PRINT 1+1;"STILL"` works: ten digits after a `%`, an exponent that fits neither ten nor twelve places (1 is shown E-10, 12345 E-06); still `?FC ERROR` on ours by the standing decision | [BB] bb1, `print-using`, `review-fixes`; bb2 and bb3, `print-using-exp`; bb10, `using-wide12` |
| 30 | `VAL` puts a 0 after its string while it reads the number and an error leaves it there: after `40 X=VAL("1E99")` overflows, `LIST 40` shows `40 X=VAL("1E99` | [BB] bb1, `review-fixes` |
| 31 | `PRINT @n, USING ...` | [UM] (both forms documented); found by the corpus programs |
| 32 | `ELSE` and `'` are stored with a `:` before them (`END:ELSE` is `8A 3A 3A 84`, `PRINT'A` is `87 3A 83 41`, `THEN 10 ELSE 20` ends `30 20 3A 84 20 32 30`); ours does not show that `:` in `LIST` [OWN, case `crunch-else`] | [BB] bb1, `probe-tokens` |
| 33 | `RENUM` follows the line numbers after `GO TO`, `GO SUB`, `THEN`, `ELSE` and in `ON`'s lists; a number after `RUN` or `RESTORE` is left as it is | [BB] bb2, `renum` |
| 34 | A number's exponent is read into one byte that wraps: `VAL("1E997")` is no error (997 is 229 in a byte, -27 as a signed one: ours reads 1E-27), where `VAL("1E99")` is `?OV ERROR` | [BB] bb2, `str-val-cut` (no error; the value is our inference, not yet observed) |
| 35 | The cursor's state is in RAM: `$0088-$0089` the address of the cell it is at (big-endian; poking it moves the blinking cell), `$008F` the blink countdown; `$0097-$0098` a delay (big-endian), 1,118 (`$04 $5E`) at the first prompt: the cursor's delay, ours (the specification calls it the keyboard's debounce delay; row 67) | [BB] black-box observation (2026-11-25) for `$0088-$0089` and `$008F`; [OWNER-SPEC] for `$0097-$0098`; its value [BB] bb10 `scr-prompt-idle` (2026-11-27) |
| 36 | While BASIC waits for a key the countdown is decremented (unsigned: 0 goes to 255 with no blink); the decrement that reaches 0 transforms the cell and the countdown is reloaded with 50, so a countdown of 2 blinks on its second decrement and a transition takes 51 writes of `$008F` (the reload and 50 decrements). About 9,177 cycles per decrement and 456,471 per transition (513 ms) in 32K mode | [BB] black-box observation (2026-11-25) |
| 37 | In 32K mode (the Dragon 32 and the Dragon 64's 32K mode alike) a transition toggles bit 6 of the byte and keeps the others: $20 and $60, $41 and $01, $FF and $BF | [BB] black-box observation (2026-11-25); that the Dragon 32 is the same, [OWNER-SPEC] |
| 38 | A key accepted: the first write to the cursor's cell is `$60`, and `$008F` is not touched | [BB] black-box observation (2026-11-25) |
| 39 | No statement of a running program sees `$008F` change, printing included: `GOTO` loops, `PEEK`, `INKEY$`, empty `FOR` loops, `PRINT` with and without a scroll, `PRINT @`, `CLS`, a semigraphics block; it counts only in the keyboard wait (at the prompt and in `INPUT`) | [BB] black-box observation (2026-11-25): `cursor-print` (bb3) and its re-check (reconcile, 2026-11-25), which replaced an earlier reading made between frames from outside the machine |
| 40 | The cursor is updated by the keyboard wait, not by a timer, with a fixed delay after each update; the address is read from RAM at each transition; no copy of the byte under the cursor is kept; moving the cursor does not restart the blink | [OWNER-SPEC] |
| 41 | Native 64K mode (not built): a transition writes `$8F` over `$AF` and `$AF` over anything else; about 9,885 cycles per decrement, 475,692 per transition | [BB] black-box observation (2026-11-25) |
| 42 | The field interrupt, from its entry to its `RTI`, takes 104 cycles: it lengthens the period it falls in by that much (octave 1's C to G medians are 104 cycles over their periods); ours pads `IRQSRV` to the same (it took 66) | [BB] bb2, `snd-play-pitch` (docs/clean-room-basic-p2.md section 6) |
| 43 | A cassette read (`CLOAD`, `CLOADM`, `SKIPF`) clears the screen and shows `S` in the top-left cell; that letter changes between normal and inverse once a block, at the block's leader; a namefile met puts its name on the top row from the third cell; a file passed over is cleared away at its end-of-file block and `S` put back; the file wanted shows `F` (written after the name); the prompt or the error goes on the second row | [BB] bb4 `cas-cloadm`, `cas-save-load`, `cas-skipf` (top-row flags); bb5 `cas-display`, `cas-errors` (flags, `clears`, pictures); the change at the first leader byte and the end state after several data blocks are [OWN] |
| 44 | `CLOAD` of a data file is `?DS ERROR` after its end-of-file block is read (its one record the block's last); of machine code, `?FM ERROR` right after the namefile | [BB] bb5 `cas-errors` (2026-11-25) |
| 45 | `?IO ERROR` during a load leaves the file open: the next `SKIPF` is `?AO ERROR` and does not run the motor; `CLOAD` after it works | [BB] bb5 `cas-errors` (2026-11-25); bb8 `cas-left-open` (row 50) |
| 46 | `LIST`: a line that ends at the right edge of the screen (its last row full) is followed by no empty row; at most 249 characters of a line's text are shown (longer lines come only from tapes); written to the tape (`CSAVE ,A`) every line still ends with its carriage return [OWN] | [BB] the real records of the 36 programs in the corpus (2026-11-25): every listing identical to ours with this rule |
| 47 | `CLOAD`: a program ends at its end marker (the first link of 0); what the tape holds after it is not part of the program and is never listed | [BB] corpus records (two programs with bytes after the marker) |
| 48 | `DRAW` (and `PLAY`, which reads its string the same way [OWN]): spaces before a number are passed over, so `DRAW "C"+STR$(5)` works | [BB] corpus records (a program whose run goes on, on the original, past such a `DRAW`) |
| 49 | Cassette data files: `OPEN "O"` writes a type-1 namefile (ASCII and gaps `$FF`, exec and load 0 on a fresh machine), the records go in a data block written at `CLOSE` with an end-of-file block, the motor run for each of the three; a number printed to the tape has no space after it and `;` and `,` end the record (`HELLO`, CR, ` 42`, CR); `OPEN "I"` in a program shows nothing on the screen (typed: row 65); `INPUT #-1,A$` takes a whole record with its commas, leading spaces dropped, `LINE INPUT #-1` keeps them; `EOF(-1)` ends the loop after the last record; then `?IE ERROR`; `PRINT #-1` with no file `?NO ERROR`, `INPUT #-1` in direct mode `?ID ERROR`; `CLOSE` closes it (`CLOSE #-1`, `CLOSE -1`); the forms without `#` | [UM] for the statements; [BB] bb4 `cas-files` (2026-11-25: its transcript, block summaries, data hash and motor runs); the rest in row 51 |
| 50 | The motor and the display while reading: the motor stops after every namefile read and starts again 0.13-0.15 field later, and after each block of a gapped file (the last namefile's gap flag) passed, skipped or loaded, not of machine code or a tokenised program; a text program's lines take about a field each between its blocks; a bad block in a file passed over is `?IO ERROR`; a line without a number is `?DS ERROR` when the next line is begun (at once with more in its block), the lines before it kept; in a running program `CLOAD`, `CLOADM` and `SKIPF` show nothing (no clear, no letter, no name, no blink: a text `CLOAD` blinks again for the blocks after its first, the program gone) and `CLOAD` ends at `OK`, the others going on with the statement; `CLOADM`'s exec address at `$9D-$9E`, its offset added, the namefile buffer at `$01DA`; `OPEN`, `CSAVE` and `SKIPF` refuse a file left open with `?AO ERROR`, which leaves it open, while `CLOAD` goes ahead; `EOF(-1)` of the file `?IO ERROR` left open is -1 | [BB] bb8 `cas-multi`, `cas-left-open`, `cas-in-program`, `cas-cloadm2` (2026-11-26: transcripts, `clears`, top-row flags, motor runs) |
| 51 | Data files: no blink and nothing on the screen, reading or writing, in a program (typed `OPEN "I"`: row 65); `OPEN "O"` builds its namefile in the block buffer over the last record written (exec and load its bytes 11-14); `RUN` closes an open file as `CLOSE` does, `NEW`, an error and `?AO ERROR` do not; `OPEN` to `#0` or `#-2` is no error and writes nothing; `INPUT #-1` with items left in a record drops them, no `?EXTRA IGNORED`; a bad number `?FD ERROR`; `OPEN "I"` of machine code or of a tokenised program `?FM ERROR`, of a program as text read as records; `EOF` and `INPUT #-1` of a file open for output `?FM ERROR`; a second `OPEN` `?AO ERROR` | [BB] bb8 `cas-data2`, `cas-data-errors` (2026-11-26: transcripts, block summaries with the namefiles' fields, data hashes, motor runs) |
| 52 | `NOT` straight after a relation or another operator is an operand: `NOT` and the relation after it, as at an expression's start, so `1<NOT 0` is 1<(NOT 0), 0; `1=NOT 0` 0; `5+NOT 0` 4; `2*NOT 0` -2; `-NOT 0` 1 (no `?SN ERROR`). `NOT` first still applies to the relation after it (`NOT 0<1` is 0), and `1 AND NOT 0` is 1. Where its operand ends after an operator (`1<NOT 0+1`, ours 1<(NOT 1)) is our inference: no record has an operator after that operand | [BB] bb9 `expr-not` (2026-11-27) |
| 53 | `PRINT USING`: a fixed field's number of more than 32 bits once scaled to its decimals prints its digits as any other, nine significant then zeros (`"#####.#####";100000.5` is `%100000.50000`, too wide by one; `"######.#####"` gives `100000.50000`, `"#####.#####";99999.5` `99999.50000`); ours takes `FOUT`'s nine digits and zeros up to 20 digits, and from 2^66 on prints `%` and the number scaled to its decimals as `PRINT` has it, without its sign [OWN]. An E field with a sign's place (no `+` or `-`) whose rounding carries out puts the 1 in the sign's place and keeps the exponent: `".##^^^^";999999999` is `.10E+10`, `99999999` `.10E+09`, `"#.##^^^^";999999999` `1.00E+09` (ours renormalised: `.01E+11`, `.01E+10`, `0.10E+10`). A negative number then has no place for its `-` and prints after a `%` (`"#.##^^^^";-999999999`, `%-1.00E+09`; recorded in bb10 `using-exp-edge`). A field with a `+` or `-` of its own does not renormalise either: the 1 takes a place the field has not got, so it prints after a `%` (`"+.##^^^^";999999999` is `%+1.00E+09`, `-999999999` `%-1.00E+09`, `99999999` `%+1.00E+08`; ours renormalised, `+.10E+10`) | [BB] bb9 `print-using-odd` (2026-11-27); bb10 `using-exp-edge` (2026-11-27) |
| 54 | `$0115` is 128 at a cold start; `RND` neither reads nor writes it, and NEW, CLEAR and RUN leave `$0115-$0119` as they are | [BB] bb9 `rnd-state` (2026-11-27) |
| 55 | `RND`'s time grows with the seed's bytes and bits that are not 0: 500 passes of `R=RND(A)`, A = 0, 6, 1E9, .5, -1, -3, -1.99999999, take 162, 299, 276, 217, 115, 116, 178 fields (ours now 162 to 7.4% more: section 5) | [BB] bb9 `rnd-timing` (2026-11-27) |
| 56 | Reading a number: 4294967296 is 2^32 exactly; 1E38, 1E30, 1E-30, 1.00000001 and .999999999 are one or two units above the nearest, as one rounded product or quotient by 10 a place gives (ours reads all six so now: open question 11; the old "at most one unit" round-trip bound was our assumption, not a record) | [BB] bb9 `rnd-args` (`RND(4294967296)`, `RND(1E38)` from 9 seeds), `rnd-neg` (the seed each negative argument leaves) (2026-11-27) |
| 57 | Printing from 1E9 up scales by single quotients by 10, each rounded: 8E37's bytes print as `8E+37`, 9.99999999E17's as `9.99999999E+17`, 2^60 as `1.15292151E+18`; seed 3's `RND(1E38)` (254,112,189,194,29) as `8E+37` | [BB] bb10 `num-print-big` (its 27 values), bb9 `rnd-args` (2026-11-27) |
| 58 | A 0 below the smallest number is stored with a mantissa: 2.9E-39 as 0,124,160,41,60, 1E-39 and 1E-40 as 0,32,0,0,0; 1.70141183E38 is 255,127,255,255,248 and 1.7014119E38 and 1E39 `?OV ERROR` | [BB] bb10 `num-literal-bytes` (2026-11-27) |
| 59 | `SIN`, `COS` and `TAN` in turns (section 5): x / 2 pi less its `INT`, folded by rounded steps at 1/2 and 1/4; `COS(x)` = `SIN(x + pi/2)`; `TAN` from the one f; values for every argument (0 from 1E10 on) | [BB] bb10 `fn-trig-big`, `fn-last-bit` (2026-11-27) |
| 60 | `VAL` reads `&H` and `&O` as an expression does, after spaces (`VAL(" &H10")` 16, `VAL("&HFFFF")` 65535, `VAL("&H10000")` and `VAL("&O200000")` `?OV ERROR`, `VAL("&H")` and `VAL("&HG")` 0, `VAL("&H1G")` 1, `VAL("&17")` 15), not after a sign (`VAL("-&H10")` 0); an octal number takes 8 as a digit (`&O8` and `VAL("&O8")` 8; 9 and adding, not ORing, are our inference) | [BB] bb10 `num-val-hex` (2026-11-27) |
| 61 | `PRINT USING` of a number of 1E9 or more in a field without `^^^^` is `%` and the number as `PRINT` has it, its sign dropped, whatever the field (`"##";1E9` `% 1E+09`, `"##.##";1E20` `% 1E+20`, `"#####.##";-7.4E19` `% 7.4E+19`, `"**$##.##";1E22` `% 1E+22`); ours scaled the number by its decimals first (`% 1E+22` for `"##.##";1E20`) and printed 1E9 as `%1000000000` | [BB] bb10 `using-exp-edge`, `num-print-big` (2026-11-27) |
| 62 | A block written after the motor started: a leader of 256 `$55`, then a pause that grows with the block's length (the checksum worked out), then the block's own `$55` and `$3C`: the tape decoder reads 258 `$55` before a block of 8 data bytes or fewer, and 1 (2 after an earlier block) before one of 10 or more, the pause splitting the leader off; a data byte takes 36 cycles more than a leader byte to write | [BB] bb10 `cas-timing`, `cas-close-pending`, `cas-ascii-save` (2026-11-27: the block summaries' leaders, the motor's runs); 19 cycles a byte for the pause, and where it is, ours [OWN] |
| 63 | `CSAVE ,A` writes a carriage return before the listing, each line ended by its own; an empty program writes a data block of one CR; every namefile (`CSAVE`, `CSAVE ,A`, `OPEN "O"`) takes its exec and load addresses from bytes 11-14 of the block buffer as it was; a tokenised program's data does not go through the buffer | [BB] bb10 `cas-ascii-save`, `cas-timing` (2026-11-27: the data blocks' hashes, the namefiles' fields) |
| 64 | Reading: after the motor starts the original waits before it listens (a block left with 2 `$55` before it by the decoder is missed: `?IE ERROR IN 10`); a record read by `INPUT #-1` takes about 0.11 field more than ours did, a character printed to the tape about 200 cycles less, a line of `CSAVE ,A` about 6,600 cycles more | [BB] bb10 `cas-timing` `data-read`, `data-write`, `csave-ascii`; `cas-close-pending` `open-l-m`; `cas-ascii-save` (2026-11-27: the motor's runs) |
| 65 | `OPEN "I"` typed shows the search as `CLOAD` does (the screen cleared, `S`, the name, `F`) and reads the file's first data block (the `F` changes); after `?IO ERROR` left a file open, `CLOSE`, `CLOSE #-1`, `RUN` and a `CLOAD` of another file close it, `NEW`, `CLEAR`, an error (`?/0`), `MOTOR` and `SKIPF` (`?AO ERROR`) do not | [BB] bb10 `cas-left-open2` (2026-11-27: the clears and the top-row flags) |
| 66 | `PLAY` writes the DAC four times a period: the middle level (31), the high, the middle, the low; a note can stop after any of the four, and the next sound starts from the level it stopped at (the first level of a tone is that one, typed or in a program); `O1C-` and `O5B+` are `?FC ERROR`. `SOUND` too writes four times a period with three levels; a pause writes about every 865 cycles | [BB] bb10 `snd-play-dac` (2026-11-27: the tones' writes, levels and first levels); bb2 `snd-sound` (writes and levels, recorded before they were compared), `snd-play-length` `pause4`, `pause8`, `pause16` (the writes); the middle level's length and a pause's level, ours [OWN] |
| 67 | `$0097-$0098` is 1,118 at the first prompt, and still after a few lines; a key is not taken 1,118 passes later (a debounce of that length makes our typed lines about 7,000 cycles later than the original's: the sound records' starts), so ours keeps its debounce at 300 passes and reads `$0097-$0098` as the cursor's delay, the specification's 1,118 passes (less 55, our scan being slower); the cursor's blink half-cycle is 13 pictures of 2 fields, as ours | [BB] bb10 `scr-prompt-idle` (2026-11-27: the transcript and 100 pictures); bb2, bb10 the sound records' starts; [OWNER-SPEC] the delay's 1,118 passes |
| 68 | The interpreter's costs (section 2, the original's cost model): a digit of a number by the number so far and the digit's bits, the same in a constant, `VAL` and `READ`; a 0 about 925-1000 cycles; a product by its right operand's bytes and bits, not its left one's; `INT` 23 cycles a place it drops; `AND` alike for small and large operands; `MOTOR ON` waits about 25.4 fields with `TIMER` counting, and again when the motor already runs; `MOTOR OFF` of a motor that is off takes nothing | [BB] bb10 `time-literals`, `time-ops`, `time-mul`, `time-int`, `time-motor` |
| 69 | The published entry points: a jump at `$8006`, `$8009`, `$800C`, `$800F`, `$8012` (keyboard, cursor blink, screen, printer, joysticks), `$8015`-`$8027` (the cassette: relay on, off, prepare to write, write a byte, prepare to read, read a byte, read a bit), a word at `$A000`, `$A004`, `$A006`, `$A008`, `$A00C`; nothing published at `$8000-$8005` or after `$8027`; `$8B2D`, `$8C37` and the RAM hooks at `$015E-$01AF` (section 3) | [DOC] Dragon Data Ltd, "Dragon 32 Information for Machine Code Users!" (March 1983), printed pp. 4-5 and PDF p. 7, read from the page images (the text layer has OCR errors) and checked cell by cell by the maintainer's side (2026-11-27) |
| 70 | `EDIT n` prints the line as `LIST` does, then the line's number and a space again, and takes keys: ENTER shows the rest of the line and stores it as a typed line is stored (no `OK` after it, in direct mode or in a program, which ends there); X shows the rest and inserts what is typed; L shows the rest and starts the line again (a third copy); a count of digits and space moves that many characters on, showing them; H deletes the rest and inserts; nD deletes n characters, showing nothing for them (`2D` on `PRINT 7` leaves `INT 7`). `EDIT 99` with no line 99, and `EDIT` with no number, are `?UL ERROR`. The other keys and commands, BREAK, the left arrow in insertion and a full line are ours [OWN] until bb11's `stmt-edit2` and `stmt-edit3` answer them (ours: a key that is no command does nothing; in insertion only a printable key goes in; a line of 250 characters with its number takes no more, and a stored line that lists longer is cut there) | [BB] bb10 `stmt-edit` |

The log grows with every milestone; black-box facts are added with the date of the run they came from.

## 12. The cassette (P1b)

`basic/cassette.inc`. A tape is read and written by the CPU alone [HW]: the 50 Hz interrupt is off while it times
the tape (so `TIMER` does not count then [OWN]). Every block read or written goes through one 255-byte buffer,
`BLKBUF` at `$01DA`, as on the original ([BB] bb8 `cas-cloadm2`, `cas-data-errors`).

* **Reading a bit:** the time from one rising edge of PA0 to the next, counted in loop passes; fewer than `CTHR` is a
  short cycle, a 1. BREAK is not looked at while the cassette reads: a search on a tape with no such file goes on, motor
  running, until a reset, as on the original ([BB] bb5, `cas-errors`: BREAK held, then no `OK` in 10 s); if the input stays quiet after a bit's high half, that half alone decides the bit (`CTHRH`), so a tape that ends right
  after its last block's checksum, with no `$55` after it (as many archived `.cas` files do), still loads.
* **Finding a block:** bits are shifted in until the last eight are `$3C` after a leader (`$55`, or `$AA` a bit
  out) has been heard; then the type, the length, the data and the checksum.
* **Finding a file:** namefile blocks are read until one has the name asked for (any, without a name). Blocks with
  a bad checksum are passed over while searching for a namefile; a file passed over (its namefile met) is read to
  its end-of-file block, and a bad block in it is `?IO ERROR` there, as in the file found ([BB] bb8 `cas-left-open`:
  `SKIPF` over `BAD`, `f BAD`, `?IO ERROR`; `CLOAD "GOOD"` passing it, `S BAD`, `?IO ERROR`).
* **The motor while reading** (`CRDBLK`; [BB] bb8 `cas-multi`, `cas-cloadm2`, `cas-left-open`: the motor's runs): a
  motor that was off is given `CDELAY`, about half a second, before the leader is listened for ([BB] bb10 `cas-timing`
  `data-read`: a block left with 2 `$55` before it after a stop is missed, `?IE ERROR IN 10`; a block with a leader
  of 128 is read, its run ending where the original's does). It
  stops after every namefile read, whatever the file and whether it is wanted, and starts again for the next block
  0.13-0.15 field later (ours: a short wait, `NFDLY`, when nothing is shown, the name's display otherwise, about 0.2
  field); after each block of a gapped file (the gap flag of the last namefile read, kept in `CFGAP`: a search that
  starts in the middle of a file uses that file's) it stops too, passed, skipped or loaded, and starts again at once
  (or once the lines are in: a text program). Machine code and a tokenised program run from their first data block
  to the end of file in one go (`cas-cloadm2`: `BIGMC`, 137.43 then 118.02 fields), and the motor stops after their
  end of file too ([BB] bb6 `cas-errors`: `CODE` passed over in a search, a stop after its end of file).
* **The display** (`CFIND`, and `CRBLK` for the blink), from the top-row flags and `clears` of [BB] bb4 `cas-cloadm`,
  `cas-save-load`, `cas-skipf` and bb5 `cas-display`, `cas-errors`, and the pictures of bb5 (read cell by cell
  against the MC6847's characters), when the cassette is not quiet (`CQUIET`: a data file, or a program running,
  shows nothing, below):
  * `CLOAD`, `CLOADM` and `SKIPF` clear the screen first (the line typed is wiped, not scrolled), then put `S`
    (normal) in the top-left cell; the cursor goes to the start of the second row.
  * The letter in the top-left cell changes between normal and inverse once a block, when the block's leader is
    heard: the records show one change for each block of the tape (the namefile's, each data block's, the end of
    file's), never between blocks, and none for the lone `$55` after a tape's last block (bb6 `cas-errors`: after
    `PROG`, read with a stop at its end of file, `S` stays; ours counts the leader's bits and changes the letter at
    the fourth, a byte and three bits in). On the original it comes about 6 frames after a leader that follows a silence
    starts, and a whole leader (about 32 frames) late for the end-of-file block of a gapped file, whose motor the
    original stops and restarts; ours changes it at the first leader byte heard, so the same change can come up to
    about 30 frames earlier (blink timing only: the same changes in the same order).
  * A namefile met puts the file's name in the top row from the third cell (`S` is then inverse, changed by that
    namefile's leader, so the row reads `s NAME` until the next block). A file passed over is read to its
    end-of-file block, then the screen is cleared again and `S` put back. A search that starts in the middle of a
    file (the tape left after a namefile by `?FM ERROR`) does not clear at that file's end: only a file whose
    namefile it met is cleared away (bb5 `cas-errors`: the third `CLOAD`, `S` changing at `CODE`'s data and end of
    file, no clear, then `F PROG`). The file wanted gets
    `F` (normal) in the top-left cell, written after its name (the flags show the row with the name when the `F`
    lands); its blocks then change the `F` as they come. `SKIPF` shows the file it passes as found, `F NAME`.
  * The prompt or the error prints on the second row, under the top row as it was left: after a load of one data
    block `F NAME` (the data block's leader made it `f`, the end of file's `F` again), after `?IO ERROR` on a bad
    block `f NAME` (the bad block's leader made it inverse) [BB bb5 `cas-errors` clears: `f BAD`, `?IO ERROR`].
    A file of several data blocks ends with `F` or `f` by their number ([BB] bb8 `cas-multi`: `F LONG` after three).
  * In a running program (`CURLIN` not `$FFFF`) `CLOAD`, `CLOADM` and `SKIPF` show nothing: no clear, no letter, no
    name, no blink; `CLOADM` and `SKIPF` then go on with the statement, `CLOAD` ends at `OK` ([BB] bb8
    `cas-in-program`, `cas-cloadm2`: the screen goes on unbroken, no top-row change for `CLOADM` and `SKIPF`). A
    `CLOAD` of a text program sets `CURLIN` to `$FFFF` once its first data block is read (the program is gone), so
    the blocks after it blink as in direct mode: the top-left cell of whatever is on the screen (`cas-in-program`:
    one change for each program of one data block, at its end of file, `oK`).
* **`CLOAD`:** a tokenised program goes to the start of the program area, its links are rebuilt (it may have been
  saved at another address), the variables are cleared, then `OK`. There must be room for a whole block below the
  stack before each one is read, or `?OM ERROR` [OWN]. A text program, and a data file (type 1) [BB bb5
  `cas-errors`], is read a block at a time, the motor stopped after each (it is gapped), and each line goes in as if
  typed, about a field a line on the original ([BB] bb8 `cas-multi`: 4.81, 5.83 and 3.67 fields for `LONG`'s 5, 6 and
  4 lines; ours, its keyword look-up skipping digits and each line relinking only the lines from it on, takes as
  long or up to 0.2 field more, with a wait, `CLNDLY`, for each line). A line without a number is `?DS ERROR` when
  the next line is begun, or the file ends: the lines before it stay ([BB] bb8 `cas-multi`: `f NONUM`, `?DS ERROR`,
  `10 PRINT "BEFORE"` listed; the motor ran for `NONUM`'s first block only, and the next search went on from its
  second), so the error comes at once when more follows in the line's block, and after the next block is read when
  the line is its block's last (bb5 `cas-errors`: the data file `NOTES`, whose one record is its block's last:
  its end-of-file block read first, `F NOTES`, `?DS ERROR`). On another error the half-loaded program is cleared.
  Machine code (type 2) or a type past it: `?FM ERROR` [BB bb5 `cas-errors`: `F CODE`, `?FM ERROR`].
* **A file left open:** `?IO ERROR` during a load leaves the cassette file open, at its end (`EOF(-1)` -1, `PRINT
  #-1` `?FM ERROR`: [BB] bb8 `cas-left-open`). While a file is open (this one, or one `OPEN` made) `OPEN`, `SKIPF`,
  `CSAVE` and `CSAVEM` are `?AO ERROR` without touching the tape (no clear, no motor), and the file stays open
  ([BB] bb5 `cas-errors`: `SKIPF`, the motor not run; bb8 `cas-left-open`: `OPEN "I"` and `CSAVE`, no motor run;
  `cas-data-errors`: after `?AO ERROR` from a second `OPEN`, `CLOSE` still writes the first file's end of file).
  `CLOAD` and `CLOADM` go ahead (bb8 `cas-left-open`: after `SKIPF`'s `?IO ERROR`, `CLOAD "GOOD"` loads); the file
  open is then forgotten [OWN for an output file: no record]. `RUN` closes it, an output file written out as
  `CLOSE` does (`cas-data-errors`); `NEW`, an error (`?/0`) and `?AO ERROR` do not; `CLEAR` and `MOTOR` leave it
  [OWN: no record shows them]. `?FM ERROR` and `?DS ERROR` leave nothing open (bb5 `cas-errors`: the `CLOAD`s
  after them read the tape).
* **`CLOADM`:** to the load address plus the offset; `EXEC` without an address then runs it from the exec address
  plus the offset, kept at `$9D-$9E` ([BB] bb8 `cas-cloadm2`: the bytes `$70 $05` found at 157 and 485, the
  namefile's place in `BLKBUF`; `$72 $05` at 157 after `CLOADM "MCX",512`).
* **Writing:** each bit one cycle of a square wave on the DAC, high then low (`CH0`, `CH1`: delay passes from the
  888625 Hz clock: 812 cycles for a 0 and 434 for a 1 with the bit's own work, 44 more a byte). A block written with
  the motor stopped waits about half a second after starting it (`CDELAY`) and writes a leader of 256 `$55`; a block
  written with the motor running (`CSAVE`'s and `CSAVEM`'s after their first) has none. Then the checksum is worked
  out (19 cycles a data byte, a pause in the signal), and the block follows: its own `$55`, `$3C`, type, length, data
  (each data byte 36 cycles slower than the type's and the length's), checksum and one `$55` ([BB] bb10
  `cas-timing`, `cas-close-pending`, `cas-ascii-save`: the tape decoder reads 258 `$55` before a block written after
  the motor started when it has 8 data bytes or fewer (the one after the block before, the 256 and the block's own),
  and 1, or 2 after an earlier block, when it has 10 or more: the pause splits the signal there and the decoder drops
  the leader, on the original as on ours; the motor's runs: a data byte 36 cycles more than a leader byte, to within
  0.02 field). So the decoded image of a recorded tape (`#tape-rewind`) has no leader before those blocks, and the
  tape player gives a namefile and the block after it 128; a later block of a gapped file, its leader gone, is missed
  while the motor gets up to speed (above), on the original as on ours (bb10 `cas-timing` `data-read`: `?IE ERROR IN
  10`). The motor is stopped after every namefile, `CSAVE`'s and `CSAVEM`'s too. Each character sent to the tape
  (`CSAVE ,A`, `PRINT #-1`) takes about 100 cycles more (`CTDLY`), and each line of `CSAVE ,A` about 6,600 more
  (`LSDLY`, in `LSTLIN`), the original's pace ([BB] bb10 `cas-timing` `data-write`, `cas-close-pending` `open-l-m`:
  the motor's stop while a program prints 255 characters, ours within 0.3 field; `cas-ascii-save`, `cas-timing`
  `csave-ascii`: the stop between the namefile and the text, within 0.05 field, never earlier). `CSAVE` writes the
  program from its start to the end link (from memory, not through the buffer), `CSAVEM` memory from start to end
  inclusive, `CSAVE ,A` a carriage return, then the `LIST` text, each line ended by its carriage return (an empty
  program is one CR in a data block of its own) [BB bb10 `cas-ascii-save`: the data blocks' SHA-256]; the character
  output is sent to the block buffer, written out when full, the motor stopped after each block. Every namefile
  (`CSAVE`, `CSAVE ,A`, `OPEN "O"`) is built in the block buffer over what it last held: its exec and load addresses
  are bytes 11-14 of the last block written or read through the buffer ([BB] bb10 `cas-ascii-save`: `CSAVE "Y",A`
  after `CSAVE "X",A`, `$4849` and `$220D`, `HI"` and CR of X's text; `cas-timing`: `CSAVE "C"` after a text file,
  `$5422` and `$0D00`), `CSAVEM`'s its own.
* **`MOTOR ON`** waits, as writing does: [BB] bb4 `cas-motor-audio`'s `MOTOR
  ON:FOR I=1 TO 500:NEXT:MOTOR OFF` is a run of 54.02 fields, where the loop alone takes about 28.3, so the original
  waits about 25 fields. Ours waits `MOTDLY` passes of 8 cycles (24.85 fields, in `CMSTX`, which `CWBLK` shares with its
  `CDELAY` of 25.95 fields: that one was fitted, with the leader after it, to the write runs, so the two need not be
  one), interrupts off as for the tape: 54.02 fields. Then bb10 `time-motor` [BB]: `TIMER` counts through the wait (25 after it), a second `MOTOR ON` waits again (51), `MOTOR OFF` of a motor that is off takes nothing, and the motor runs 25.44 fields from `MOTOR ON` to `MOTOR OFF`. So `MOTOR ON` now turns the motor on itself, interrupts left on, and always waits `MOTDLY` (56,340 passes of 8 cycles, with the field interrupts 25.6 fields: `TIMER` 26 and 51, ten `MOTOR ON:MOTOR OFF` 256 fields against 254; the runs 25.60, 25.59, 51.11 and 25.52 fields against 25.45, 25.44, 50.72 and 25.31). That is the shortest wait at which neither record is faster on ours: at 57,000 every run was half a field long (each of the program's runs started about 0.5 field later than the one before it, 6.4 fields over 12), and below 56,320 bb4's line takes less than its 54.02 (ours 54.03). Before, a motor already running was not waited for [OWN]. bb8 `cas-left-open`'s `MOTOR ON:MOTOR OFF` (a file left
  open by `?IO ERROR`) took about 2 fields longer on ours than on the original (it took 23 fewer). 11 bytes (15,839, the
  code ending at `$BED1`), and 3 more for bb10's.
* **Data files** [UM for the statements; the forms without `#` from a magazine listing; [BB] bb4 `cas-files` for what
  they do; bb8 `cas-data2`, `cas-data-errors`]: `OPEN "O",#-1,"NAME"` writes a namefile (type 1, ASCII and gaps
  `$FF`) and stops the motor. It is built in the block buffer, only its name, type and flags set: its exec and load
  addresses are what bytes 11-14 of the buffer held, 0 and 0 on a fresh machine, else the last block written or
  read through it (it is the only cassette buffer; `cas-data-errors`: after a block `OPEN ACROSS NEW`, exec `$204E` and load `$4557`, " NEW"). `PRINT #-1,...`
  gathers what it prints in the block buffer, written when full;
  `CLOSE #-1` writes the rest and an end-of-file block, the motor started and stopped for each (the record's three
  motor runs). On the tape a number has no space after it and `;` and `,` each end a record with a carriage return:
  `PRINT #-1,"HELLO";42` writes `HELLO`, CR, ` 42`, CR (the record's data block has the SHA-256 of exactly those
  bytes; what `;` or `,` at the end of the statement and `TAB(` write there is [OWN]). `OPEN "I",#-1,"NAME"` (or
  `""`, or `-1` without `#`) finds the file as `CLOAD` does, and reads its first data block; in a program it shows
  nothing: no clear, no `S` or `F`, no name, no blink (the records' screens are untouched and their top rows never
  change: bb4 `cas-files`, bb8 `cas-data2`); typed, it shows the search as `CLOAD` does, the first data block changing
  the `F` ([BB] bb10 `cas-left-open2`: `OPEN "I",#-1,"GOOD"` typed, the screen cleared, `s`, `F GOOD`, `f GOOD`).
  `EOF(-1)` typed blinks for a block it reads [OWN]. A data file or a program saved as text is read; machine code or a tokenised program is
  `?FM ERROR`, the file not left open (`cas-data2`). Each `INPUT #-1` or
  `LINE INPUT #-1` takes records (lines ended by a carriage return) where a line would be typed, without a prompt, each
  record about 0.11 field slower than the line's own work (`CRDDLY`, [BB] bb10 `cas-timing` `data-read`: the motor's
  stops between the blocks):
  `INPUT #-1,A$` gets the whole record, commas and all, leading spaces dropped (`HELLO,42` from the fixture
  `data-file`), `LINE INPUT #-1` keeps them (` 42`). Numbers split at commas as typed ones do and a variable past
  the record's end takes the next record [OWN]; items left in a record when the variables run out are dropped, no
  `?EXTRA IGNORED` (`cas-data2`: `INPUT #-1,A,B` from `1,2,3`, then `INPUT #-1,C$` gets the next record); a bad
  number is `?FD ERROR` (`cas-data2`).
  `EOF(-1)` is -1 once no data is left (reading the next block if it must). Past the end, `?IE ERROR`. Errors:
  `PRINT #-1` with no file open `?NO ERROR`, `INPUT #-1` in direct mode `?ID ERROR` (before the file is looked at)
  [BB]; with no file in a program `?NO`, the file open the other way `?FM` (also `EOF` of an output file), a mode
  other than `I`/`O` `?FM`, a second `OPEN` while one is open `?AO` (all [BB] bb8 `cas-data-errors`); `OPEN` to the
  screen (`#0`) or the printer (`#-2`) no error, nothing opened or written (`cas-data-errors`); another device `?DN`,
  `CLOSE` with nothing open no error [OWN]. One file at a time: `CLDBAS` is `$FF` while one is open for
  input (as after `?IO ERROR`, which leaves a read open) and `$FE` for output. An error during `PRINT #-1` puts the
  output back on the screen.
* **Syntax:** `CSAVEM` and `CLOADM` are not keywords of their own: they crunch as `CSAVE` / `CLOAD` followed by the
  letter `M` (they `LIST` as typed), so a file name given as an expression cannot start with a variable whose name
  starts with `M` [OWN]. A name longer than 8 characters is cut to 8 [OWN].


## 13. Deliberate differences from the original

Behaviour where ours matches the original's shape on purpose but not its content, because the content is the
original's own text or data, and known differences where the original's behaviour is a fault ours does not
reproduce. Each is recorded with its black-box case.

| Where | The original | Ours | Case |
|---|---|---|---|
| `CLS` with a colour 9-255 | prints a line of its own text (21 characters), then an empty line | prints our own line, `MADE WITHOUT PEEKING` (20 characters, chosen for this BASIC; `OK BOOMER` for `CLS 67`, also ours [OWN]), then an empty line; no error in either | `screen-cls-range` (local-only: its results are never written, only their shape); ours: the own case `cls-range` |
| `POKE 111,254` (output to the printer) | output goes to the printer (the record's wait for one came from an emulator that read the printer's busy line, PIA 1 PB0, as busy: to be recorded again) | output stays on the screen: no printer output is built yet [OWN, open] | `famous-pokes` (its last step) |
| `DLOAD`, `DLOADM` (no serial link) | waits for the serial port: nothing on the screen after 250 fields, and `BREAK` does not bring `OK` back | `?FC ERROR` at once: no serial loading is built [OWN, open] | `stmt-dload` [BB bb10] |
| `PRINT USING` E field of twelve or more places (`"############^^^^";1`) | prints garbage (`%1000000000E-10`) and runs over its own memory (`?SN ERROR IN 0` after it); on a fresh machine (bb10 `using-wide12`) `%1000000000E-10`, `%1234500000E-06%-1000000000E-10` for 12345;-1, BASIC still answering | `?FC ERROR`: a buffer overrun is never reproduced | `review-fixes`, `print-using-exp`, `using-wide12` |

## 14. The cursor

The cursor of the 32K configuration. Sources: black-box observations of the real Dragon 64 ROMs, RAM values and
cycle counts only ([BB] black-box observation (2026-11-25)), and, where those say nothing, the [OWNER-SPEC]
functional specification supplied by the maintainer (2026-11-25). Code: `KEYWT` and `DELAYX` in `basic/keyboard.inc`,
`CHROUT` in `basic/screen.inc`, the cold start's two settings in `basic/boot.inc`, the fixed addresses in
`basic/d64basic.asm`. Tests: `tests/basic-cursor.test.js`; the open questions: the black-box case
`tests/basic/cases/cursor-print.bas` (bb-only).

**How ours works.** While `LINEIN` waits for a key (`KEYWT`), each pass is one cursor update and then one keyboard
scan (`KEYIN`). An update decrements `BLINK` (`$008F`); when the result is 0 it stores 50 there, reads the address in
`CURPOS` (`$0088-$0089`) and toggles bit 6 of the byte at that address; then it runs `DELAYX` with X = `KEYDLY` (`$0097-$0098`, 1,118 at a cold start [BB bb10 `scr-prompt-idle`]) less 55, 1,063 (`LEAX
-1,X` / `BNE`, 8 cycles a pass). With our scan and the field interrupt (104 cycles, as the original's: section 7 of
`docs/clean-room-basic-p2.md`) a pass averages about 9,178 cycles and a transition about 458,900, each within 1% of
the real ROM's (the pass count is the one whose pass is nearest the measured 9,177) (the specification gives the delay as 1,118 passes; ours
is shorter because our scan is slower than the original's, and it is the whole pass that is measured). When a key
is accepted, `KEYWT` writes `$60` at the address in `CURPOS` and returns; `BLINK` is not touched. `CHROUT` moves the
cursor by writing `CURPOS` only, and each character it puts on the screen decrements `BLINK` (at 0 it is reloaded
with 50, the cell not transformed). `INKEY$`, `BREAK` and `SHIFT-@` between statements scan without updates. The
debounce in `KEYIN` waits 300 passes of `DELAYX` before it looks at a new key again.

**Native 64K mode** (not built: the 64K-mode BASIC is out of scope, open question 7): a transition writes `$8F` if
the byte is `$AF` and `$AF` otherwise, chosen by the BASIC configuration running, not by the machine or its RAM;
about 9,885 cycles per decrement and 475,692 per transition [BB].

| Verified requirements (tested by `tests/basic-cursor.test.js` on our ROM) | Source |
|---|---|
| The countdown: 2: the first decrement changes nothing, the second toggles; a transition reloads 50; 51 writes of `$008F` per transition (the reload, then 50 decrements, the last to 0); 0: the next value is 255, no transition | [BB] |
| The transformation: `$60`/`$20`, `$41`/`$01`, `$FF`/`$BF`, both ways | [BB] |
| Every byte 0-255: one transition toggles bit 6 only, two give the byte back | [OWNER-SPEC] |
| A new address in `$0088-$0089` moves the blinking cell | [BB] |
| The countdown's value sets when the next transition comes; a byte written under the cursor is the one transformed; screen memory and the display show the cursor byte; `PEEK(&H88)`, `PEEK(&H89)` and `POKE 143,0` from BASIC | [OWNER-SPEC] |
| An accepted key: the first write to the cell is `$60`; `$008F` untouched | [BB] |
| Moving the cursor does not reset the countdown | [OWNER-SPEC] |
| A running program leaves `$008F` alone, printing included (`GOTO`, `PEEK`, `INKEY$`, an empty `FOR`, `PRINT` with and without a scroll, `PRINT @`, a semigraphics block) | [BB] |
| Cycles per decrement and per transition within 1% of 9,177 and 456,471 | [BB] |
| The same on the Dragon 32 and the Dragon 64 in 32K mode. Not applicable: the native 64K items (our ROM has no 64K mode) | [OWNER-SPEC] |

| Chosen by us [OWN] | |
|---|---|
| The order in a pass | the update first, then the scan; the delay follows every update, a transition's or not |
| The delay | `KEYDLY` less 55 passes of `LEAX -1,X` / `BNE` (8 cycles), in a subroutine (`DELAYX`) shared with the debounce: 1,063 at a cold start, the specification's 1,118 less what our slower scan takes, so the whole pass matches the measured cycles (9,168, 0.1% short); the tolerance, 1%, covers where the field interrupt falls. `KEYDLY` below 56 wraps (a very long delay) |
| `$0097-$0098` | 1,118 at a cold start [BB bb10 `scr-prompt-idle`: `PEEK(151);PEEK(152)` gives 4 94, at the first prompt and after a few lines]; the specification calls it the keyboard's debounce delay, but a debounce of 1,118 passes makes our typed lines about 7,000 cycles later than the original's (the sound records' starts, bb2 and bb10), and 1,118 is the specification's count for the cursor's delay, so ours reads it as that |
| The debounce delay | ours is the wait in `KEYIN` before a newly pressed key is read again (a bounce forgets the key): 300 passes of `DELAYX` (2,400 cycles, as before); we have no auto-repeat |
| Cold start | the direct page is cleared, then `BLINK` is set to 1 (the first update at the prompt takes it to 0, shows the cursor and reloads it); a warm start keeps both values |
| RAM layout | the direct-page variables are nine regions around the fixed addresses (`DPR1`-`DPR9`), and the system block one more (`SYSR1`); `tools/build-basic.js` fails if a region reaches the fixed address after it |

| Assumptions to validate (black-box cases wanted) | |
|---|---|
| The editor's echo | whether the characters the line editor echoes count too (ours: no, as no output does) |
| Update or scan first | whether a key already down when the wait starts is accepted before the first update |
| Cold-start values | `PEEK(143)` right after power-on, and `PEEK(151)*256+PEEK(152)` after the reset button (1,118 at the first prompt after power-on: bb10) |
| The debounce | what the original's delay at `$0097-$0098` times (ours: the cursor's delay); a `POKE` of it and the blink's period, or the keys' pace, after it |
| Where else updates run | whether any other wait (a cassette prompt, the `SHIFT-@` pause) updates the cursor; ours: only the line editor's wait and `EDIT`'s, which is the same `KEYWT` |

**Entry points (input for P3).** Where ROM-call compatibility is in scope, the specification names these addresses
as interfaces, not as places in the original's code. `$8006` and `$8009` are among the published entry points now
built (section 3: `$8006` jumps to `KEYIN`; `$8009` stays `$FF`); what ours does at them is what the manual's page
says, checked by `tests/basic-entry.test.js`, while the original's register, condition-code and stack effects there,
and the native-64K addresses, still need black-box verification before more machine-code compatibility is claimed:

| Address | Interface |
|---|---|
| `$8006` | keyboard polling |
| `$8009` | cursor update |
| `$B538` | blocking keyboard input (32K) |
| `$BBB5` | cursor update (32K) |
| `$BBC5` | the fixed delay (32K) |
| `$BBC8` | the delay's countdown loop (32K) |
| `$BBE5` | keyboard polling (32K) |
**The direct page, toward P3's RAM layout.** This step fixed three addresses and moved: `CURPOS` from `$1A` to
`$88`; every variable from `TIMER` (`$1C`) to `GCDONE` (`$89`) two bytes down (`TIMER` is now `$1A`); `SBSTRT`-`FPK2`
unchanged (`$8A-$8E`); `ATINV`-`PWN` one up (`$90-$94`); `EXECAD` from `$98` to `$95` (moved before `SEED`, so the
region below `$97` is full); `SEED` from `$94` to `$99`; everything after `EXECAD`'s old place three up (`DPEND`
`$C9` to `$CC`). No byte is left unused between the regions. What may have to move later, once
P3's census says which addresses programs use: the program and memory pointers (`TXTTAB`, `VARTAB`, `ARYTAB`,
`ARYEND`, `FRETOP`, `STRBOT`, `MEMTOP`), `TXTPTR` and `CURLIN`, `TIMER`, `CASEFL`, the floating-point accumulators
(`FACEXP`-`ARGSGN`), `EXECAD`, `SEED`, the two-byte calls at `$D0-$FF` (whatever the original keeps there), and in the
system block at `$0100` the RAM vectors, the `DEF USR` table and the cassette's name block. Each new fixed address adds
a region split in `d64basic.asm` and a check in `tools/build-basic.js`, as these three did.

The next step did that for the addresses the black-box records confirmed (section 15): the program and memory
pointers, `CURLIN`, the output device, the cold-start flag, `TXTPTR`, `TRON`, `TIMER` and the lower-case flag are
now at the original's places, in nine direct-page regions and one in the system block; the IRQ handler reads
`TIMER` at `$0112` with an extended `LDX`/`STX` (2 cycles) and drops a `NOP`, so it still takes 104, and the tone
loop's overhead (`TOVH`) is 56 for the same reason (68 since the wave writes its middle level too: P2 section 6).

## 15. Interface contract: BASIC's pointers in low RAM

Programs (in BASIC with `PEEK` and `POKE`, and in machine code) read and set some of the interpreter's own variables
at fixed addresses. Ours keeps them where the original does: each row below was a [DOC] lead (published memory
maps) until the black-box records confirmed it ([BB] bb3 `ram-pointers`, bb6 `famous-pokes`); `d64basic.asm` pins
each one, `tools/build-basic.js` fails if a variable runs into one, and `tests/basic-ram.test.js` checks every
address and replays both records on ours (identical, apart from the lines below that hang on speed or the input
buffer's place).

**Applicability:** the Dragon 32 and the Dragon 64 in 32K mode. **Values:** 16-bit, big-endian
(`PEEK(a)*256+PEEK(a+1)`). **Lifetime:** set at a cold start; the pointers change as the program, variables and
strings change, and `NEW`, `CLEAR`, `PCLEAR`, `RUN` and a load reset some of them.

| Address | What it is | On the original [BB] | Ours (variable) |
|---|---|---|---|
| `$19-1A` | the program's start | `$1E01` at a cold start (`PCLEAR 4`); `POKE 25,6:NEW` puts it at `$0601`, freeing the graphics pages (`MEM` 24841 to 31015) | the same (`TXTTAB`) |
| `$1B-1C` | the simple variables' start (the program's end) | the program's start + 2 after `NEW` | the same (`VARTAB`) |
| `$1D-1E` | the arrays' start | moves up as simple variables are made | the same (`ARYTAB`) |
| `$1F-20` | the arrays' end: free memory from here | moves up with `DIM` | the same (`ARYEND`) |
| `$21-22` | the string space's bottom (the stack's top) | 32566 at a cold start (the top less 200); follows `CLEAR n` | the same (`STRBOT`) |
| `$23-24` | the lowest string in use | the top when no string is in use; `A$="HELLO":B$=A$+"!"` typed in direct mode takes 12 bytes (the literals are copied out of the typed line) | the same (`FRETOP`) |
| `$25-26` | a string-space pointer: one past the end of the last string copied into the string space, or the start of the last one made there when nothing was copied into it (`CHR$`) | [BB `ram-pointers2`, 2026-11-26; bb8 `ram-ptr25`, every value it printed]: in direct mode a literal is copied, so after a `PRINT "S"` it is `$23` + 1; in a program a join, `STR$`, `LEFT$` and an `INPUT` reply move it (a join's temporary in `PRINT` too), a literal, a variable copied, a number, `FOR`, `RUN` and `CLEAR` do not | the same (`STRDST`); our strings sit a byte below the original's (ours from `FRETOP`, the original's from `FRETOP` + 1), so it is our pointer + 1 |
| `$27-28` | the string space's top | 32766 | the same (`MEMTOP`; `CLEAR n,top` takes a top up to 32768 [OWN]) |
| `$68-69` | the line running | `$FFFF` in direct mode | the same (`CURLIN`) |
| `$6F` | where output goes | 0 the screen; 254 the printer (the records' wait for it, bb6 `famous-pokes` and bb10 `stmt-printer`, came from an emulator that read PB0 as busy); 255 the tape | 0 and 255 the same (`DEVNUM`); any other value the screen: no printer output yet (section 13) |
| `$71` | the cold-start flag | 85 (`$55`) once BASIC has started | the same (`WARMFL`) |
| `$9D-9E` | `EXEC`'s address: `CLOADM` puts the file's exec address there, its offset added | [BB] bb8 `cas-cloadm2` (RAM below the screen searched for the bytes) | the same (`EXECAD`) |
| `$A6-A7` | the text pointer | points into the line being run | the same (`TXTPTR`); in direct mode it points into the crunched line at `$02DC`, as the original's does ([BB] `ram-pointers2` (2026-11-26): 757, 761, 765) |
| `$AF` | `TRON` | 79 on, 0 off; `POKE 175,79` turns tracing on | the same (`TRCFLG`) |
| `$0112-0113` | `TIMER` | counts fields; `POKE` to both bytes sets it | the same (`TIMER`) |
| `$0116-0119` | `RND`'s seed, high byte first | the only bytes besides address 4 that one `RND(0)` changes and `SIN(1)` does not ([BB] bb8 `rnd-seq`); they hold the generator's 32-bit state (section 5) | the same (`SEED`); `POKE` to them sets the sequence |
| `$0149` | lower case (`SHIFT-0`) | 255 upper case, 0 lower case; `POKE 329,0` makes typed letters lower case | the same (`CASEFL`; any value but 0 is upper case [OWN]) |

One consequence of the original's places: a reply to `INPUT` is written over the typed line, so a direct `GOSUB` to
a subroutine that asks for a reply longer than what is left of that line comes back to a line that is gone. The
original then ends the line with no error and `OK` ([BB] bb8 `ram-ptr25`: `GOSUB 100:PRINT "AFTER";A$`, the reply
`HELLOWORLDLONGREPLY`): `RETURN` goes on after the line number and passes over the rest of the `GOSUB` statement as
`DATA` does, up to a `:` or the end of the line, and the reply has neither until its end. Ours does the same; the
look costs `RETURN` 24 cycles, taken back from `GOSUB`'s delay (`GSDLY`), so a `GOSUB` and its `RETURN` take as long
as before (ram-pointers2's 500 in 83 fields).

Still to do here: the RAM vectors and hooks
(the [DOC] lead puts the IRQ's `JMP` at `$010C`), and the two-byte calls at `$D0-$FF` (whatever the original keeps
there), which belong to the machine-code interface.
