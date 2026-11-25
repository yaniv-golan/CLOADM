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
  * **[HW]** the hardware as this repository already models it from data sheets: SAM, VDG, PIAs, the keyboard
    matrix (`js/machines/keyboards.js`);
  * **[OWN]** our own decisions, where nothing visible to a BASIC program depends on them.
* **No ROM of any kind** in the repository, CI or tests. The ROM is assembled from source at test time; no binary of
  it is committed in P1 ([open question 1](#10-open-questions)). The public suite passes with no ROM.
* **Black-box cases never read ROM.** A case must not `PEEK`, `EXEC` or `USR` into `$8000-$FEFF`, nor print anything
  computed from ROM bytes, so the recorded outputs we receive never carry ROM contents. The harness refuses a case
  that does (`tools/basic-bb/lint.js`).

## 2. Source and build

* **Source:** `basic/` at the repository root (not served, so not in `sw.js`): `basic/d64basic.asm` is the main file,
  which `INCLUDE`s one file per module (section 4). Plain 6809 assembly for the repository's own assembler
  (`js/asm/`), no macros, no conditional assembly beyond the assembler's `IF` on defines.
* **Build:** `tools/build-basic.js` assembles it with `Emu.assemble(src, '6809', { include })`, lays the segments into
  a 16 K image for `$8000-$BFFF` (unused bytes `$FF`), and fails if any segment falls outside that range or two
  segments overlap. It exports `buildBasic() -> { rom, symbols, listing }` for the tests, and with `--out FILE`
  writes the image (for the maintainer, or `cli/cloadm.js --roms FILE`; the file is named `d64_1.rom` so the
  socket takes it by name, and shows as "loaded, unrecognised"). There is no browser build step: nothing under `js/`
  changes for P1.
* **Size budget:** P1 is planned at about 11-12 K of the 16 K, leaving room for P2's graphics and sound (the original
  fits all of it in 16 K, so ours must be compact) and for P3's fixed addresses.
* **Running it:** `m.setRoms({ basic: rom, basic64: null })` on a `dragon64` machine (Node), or
  `node cli/cloadm.js --roms build/d64_1.rom --type 'PRINT 2+2\n' --screen`.

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
| `$0000-$00FF` | the direct page: the interpreter's variables (pointers, the two floating-point accumulators, the text pointer, flags). DP is 0 throughout |
| `$0100-$011F` | RAM jump vectors (IRQ, FIRQ, NMI, SWI, SWI2, SWI3, `USR`), so a program can hook an interrupt [OWN; addresses to align in P3] |
| `$0120-$01FF` | `DEFUSR` addresses (10 x 2 bytes), keyboard state (rollover table, debounce), cassette buffer pointer, misc |
| `$0200-$02FF` | the line input buffer (250 characters + terminator) and the crunch buffer |
| `$0300-$03FF` | string temporaries and the `PRINT USING` / number conversion buffer |
| `$0400-$05FF` | the text screen, 32 x 16 [HW: the SAM's reset display offset] |
| `$0600-$1DFF` | the graphics pages, reserved from P1 on (P2: `PCLEAR 4`, four 1.5 K pages) |
| `$1E00` | 0 (the byte before the program) |
| `$1E01-...` | the program, then simple variables, then arrays, then free memory |
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
| `d64basic.asm` | equates (direct page, RAM layout, hardware registers), `INCLUDE`s, the vectors |
| `boot.inc` | cold start (PIAs, SAM, RAM size, pointers, banner), warm start (reset with a valid flag), the RAM vectors |
| `screen.inc` | character output: the 32 x 16 screen, scrolling, `CLS`, the cursor, `POS`, `TAB` columns, lower case shown inverse [HW] |
| `keyboard.inc` | the matrix scan through PIA 0, debounce, SHIFT, SHIFT-0 lower-case toggle, BREAK, SHIFT-@ pause, `INKEY$` [UM, HW] |
| `irq.inc` | the 50 Hz field interrupt: `TIMER`, the cursor blink |
| `lineinput.inc` | the input line editor: typing, left arrow erases, SHIFT-left arrow erases the line, BREAK, CLEAR [UM] |
| `tokens.inc` | the keyword table and token values (one data table; values from the token probe, section 7) |
| `crunch.inc` | crunching a typed line to tokens, uncrunching for `LIST` |
| `program.inc` | inserting, replacing and deleting lines; finding a line; `NEW`, `LIST`, `CLEAR`, `DEL`, `RENUM` (if it fits P1) |
| `interp.inc` | the main loop: direct mode and `RUN`, statement dispatch, `END`, `STOP`, `CONT`, `REM`, `GOTO`, `GOSUB` / `RETURN`, `ON ... GOTO/GOSUB`, `IF ... THEN ... ELSE`, `FOR` / `NEXT`, `TRON` / `TROFF` |
| `errors.inc` | the error codes and messages, `?XX ERROR` / `?XX ERROR IN n`, `BREAK IN n` [UM] |
| `vars.inc` | finding and creating variables, `DIM`, array element addressing, `LET` |
| `expr.inc` | the expression evaluator: operator precedence, relational and logical operators, function dispatch, type checking (`TM` errors) |
| `fp.inc` | the floating-point core: unpack / pack, add, subtract, multiply, divide, compare, normalise and round, integer conversion |
| `fpconv.inc` | number to text (Dragon print format) and text to number |
| `fpfunc.inc` | `SGN`, `INT`, `ABS`, `FIX`, `SQR`, `LOG`, `EXP`, `SIN`, `COS`, `TAN`, `ATN`, `RND`, `^` |
| `strings.inc` | string space, garbage collection, concatenation, comparison, `LEFT$`, `RIGHT$`, `MID$`, `LEN`, `STR$`, `VAL`, `ASC`, `CHR$`, `INSTR`, `STRING$`, `HEX$`, `INKEY$` |
| `print.inc` | `PRINT` (`;`, `,`, `TAB(`), `PRINT USING`, `?` |
| `input.inc` | `INPUT` (prompt, `?REDO`, `??`, extra ignored), `LINE INPUT` if the dialect has it, `DATA` / `READ` / `RESTORE` |
| `misc.inc` | `PEEK`, `POKE`, `EXEC`, `USR` / `DEFUSR`, `VARPTR`, `MEM`, `DEF FN`, `CLS`, `SOUND`-free stubs |
| `cassette.inc` | P1b: `CSAVE`, `CLOAD`, `CLOADM`, `CSAVEM`, `SKIPF`, `MOTOR` |

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
node tools/basic-bb/run.js --roms DIR_OR_FILE [--machine dragon64] [--cases tests/basic/cases] --out results.jsonl
node tools/basic-bb/compare.js real.jsonl ours.jsonl
```

* **Input:** the case files (plain text, one line per typed line). Directives on `'#` lines say how to run the case:
  `#wait-ok` (default: run until the `OK` prompt is back and the screen stays unchanged for 25 frames),
  `#frames N`, `#type TEXT` (keys while the program runs, for `INPUT` and `INKEY$`), `#break` (press BREAK),
  `#timeout S`.
* **How it runs:** a fresh machine per case (cold start, the same frames every time), the lines typed through the
  keyboard matrix at the typist's pace, so the ROM's own editor and crunching take them, exactly as a person typing.
  Nothing depends on the ROM's internals: no PC hooks, no RAM addresses, no tokenized loading.
* **What it records:** the transcript, every line that reached the screen in order, rebuilt by reading the 32 x 16
  text screen every frame and following its scrolling (the overlap between consecutive frames' screens; a frame
  whose screen cannot be matched to the previous one is flagged, so a lost line is never silent), plus the final
  screen. Characters are written as the screen text reader gives them (`js/claude/readtools.js`), with inverse
  characters marked.
* **Output** (one JSON object per line):
  `{"case":"fp-print-01","machine":"dragon64","rom":"<crc32 of the ROM file>","frames":412,"status":"ok",
  "transcript":["PRINT 1/3"," .333333333","OK"],"screen":["...16 lines..."],"flags":[]}`.
  It holds nothing but screen text and the ROM's CRC (to tell runs apart); no ROM bytes.
* **The token probe** (`tests/basic/cases/probe-tokens.bas`): a program types one line per keyword, then searches RAM
  below `$8000` for a marker it placed in a `REM` and prints the bytes that follow each marker in hex. This gives
  every keyword's token value and confirms the program line layout, without looking at the ROM. Similar probes
  give the program's start address (`MEM`, and a marker search), the variable and descriptor layouts (`VARPTR`), and
  the RND sequence.
* **The lint** (`tools/basic-bb/lint.js`, also run by `run.js`): refuses a case that `PEEK`s, `EXEC`s or `USR`s an
  address it cannot prove is below `$8000`, so no result can carry ROM contents.

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
10. **Cassette (P1b):** `CSAVE` then `CLOAD` round trip through the emulated deck, `CSAVEM` / `CLOADM`, and a file
    our ROM saves read back by the repository's `.CAS` decoder.

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

1. **Shipping the ROM.** P1 commits no binary: tests assemble it. To give people BASIC without a dump, the page needs
   it: commit a built `basic/d64_1.rom` (and serve it), or assemble it in the browser at boot (the assembler is
   already in `js/`)? And is it offered automatically when no ROM is present, or as a choice? (P1 proposes: not wired
   into the page; decided before the release that ships it.)
2. **The banner.** Ours says what it is (e.g. `CLOADM BASIC 0.1` and a short line), never the original's copyright
   text. The black-box comparison ignores the boot screen's first lines. Agreed?
3. **RAM layout facts** to confirm by black-box: the program start (`$1E01`?) and the default string space, which set
   `MEM` at cold start; whether `load_basic` and the share links (`js/claude/basicload.js`, which read BASIC's pointers at
   addresses taken from the cited books) should work with our ROM in P1. Making them work means putting our pointers at
   those addresses; we can only do that from a black-box probe or a P3 census result, not from the files that cite the
   books. Proposed: P3.
4. **Transcendental functions:** is "same printed value for the manual's examples, last-digit differences elsewhere
   documented" acceptable for P1, with a closer match later if the black-box results show a pattern?
5. **`RND`:** exact sequence required, or only "same distribution, same seeding behaviour" (`RND(0)`, negative
   arguments)?
6. **P2 keywords in P1:** `?FC ERROR`, `?SN ERROR`, or silently do nothing until P2?
7. **The 64K-mode BASIC** (`d64_2`, `EXEC 48000` from 32K mode) is out of P1 scope; with only our ROM in socket
   `basic`, the 64K mode switch is a `?FC ERROR`. Agreed?
8. **The serial port** (the Dragon 64's 6551, `PRINT #-2` to the printer through it): P1 or later?
9. **What the separate party needs from us:** the case list and the harness command; turnaround time decides
   whether M8 is one round or several.

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

The log grows with every milestone; black-box facts are added with the date of the run they came from.
