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
  * **Two-byte calls.** The ten busiest routines (`CHRGET`, `CHRGOT`, `CHROUT`, `FNARGN`, `FPRUN`, `PRTSTR`, `LINGET`,
    `CHKCOM`, `USCHR`, `EVNUM`) each have a `JMP` at the top of the direct page (`ZTRAMP`, `$E2-$FF`), so a call is
    `JSR <ZCHRGET`: two bytes for three, and three cycles more. `tools/build-basic.js` fails if the direct-page
    variables reach them.
  * **Scratch bytes shared.** `ON`'s, `RENUM`'s, `DRAW`'s, `PAINT`'s and `GET`/`PUT`'s work uses `PRINT USING`'s
    bytes; `LOG`, `EXP`, `SIN` and `ATN` share one byte; `RND`'s product is in `PROD`. Each is used inside one
    statement or function that finishes before another of them starts (`d64basic.asm` says so at each).
  * **`FPRUN`** (`mathfn.inc`) runs a list of one-byte steps (store, load, multiply, add, divide, subtract, each
    with a temporary or a constant), in place of a load and a call for each step. The numeric functions do the same
    operations in the same order as before, so their results are the same bits.
  * **Two tables for five series.** A series with alternating signs is evaluated in -x^2 with unsigned coefficients;
    every step of Horner's rule then differs from the signed one only in its sign, and the result is the same bits.
  * A line number is printed by `PRINT USING`'s decimal converter (`U32DEC`), which uses `FACM`: line numbers are
    only printed between statements.
* **Running it:** `m.setRoms({ basic: rom, basic64: null })` on a `dragon64` machine (Node), or
  `node tools/build-basic.js --out /tmp/d64_1.rom` then `node cli/cloadm.js --roms /tmp/d64_1.rom --type 'PRINT 2+2\n' --screen`.

## 3. Memory map

### ROM (`$8000-$BFFF`)

| Range | Use |
|---|---|
| `$8000-$80FF` | reserved, `$FF` in P1 (a likely home for P3 entry points; nothing of ours is placed there) |
| `$8100-...` | the modules, in the order of section 4, packed |
| `...-$BFDF` | free space (P2, P3) |
| `$BFF0-$BFFF` | the hardware vectors (the SAM maps `$FFF0-$FFFF` here [HW]) |

P3 has to place code at fixed addresses that ours may already occupy. The plan for that is to keep every module
relocatable (no absolute address inside a module except through a label) so P3 can reorder modules and leave holes
where its entry points go; `tools/build-basic.js` checks for overlap, so a collision fails the build instead of
corrupting the image.

### RAM (our own layout; P3 may move variables to match what programs read)

| Range | Use |
|---|---|
| `$0000-$00FF` | the direct page: the interpreter's variables (pointers, the two floating-point accumulators, the text pointer, flags, P2's current mode, start page and colour byte, `DRAW`'s angle and scale) up to `DPEND` (`$CC`), 22 bytes free, laid out around three fixed addresses programs use: `$0088-$0089` the cursor's address (`CURPOS`), `$008F` its blink countdown (`BLINK`), `$0097-$0098` the debounce delay (`KEYDLY`) ([section 14](#14-the-cursor)), then the two-byte calls' `JMP`s at `$E2-$FF` (`ZTRAMP`; section 2, the size budget), copied from the ROM with the RAM vectors at a cold start. DP is 0 throughout |
| `$0100-$01FF` | the system RAM block, laid out by `RMB` in `d64basic.asm` (so nothing overlaps; the build fails if it reaches `$0200`): the RAM jump vectors (IRQ, FIRQ, NMI, SWI, SWI2, SWI3), so a program can hook an interrupt [OWN; addresses to align in P3]; the `DEF USR` addresses; the keyboard's rollover table; the 8 temporary string descriptors; `FOR`'s step and limit; the numeric functions' temporaries; the number conversion and `PRINT USING` buffer; the cassette's name block; P2's colours, colour set, last point and a point read; the four `JOYSTK` values and `PLAY`'s octave, length and its dots, tempo and volume |
| `$0200-$02FF` | the line input buffer (250 characters + terminator); `VAL` reads its copy of a string here |
| `$0300-$03FF` | the crunched line |
| `$0400-$05FF` | the text screen, 32 x 16 [HW: the SAM's reset display offset] |
| `$0600-$1DFF` | the graphics pages: `PCLEAR n` reserves n 1.5 K pages from `$0600` (1-8; 4 at cold start) and the program follows them; `CLOAD` of a text file reads each block into `$0600-$06FE` before its lines go in [OWN] |
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
| `print.inc` | `PRINT` (`;`, `,`, `TAB(`, `@`), `?` |
| `flow.inc` | `IF` / `THEN` / `ELSE`, `FOR` / `NEXT`, `ON ... GOTO/GOSUB` |
| `strfunc.inc` | `LEN`, `ASC`, `CHR$`, `LEFT$`, `RIGHT$`, `MID$`, `STR$`, `VAL`, `INSTR`, `STRING$`, `HEX$`, `INKEY$`, `CLEAR` |
| `mathfn.inc` | `INT`, `FIX`, `ABS`, `SGN`, `SQR`, `LOG`, `EXP`, `SIN`, `COS`, `TAN`, `ATN`, `^`, `RND` (constants: the generated `mathconst.inc`) |
| `misc.inc` | `PEEK`, `POKE`, `EXEC`, `USR` / `DEF USR`, `DEF FN` / `FN`, `VARPTR`, `MEM`, `POS`, `TIMER` |
| `io.inc` | `READ` / `DATA` / `RESTORE`, `INPUT`, `LINE INPUT` |
| `using.inc` | `PRINT USING` |
| `fp.inc` | the floating-point core: unpack / pack, add, subtract, multiply, divide, compare, normalise and round |
| `fpconv.inc` | integers to and from FAC, number to text (`FOUT`) and text to number (`FIN`), the powers of ten |
| `tokens.inc` | generated from `tokens.json`: the token equates, keyword tables and dispatch tables. A keyword table is the words in token order from `$80`, each ending in a letter with bit 7 set: a word's token is its place in the table (a token with no word between two others is one `$FF` byte) |
| `cassette.inc` | `CSAVE` (`,A` for text), `CLOAD`, `CSAVEM`, `CLOADM`, `SKIPF`, `MOTOR`: reading and writing bits, blocks and files on the tape (section 12) |
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
* **Scaling by powers of ten:** printing scales the number into `[1E8, 1E9)` and reading a number scales its
  digits by its decimal exponent, each in steps of `1E9` while far off and then one product or quotient by an exact
  power of ten (`10^0`-`10^13` are exact in 32 bits), so most numbers see one rounding; repeated steps of 10 printed
  `1/3` as `.333333334`.
* **Printing** [UM, BB]: up to nine significant digits, a leading space for a positive number and `-` for a negative
  one, a trailing space after a number in `PRINT`, E notation outside a range (to be pinned by black-box cases:
  `PRINT 1E8, 1E9, .01, .001, 123456789, 1234567890`), the exponent as `E+nn` / `E-nn`.
* **Transcendental functions:** our own polynomial or rational approximations (coefficients we derive and document,
  with their error bounds). The original's coefficients are not visible to us, so `SIN`, `LOG` and the others may
  differ from it in the last printed digit for some arguments. Black-box cases measure how often; the target is the
  same printed value for the cases in the manuals and close agreement elsewhere (open question 4).
* **`RND`:** the sequence after cold start is visible to programs. The original's generator is unknown to us; if the
  black-box values of `RND(0)`/`RND(1)` sequences let us identify a generator that reproduces them, we adopt it,
  otherwise ours is a documented linear congruential generator (open question 5).

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
  (`?IO ERROR` on a bad checksum, `?FM ERROR`, `?DS ERROR`, BREAK) and name search and `SKIPF`.
* **`tests/basic-cursor.test.js`:** the cursor ([section 14](#14-the-cursor)): the countdown, the transformation of
  every byte, the RAM it reads (address, countdown, the byte under it, the debounce delay), the keyboard, the delay
  in cycles, on the Dragon 64 and the Dragon 32, with mutants of the ROM that must fail it.
* **`tests/basic-editor.test.js`:** the keyboard and screen through the matrix: typing, erasing, SHIFT-0, BREAK during
  a program and during `LIST`, scrolling, `CLS`, the cursor.
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
  keys held together: `SHIFT+LEFT`, `SHIFT+0`, `CLEAR`), `#break`, `#frames N`, `#wait-text REGEX`, `#timeout S`,
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
  how many periods and writes, how many distinct levels, the lowest and highest level. For the window: its length,
  the DAC writes and those heard, a SHA-256 of every event (to tell runs apart) and the sound switch at `#wav-stop`.
  `compare.js` compares the periods within 0.5%, the lengths and the silences between tones within one field (17,784
  cycles), the lowest and highest levels and the end state exactly; the number of levels and writes (the wave's shape,
  which is ours: P2 decision 3) and the hash are not compared.
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
  It holds nothing but screen text, the pictures (`shots`) and sound measures (`sounds`) a case asked for, and the
  ROM's CRC (to tell runs apart); no ROM bytes.
* **The token probe** (`tests/basic/cases/probe-tokens.bas`): one program line per keyword (after `END:`, so never
  run), then a program that searches RAM below `$8000` for a marker it placed in a `REM` and prints each following
  line's number, bytes in hex and whether its link points at the next line. This gives
  every keyword's token value and confirms the program line layout, without looking at the ROM. Similar probes
  give the program's start address (`MEM`, and a marker search), the variable and descriptor layouts (`VARPTR`), and
  the RND sequence.
* **The lint** (`tools/basic-bb/lint.js`, also run by `run.js` and the tests): refuses `EXEC`, `USR`, `DEFUSR`,
  `CLOADM` (except as the tape rule below allows), `CSAVEM` and `VARPTR`, and a `PEEK` or `POKE` whose address is not a literal below 32768 or an
  expression ending in `AND 32767` with no `OR` (computed addresses included), so a case can neither read the ROM nor
  find a string descriptor to point into it. A line starting with `END:` is not checked (it is never run past the
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
  file on those fixtures is machine code loading within memory a first line `CLEAR n,top` set aside, and no offset
  is given: it then loads our own bytes, which `PEEK` may read back, and with `EXEC` refused and the run-time guard
  nothing runs them (`cas-cloadm`).
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
5. **`RND`. Decided:** not required in P1; recovering the exact sequence from black-box output in M8 is a goal, since
   games depend on it.
6. **P2 keywords in P1. Decided:** they crunch, `LIST` and save correctly; at run time they give whatever error the
   black-box shows, `?FC ERROR` until then.
7. **The 64K-mode BASIC. Decided:** out of scope (32K mode only).
8. **The serial port. Decided:** later.
9. **The black-box round trip. Decided:** runs are done on the maintainer's machine, hours per round trip, so cases
   go in batches: a pushed commit whose cases pass the lint, and the command to run. Reference results may also come
   from a real Dragon, by hand (section 7).
10. **The cassette's visible details. Open:** what the original prints while it searches and finds (ours: `SEARCHING`,
   `FOUND name`, `SKIP name`, placeholders until a black-box run); the exec and load addresses it writes in a BASIC
   program's namefile (ours: 0 and 0); whether `CLOADM`'s offset also moves the exec address (ours: yes); whether a
   `CLOAD` run inside a program returns to `OK` (ours: yes) and `CLOADM` and `SKIPF` go on with the statement (ours:
   yes); the leader length and the timing around the motor (ours: 128 bytes, half a second); what `SKIPF` does with
   a bad block (ours: nothing). Each is a single place in `basic/cassette.inc`.

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
| 14 | The numeric functions: Taylor series after a reduction (Cody-Waite for `SIN` and `COS`; base 2 for `LOG` and `EXP`: `LOG` is (ln m / ln 2 + e) ln 2, `EXP` 2^n e^((t - n) ln 2) for t = x / ln 2 rounded, n = `INT(t)`, which gives the real's `SQR(1E10)`, `SQR(144)`, `SQR(65536)` and `EXP(11.5129255)` bit for bit); the constants (pi, ln 2, sqrt 3 to 36 digits, 1/k!) | [OWN], `tools/basic-consts.js`; the base 2 from [BB] bb2, `fn-sqr-bits`; measured against the exact values (`tests/basic-math.test.js`: within 2 units in the last place, `EXP` within 3 + abs(x) (the rounding of t, as the real's), `^` within 64) |
| 15 | `RND`: seed x 1664525 + 1013904223 mod 2^32 (a published linear congruential generator) | [OWN]; the original's sequence is unknown (open question 5) |
| 13 | The floating-point algorithms (rounding, guard bits, division, scaling by powers of ten). Printing scales a number into [1E8, 1E9) by steps of 1E9 from 1E17 down and below 1, then by single steps of 10, each rounded: the real prints its `SQR(1E10)`, 1E5 - 6 x 2^-15, as `99999.9999`, which four rounded steps give (one product by 1E4 gives `99999.9998`); a number printed and read back can then print one unit away in the ninth digit | [OWN], [MBF]; the steps from [BB] bb1, `fn-math` and bb2, `fn-sqr-bits`; tested bit for bit against `tests/basic/fpmodel.js` (`tests/basic-fp.test.js`) |
| 16 | The cassette statements and their syntax: `CSAVE "name"[,A]`, `CLOAD ["name"]`, `CSAVEM "name",start,end,exec`, `CLOADM ["name"[,offset]]`, `SKIPF ["name"]`, `MOTOR ON` / `OFF`; `?IO ERROR` for a tape that will not read | [UM] |
| 17 | The tape's bits: one full cycle per bit, 1200 Hz for 0 and 2400 Hz for 1, least significant bit first | [FMT] published descriptions of the Dragon / CoCo cassette format; the same in the repository's tape code (`js/media/cassette.js`, run as the test oracle) |
| 18 | A block: a leader of `$55` bytes, the sync byte `$3C`, the block type (`$00` namefile, `$01` data, `$FF` end of file), the length, up to 255 data bytes, the checksum (the sum of type, length and data, modulo 256) | [FMT] |
| 19 | The namefile block's 15 bytes: the name padded with spaces to 8, the file type (0 BASIC, 1 data, 2 machine code), the ASCII flag, the gap flag (`$FF` each for a text file), the exec address and the load address (big-endian) | [FMT] |
| 20 | A text (ASCII) program is its `LIST` text, lines ended by a carriage return, in gapped blocks (the motor stops between them) | [FMT] |
| 21 | Our writer: 128 leader bytes before every block and one `$55` after it; a square wave on the DAC; half a second of motor run before the first block | [FMT] for the block layout, which the repository's encoder (`buildCas`) also writes; the counts and the wave are [OWN] constants (`CLEADN`, `CDELAY`), open question 10 |
| 22 | The cassette hardware: the DAC (PIA 1 port A bits 2-7) drives the output, PA0 reads the input, CA2 runs the motor; the CPU clock is 888625 Hz | [HW] `js/machines/cocopia.js`, the machine's `tickHz` |
| 23 | `CLS c` fills the screen with colour c, 0-8; a colour's block is the semigraphics-4 character with all four elements lit and the colour in bits 4-6 (0: black, no element lit). A colour is truncated (8.5 is 8, 9.5 is 9). A colour 9-255 is no error: the screen is not cleared, one line of text is printed, the same for every colour, then an empty line; past 255, below 0 and `1E3`, `?FC ERROR` | [UM] for `CLS c`; [HW] the MC6847 data sheet for the character; [BB] bb2, `screen-cls` for 0-8 and the local-only `screen-cls-range` and its boundary run (8/9, 255/256, -1, 8.5, 9.5, 255.9, 1E3) for the shape past 8 (on the original that line is ROM text, 21 characters); ours prints our own line there, `MADE WITHOUT PEEKING` (`OK BOOMER` for 67, [OWN]), never the original's text: a deliberate difference (section 13) |
| 24 | `BREAK` and `BREAK IN n` follow one carriage return whatever the column, after `STOP` and after BREAK (in a program and in `INPUT`): an empty line when the cursor was at the start of a line, else just the end of that line (`PRINT "X";:STOP` shows `X`, then `BREAK IN 10`); an error message does not | [BB] bb1, `flow-cont` (and `io-data`, `review-fixes` for errors); bb2, `flow-stop-col` |
| 25 | `CONT` after a program ran off its end is no error: it ends again (`OK`) | [BB] bb1, `flow-cont` |
| 26 | `SQR(x)` is not a square root rounded once: `SQR(1E10)` prints `99999.9999` and is 1E5 - 6 x 2^-15; `SQR(144)` is 12 - 3 x 2^-28, `SQR(65536)` 256. Ours is `x^.5`, `EXP(.5 LOG x)` with `LOG` and `EXP` in base 2 (row 14), which gives those bits; `SQR(1E8)` (the real's is 1E4 + 2 units, ours 1 unit), `SQR(.5)` and `TAN(1)` still differ in the last place | [BB] bb1, `fn-math`; bb2, `fn-sqr-bits` |
| 27 | `DEF FN` with a string name (`DEF FN A$(X)=...`) is `?TM ERROR` when the `DEF` runs | [BB] bb1, `fn-misc` |
| 28 | `RESTORE` takes no line number: `RESTORE 20` is `?SN ERROR`; a bad number in `DATA` is `?SN ERROR` in the `DATA`'s line | [BB] bb1, `io-data` |
| 29 | `PRINT USING` E notation: with no `+` or `-` in the field, its first place is the sign's (a space or `-`): `"##.##^^^^";12345` is ` 1.23E+04`. When that place is the last before the point it shows `0` for a positive number (`"#.##^^^^"`: `0.12E+04`, `-.12E+04`); with no `#` before the point it is the first place after it, always `0`, and a `-` does not fit (`".##^^^^"`: `.01E+05`, `%-.01E+05`). Ten places print right (` 100000000E-08`); eleven print a value ten times too small (`  100000000E-09`), and ours reproduces it: the digits stay FOUT's nine, the exponent is counted for ten digits and the tenth place shows nothing, so the body is one shorter and lies a place further right. The same rule holds for other values and a sign of the field's own; in a field with a point the tenth place, a decimal, shows `0` instead (`"#######.####^^^^";12345` is ` 123450.0000E-01`). A field with ten places before the point and none after it is [OWN] (as with no point). Twelve print garbage (`%1000000000E-10`, then `?SN ERROR IN 0`: the field has run over the original's own memory); ours keeps `?FC ERROR` there (section 13) | [BB] bb1, `print-using`, `review-fixes`; bb2 and bb3, `print-using-exp` |
| 30 | `VAL` puts a 0 after its string while it reads the number and an error leaves it there: after `40 X=VAL("1E99")` overflows, `LIST 40` shows `40 X=VAL("1E99` | [BB] bb1, `review-fixes` |
| 31 | `PRINT @n, USING ...` | [UM] (both forms documented); found by the corpus programs |
| 32 | `ELSE` and `'` are stored with a `:` before them (`END:ELSE` is `8A 3A 3A 84`, `PRINT'A` is `87 3A 83 41`, `THEN 10 ELSE 20` ends `30 20 3A 84 20 32 30`); ours does not show that `:` in `LIST` [OWN, case `crunch-else`] | [BB] bb1, `probe-tokens` |
| 33 | `RENUM` follows the line numbers after `GO TO`, `GO SUB`, `THEN`, `ELSE` and in `ON`'s lists; a number after `RUN` or `RESTORE` is left as it is | [BB] bb2, `renum` |
| 34 | A number's exponent is read into one byte that wraps: `VAL("1E997")` is no error (997 is 229 in a byte, -27 as a signed one: ours reads 1E-27), where `VAL("1E99")` is `?OV ERROR` | [BB] bb2, `str-val-cut` (no error; the value is our inference, not yet observed) |
| 35 | The cursor's state is in RAM: `$0088-$0089` the address of the cell it is at (big-endian; poking it moves the blinking cell), `$008F` the blink countdown; `$0097-$0098` the keyboard's debounce delay (big-endian) | [BB] black-box observation (2026-11-25) for `$0088-$0089` and `$008F`; [OWNER-SPEC] for `$0097-$0098` |
| 36 | While BASIC waits for a key the countdown is decremented (unsigned: 0 goes to 255 with no blink); the decrement that reaches 0 transforms the cell and the countdown is reloaded with 50, so a countdown of 2 blinks on its second decrement and a transition takes 51 writes of `$008F` (the reload and 50 decrements). About 9,177 cycles per decrement and 456,471 per transition (513 ms) in 32K mode | [BB] black-box observation (2026-11-25) |
| 37 | In 32K mode (the Dragon 32 and the Dragon 64's 32K mode alike) a transition toggles bit 6 of the byte and keeps the others: $20 and $60, $41 and $01, $FF and $BF | [BB] black-box observation (2026-11-25); that the Dragon 32 is the same, [OWNER-SPEC] |
| 38 | A key accepted: the first write to the cursor's cell is `$60`, and `$008F` is not touched | [BB] black-box observation (2026-11-25) |
| 39 | A running program that writes nothing to the screen (`GOTO` loops, `PEEK`, `INKEY$`, an empty `FOR` loop) leaves `$008F` alone; one that writes to the screen counts it down | [BB] black-box observation (2026-11-25) (the specification said only the keyboard wait does: corrected) |
| 40 | The cursor is updated by the keyboard wait, not by a timer, with a fixed delay after each update; the address is read from RAM at each transition; no copy of the byte under the cursor is kept; moving the cursor does not restart the blink | [OWNER-SPEC] |
| 41 | Native 64K mode (not built): a transition writes `$8F` over `$AF` and `$AF` over anything else; about 9,885 cycles per decrement, 475,692 per transition | [BB] black-box observation (2026-11-25) |
| 42 | The field interrupt, from its entry to its `RTI`, takes 104 cycles: it lengthens the period it falls in by that much (octave 1's C to G medians are 104 cycles over their periods); ours pads `IRQSRV` to the same (it took 66) | [BB] bb2, `snd-play-pitch` (docs/clean-room-basic-p2.md section 6) |

The log grows with every milestone; black-box facts are added with the date of the run they came from.

## 12. The cassette (P1b)

`basic/cassette.inc`. A tape is read and written by the CPU alone [HW]: the 50 Hz interrupt is off while it times
the tape (so `TIMER` does not count then [OWN]), and the motor runs through a file (a text file's gaps aside).

* **Reading a bit:** the time from one rising edge of PA0 to the next, counted in loop passes; fewer than `CTHR` is a
  short cycle, a 1. While the input is quiet BREAK is looked at, and stops the statement (back to `OK`, the motor off);
  if it stays quiet after a bit's high half, that half alone decides the bit (`CTHRH`), so a tape that ends right
  after its last block's checksum, with no `$55` after it (as many archived `.cas` files do), still loads.
* **Finding a block:** bits are shifted in until the last eight are `$3C` after a leader (`$55`, or `$AA` a bit
  out) has been heard; then the type, the length, the data and the checksum.
* **Finding a file:** namefile blocks are read until one has the name asked for (any, without a name); each one met
  prints `FOUND name` or `SKIP name` [OWN]. Blocks with a bad checksum are passed over while searching; once the
  file is found, a bad block or a block out of place is `?IO ERROR`.
* **`CLOAD`:** a tokenised program goes to the start of the program area, its links are rebuilt (it may have been
  saved at another address), the variables are cleared, then `OK`. There must be room for a whole block below the
  stack before each one is read, or `?OM ERROR` [OWN]. A text program is read a block at a time, the motor stopped
  after each (it is gapped), and each line goes in as if typed (`?DS ERROR` for a line without a number). On an
  error the half-loaded program is cleared. A file of the wrong type: `?FM ERROR` [OWN].
* **`CLOADM`:** to the load address plus the offset; `EXEC` without an address then runs it from the exec address
  plus the offset.
* **Writing:** each bit one cycle of a square wave on the DAC, high then low (`CH0`, `CH1`: delay passes from the
  888625 Hz clock); before each block a leader of 128 `$55` bytes, after it one `$55`. `CSAVE` writes the program
  from its start to the end link, `CSAVEM` memory from start to end inclusive, `CSAVE ,A` the `LIST` text (the
  character output is sent to a 255-byte block buffer at `LINBUF`, written out when full, the motor stopped after
  each block).
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
| `PRINT USING` E field of twelve or more places (`"############^^^^";1`) | prints garbage (`%1000000000E-10`) and runs over its own memory (`?SN ERROR IN 0` after it) | `?FC ERROR`: a buffer overrun is never reproduced | `review-fixes`, `print-using-exp` |

## 14. The cursor

The cursor of the 32K configuration. Sources: black-box observations of the real Dragon 64 ROMs, RAM values and
cycle counts only ([BB] black-box observation (2026-11-25)), and, where those say nothing, the [OWNER-SPEC]
functional specification supplied by the maintainer (2026-11-25). Code: `KEYWT` and `DELAYX` in `basic/keyboard.inc`,
`CHROUT` in `basic/screen.inc`, the cold start's two settings in `basic/boot.inc`, the fixed addresses in
`basic/d64basic.asm`. Tests: `tests/basic-cursor.test.js`; the open questions: the black-box case
`tests/basic/cases/cursor-print.bas` (bb-only).

**How ours works.** While `LINEIN` waits for a key (`KEYWT`), each pass is one cursor update and then one keyboard
scan (`KEYIN`). An update decrements `BLINK` (`$008F`); when the result is 0 it stores 50 there, reads the address in
`CURPOS` (`$0088-$0089`) and toggles bit 6 of the byte at that address; then it runs `DELAYX` with X = 1,065 (`LEAX
-1,X` / `BNE`, 8 cycles a pass). With our scan and the field interrupt (104 cycles, as the original's: section 7 of
`docs/clean-room-basic-p2.md`) a pass averages about 9,178 cycles and a transition about 458,900, each within 1% of
the real ROM's (the pass count is the one whose pass is nearest the measured 9,177) (the specification gives the delay as 1,118 passes; ours
is shorter because our scan is slower than the original's, and it is the whole pass that is measured). When a key
is accepted, `KEYWT` writes `$60` at the address in `CURPOS` and returns; `BLINK` is not touched. `CHROUT` moves the
cursor by writing `CURPOS` only, and each character it puts on the screen decrements `BLINK` (at 0 it is reloaded
with 50, the cell not transformed). `INKEY$`, `BREAK` and `SHIFT-@` between statements scan without updates. The
debounce in `KEYIN` waits `KEYDLY` (`$0097-$0098`) passes of `DELAYX` before it looks at a new key again.

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
| A running program that prints nothing (`GOTO`, `PEEK`, `INKEY$`, an empty `FOR`) leaves `$008F` alone; one that prints counts it down | [BB] |
| Cycles per decrement and per transition within 1% of 9,177 and 456,471 | [BB] |
| The same on the Dragon 32 and the Dragon 64 in 32K mode. Not applicable: the native 64K items (our ROM has no 64K mode) | [OWNER-SPEC] |

| Chosen by us [OWN] | |
|---|---|
| The order in a pass | the update first, then the scan; the delay follows every update, a transition's or not |
| The delay | 1,065 passes of `LEAX -1,X` / `BNE` (8 cycles), in a subroutine (`DELAYX`) shared with the debounce, chosen so the whole pass matches the measured cycles; the tolerance, 1%, covers where the field interrupt falls |
| Output | one decrement per character `CHROUT` puts on the screen (text and semigraphics; not a carriage return, a backspace, `CLS` or `PRINT @`'s move); at 0, a reload to 50 and no transformation, so output never leaves an inverted cell behind |
| The debounce delay | ours is the wait in `KEYIN` before a newly pressed key is read again (a bounce forgets the key): `KEYDLY` passes of `DELAYX`, 300 at a cold start (2,400 cycles, as before), 0 meaning 65,536; we have no auto-repeat |
| Cold start | the direct page is cleared, then `BLINK` is set to 1 (the banner's first character takes it to 0 and it is reloaded); a warm start keeps both values |
| RAM layout | the direct-page variables are three regions around the fixed addresses (`DPR1`-`DPR3`); `tools/build-basic.js` fails if a region reaches the fixed address after it |

| Assumptions to validate (black-box cases wanted) | |
|---|---|
| Output | how many decrements a character takes; whether a carriage return, `CLS`, `PRINT @` or a semigraphics block count; what happens at 0 during output (wrap, reload, transformation): `cursor-print.bas` |
| The editor's echo | whether the characters the line editor echoes count too (ours: yes, as any output) |
| Update or scan first | whether a key already down when the wait starts is accepted before the first update |
| Cold-start values | `PEEK(143)` and `PEEK(151)*256+PEEK(152)` right after power-on and after the reset button |
| The debounce | what the original's delay at `$0097-$0098` times, and its value |
| Where else updates run | whether any other wait (a cassette prompt, `EDIT`, the `SHIFT-@` pause) updates the cursor; ours: only the line editor's wait |

**Entry points (input for P3, not built).** Where ROM-call compatibility is in scope, the specification names these
addresses as interfaces, not as places in the original's code. Register, condition-code and stack effects, and the
native-64K addresses, need black-box verification before any machine-code compatibility is claimed:

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
(`FACEXP`-`ARGSGN`), `EXECAD`, `SEED`, the two-byte calls at `$E2-$FF` (whatever the original keeps there), and in the
system block at `$0100` the RAM vectors, the `DEF USR` table and the cassette's name block. Each new fixed address adds
a region split in `d64basic.asm` and a check in `tools/build-basic.js`, as these three did.

## 15. Interface contract: BASIC's pointers in low RAM

Programs (in BASIC with `PEEK` and `POKE`, and in machine code) read and set some of the interpreter's own variables
at fixed addresses. This section is the contract for those addresses, one row each, to be confirmed before P3 moves
ours there. The leads are [DOC]: published memory maps, which may contain errors, so each is a lead until the
black-box case `ram-pointers` (bb-only) confirms it. Ours does not follow them yet (our own layout, section 3); the
column "ours" says what our `PEEK` there shows now and where our own variable for the same thing is.

**Applicability:** the Dragon 32 and the Dragon 64 in 32K mode (the leads are the same addresses for both). **Values:**
16-bit, big-endian (`PEEK(a)*256+PEEK(a+1)`). **Lifetime:** set at a cold start; the pointers change as the program,
variables and strings change, and `NEW`, `CLEAR`, `PCLEAR`, `RUN` and a load reset some of them. **Evidence and
confidence:** [DOC] only, low until `ram-pointers` comes back from the real ROM. **Tests:** `ram-pointers` (the
real run to compare with `node tools/basic-bb/compare.js`); ours runs it to completion today.

| Address | [DOC] lead: identity | Initial state and changes the lead implies | Read / write | Ours now (our variable) |
|---|---|---|---|---|
| `$19-1A` | the program's start | `$1E01` at a cold start (`PCLEAR 4`); moves with `PCLEAR` | read; written by `PCLEAR` | another variable's bytes (2, 8, 14 ...); ours is `TXTTAB` at `$04` |
| `$1B-1C` | the simple variables' start (the program's end) | the program's start + 2 after `NEW`; grows as lines are typed | read | not a pointer; `VARTAB` `$06` |
| `$1D-1E` | the arrays' start | moves up as simple variables are created | read | 0; `ARYTAB` `$08` |
| `$1F-20` | the arrays' end, free memory from here | moves up with `DIM` | read | not a pointer; `ARYEND` `$0A` |
| `$21-22` | the bottom of string space (the stack's top) | moves down with `CLEAR n` and `PCLEAR` | read | not a pointer; `STRBOT` `$0E` |
| `$23-24` | the next free string (strings grow down from the top) | the top of string space when empty; moves down as strings are assigned | read | not a pointer; `FRETOP` `$0C` |
| `$27-28` | the top of BASIC's memory | near `$7FFF` in 32K mode; set by `CLEAR n,top` | read; written by `CLEAR` | `CLEAR`'s last size (200, then 500); `MEMTOP` `$10` |
| `$68-69` | the line running, `$FFFF` in direct mode | set by each line as it runs | read | 302 always; `CURLIN` `$02` |
| `$A6-A7` | the text pointer (the next character the interpreter reads) | moves as each statement is read | read; a program may set it | 0; `TXTPTR` `$00` (ours points at the last character taken) |
| `$0112-0113` | `TIMER` | counts fields (50 Hz); `TIMER=n` sets it | read and write | 0 (our `DEF USR` table); `TIMER` `$1A` |
| `$71` | the restart flag: `$55` after a cold start keeps the program over the reset button | `$55` once BASIC has started | read; a program clears it to force a cold start | 127; `WARMFL` `$1C` |

What `ram-pointers` records for each, to confirm: the values after `NEW`, after a 3-line program, after `A=5:B=6:DIM
C(10)`, after two strings, after `CLEAR 500` and after `PCLEAR 2` (with `MEM` beside them); `$68-69` printed from
lines 100, 200, 300 and from a subroutine at 1000, and in direct mode; `$A6-A7` from lines 100 and 200 and direct
mode; `TIMER` against `$0112-0113` read just before it and after `TIMER=1000`; `$71` at the prompt.
