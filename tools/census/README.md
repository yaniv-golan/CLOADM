# tools/census: the ROM call census and the token probe

Two local-only tools for the clean-room "CLOADM BASIC" study (Dragon 64, 32K-mode BASIC). A maintainer runs them on
their own machine, with their own ROM dump, as a **black box**: they report **what a program asks of the ROM**
(addresses and effects) and **how BASIC stores a typed line** (the user's tokenised program, read from RAM), and
**never a byte of the ROM**.

* **Local only.** Never run in CI. The only part of them `node tests/all.js` runs is their self-test,
  `tests/census.test.js`, on the built-in firmware (no ROM).
* **No ROM in the repository**, ever (AGENTS.md rule 1.1). The ROM is given at run time with `--roms`, exactly as
  the CLI takes it (a file, a `.zip` or a directory).
* **Ships no keyword list.** The token probe's input is typed by hand from the public Dragon 64 manual.

## The black-box rule

The output holds addresses and effects, never ROM bytes:

* Addresses: a call's `target` (in $8000-$BFFF), its caller `from`, the RAM addresses it wrote.
* Effects: the registers going in and coming out, the cycles spent in ROM, the values written to RAM outside the
  masked range.
* The masked range is **$8000-$FFFF**, minus the I/O page $FF00-$FFDF. It covers BASIC, its RAM copy in the 64K
  mode, a cartridge or DOS at $C000, and the 32 bytes at $FFE0-$FFFF that the SAM maps from the ROM's last 32.
  Nothing read from it is output, and writes into it are not recorded.
* An I/O read the machine answers from ROM goes through the bus, so the guard sees that read too. That covers the
  floating bus at $FF60-$FFBF.

The guard is **structural**: it never compares values. It follows where data came from, and stops at the first point
where ROM data could reach the output. The rules are in `lib.js`'s header, and `tests/census.test.js` has a test and
a mutant for each one:

1. **The program starts clean.** Recording begins when the census loader starts the program: a machine-code `.bin`,
   a `.cas` loaded straight into memory, or an `asm` step. Its registers A, B, X, Y, U, DP and CC's flags are cleared
   then; S is kept. A program BASIC or a disk starts records nothing, because its registers could hold whatever ROM
   code left in them. A stop (rule 4) or a discard (rule 2) is final for the whole run: RAM is not cleared between
   loads, so a second program loaded later starts nothing new.
2. **Program code may not read ROM.** Any read of the masked range by an instruction that started outside it
   **discards the program**, and nothing it did is written. That includes an instruction running on past $7FFF, or
   `LDA 0,PCR` at the top of RAM. Two reads are exempt, because they only pick where control goes:
   * the two bytes of a `JSR`/`JMP [$A00x]` through BASIC's documented call vectors ($A000-$A00F);
   * the CPU fetching an interrupt vector as it takes an interrupt.
3. **ROM code that reads ROM data makes its stretch dirty.** A data read of the masked range by ROM code, or of a
   RAM cell holding ROM data, does this, and the instruction's own writes count. A call made during a dirty stretch
   is **refused**: it is written as its addresses only (`{ program, target, from, kind, refused }`), and its RAM
   writes become dirty.
4. **Taint is sticky.** When a dirty stretch returns to the program, the program may hold ROM data, so **recording
   stops** for good: nothing later is written or counted. Recording also stops if program code reads dirty RAM, or
   runs dirty RAM as anything but a `JMP`/`JSR` extended or `RTS` (BASIC's RAM hooks).
5. **Boot data.** Before the program starts, ROM code that writes a value it has read from ROM recently marks that
   RAM cell dirty. That covers the RAM hooks and tables BASIC copies out of ROM, through registers or the stack.
   * "Recently" means one of the last 16 reads, so a copy that reads more than 16 bytes before it writes them
     escapes it. 0 and $FF are not followed, and neither is anything BASIC *computes* from ROM data.
   * A **sweep** backs it up. When the program starts, after BASIC's boot and before the program goes in, every
     run of 8 or more bytes of the ROM images found in RAM below $8000 is marked dirty, however it got there. Runs
     of one repeated byte don't count. The program's own image is then marked clean. Sweeping before the image goes
     in means a run the image partly overwrites is still seen whole.
   * The window is a cost setting, not a safety one: `--sweep-window`, 4 to 16 bytes, default 8. A match only marks
     cells as ROM data. That stops recording when they are read, so a shorter window marks more and can only cost
     recording. On the built-in firmware no window from 4 to 16 marks any cell. On a real ROM, compare the
     `stopped` reasons in `census.json` across windows.
   * On a real Dragon 64, BASIC leaves such runs in its RAM vector area and near the top of RAM by the time a
     program starts. An earlier version discarded the program for them; now they are marked. A program that reads
     them, or calls a ROM routine that does, stops recording there.

**What is left** is what the census is for: the effects of running ROM code on the program's own inputs.

* **Constants and timing.** These effects carry the constants in ROM instructions, and ROM timing. A program that
  jumps into the middle of ROM code or data and watches what comes out can harvest a few such constants per entry
  point.
* **Addresses.** Values that only pick where control goes appear as addresses:
  * a `JSR [$A002]` record's `target` is the vector's value;
  * an interrupt's target is the hardware vector's value;
  * a RAM hook BASIC copied out of ROM (`JMP $xxxx` at $010C) shows its operand as `target`, with `from` the hook.

Three more guards bound what is left:

* **Tripwire.** Each program's output values form one stream. It is checked with `js/media/romrefs.js`'s window
  check against the ROM images. A 16-byte run of any image discards the program.
* **Scan limit.** More than `--max-targets` (512) distinct ROM entry points discards the program as a scan.
* **Run-wide limit.** Across every program of one run, more than `--max-run-targets` (1024) distinct ROM entry
  points writes nothing at all. The limit holds per invocation of `census.js`, so the maintainer's process keeps
  one run per study: one invocation, one `census.json`.

Two more things these guards do not cover:

* **Short boot residue.** The boot sweep (rule 5) only sees runs at least as long as its window (8 bytes by
  default). Boot residue the heuristic misses is not marked if it is shorter than that, or if a changed byte
  breaks the run. How much of that a real
  BASIC leaves can't be measured without a real ROM.
* **ROM bytes inside a program's own file.** ROM code embedded in a program's file is that program's data. Only the
  tripwire guards it, and it is out of scope.

Three more rules keep the CLI itself from leaking:

* A `.cloadm` script given to the census may only feed the machine and let time pass: load, asm, type, wait-for,
  frames, and so on. `peek`, `disasm`, `registers`, `screen`, `screenshot`, `save-snapshot`, recordings and traces
  are refused. The census sets the machine and the ROMs itself.
* A failing step is reported by its error code only, since a message could quote the screen.
* `kindOf` never reads an instruction inside the masked range. A call from a cartridge into BASIC is of kind
  `from-rom`.

**In practice**, a program's census covers its calls up to the first ROM routine that reads ROM data. That call is
refused, and recording stops there. Calls to routines that work only on the program's own data and RAM are recorded
in full.

The token probe's guard: a keyword must be a word of letters, digits and `$`, or one operator character. The line
is typed as `10 KEYWORD`, never run. Its stored bytes are written only if each is a token (bit 7 set) or a character
of the typed line, and there are no more of them than characters typed. The same tripwire watches the whole output.

## census.js

```
node tools/census/census.js --roms ~/roms [--out DIR] [--frames N] game.cas tool.bin session.cloadm
```

Runs each program on a Dragon 64 with the ROMs given.

* A machine-code `.bin` or `.cas` is loaded straight into memory, started, and run for `--frames` frames (default
  3000, a minute).
* A `.cloadm` script runs its steps. It can mount a `.vdk` with `disk`, but the program must still be started by
  `load` or `asm` (rule 1). A BASIC program, or one booted from disk, is discarded as "not started". The message
  says why, from the file's format. A common case is a tape that starts with a BASIC loader, which BASIC runs and
  which then loads the machine code: give the census the machine-code file itself instead.

Every control transfer into $8000-$BFFF from outside it is logged: JSR, JMP, BSR/LBSR, indirect jumps through the
vectors, RTS/RTI/PULS landing in ROM, and interrupts.

| Option | Meaning |
|---|---|
| `--out DIR` | where `census.jsonl` and `census.json` go (default `./census-out`) |
| `--max-per-site N` | JSONL records per (program, from, target, kind); all are counted in the aggregate (default 20) |
| `--max-writes N` | writes kept per record; the rest are counted in `writesDropped` (default 256) |
| `--max-targets N` | the scan limit per program (default 512) |
| `--max-run-targets N` | the limit on distinct ROM entry points across the whole run, static references (by descent) included; more, and nothing is written (default 1024) |
| `--max-candidates N` | candidate (linear-sweep-only) static targets kept per program; more, and that program's candidates are all dropped (default 128) |
| `--sweep-window N` | the boot sweep's shortest ROM run, 4 to 16 bytes (default 8); shorter marks more, which costs recording, not safety |
| `--no-roms` | run on the built-in firmware (the self-test) |

`census.jsonl` holds one record per line:

```
{"program":"game.cas","target":45328,"from":12290,"kind":"jsr-indirect",
 "regsIn":{"a":72,"b":0,"x":0,"y":0,"u":0,"s":972,"dp":0,"cc":192},
 "regsOut":{"a":72,"b":0,"x":0,"y":0,"u":0,"s":974,"dp":0,"cc":192,"pc":12294},
 "cyclesInRom":5,"ramWritesOutsideRom":[{"addr":1024,"value":72}]}
```

* A record runs from the first instruction in ROM to the first one outside it again. A refused record holds only
  `{ program, target, from, kind, refused }`.
* `regsOut.pc` is where control left.
* `"open": true` marks a call still in ROM when the run ended.
* When ROM calls a RAM hook, the hook's return into ROM starts a new record of kind `rts`.

`census.json` holds `{ range, programs, failed, entries }`.

* Each `programs` item gives the calls `recorded` and `refused`, and why recording `stopped` (null when it didn't).
  It also gives the static census's counts (`static`, `candidates`, `candidatesDropped`) and `imageBytesLeftOut`.
* Each entry is `{ address, hex, programs, calls, refused, kinds, inRegs, outRegs, ramEffects, staticPrograms,
  candidatePrograms }`. Entries are sorted by the number of programs that called the address, then by the number
  that refer to it statically, then by calls. A vector slot is an entry of its own, marked `vectorSlot`.

* `inRegs` and `outRegs` list up to 8 distinct values per register (`more` when there were others). `outRegs`
  lists only registers the call changed.
* `ramEffects` lists each address written, with its count and up to 8 values.

The exit code is 0, or 1 when a program was discarded (the reason goes to standard error).

Two programs with the same file name are refused before anything runs, since records are keyed by name.

`census.jsonl` is written as each program finishes, to `census.jsonl.partial`, and renamed when the run is done:

* a crash later in the run keeps the programs already done, in the `.partial` file;
* the run-wide limit is checked before each program's lines go in, so the file never passes it;
* a run refused by the limit deletes the `.partial` file.

### The static census

The static census adds the references a program's own file makes. It works from the bytes the census loader put
in memory, before anything runs, and never reads RAM after a run. It runs for every program that was started,
however early recording stopped, so it answers "which entry points does this program use" even for a program
whose dynamic census ended at its first call. It is in `static.js`:

* **ROM copied into the file.** Every run of 16 or more bytes of a ROM image found in the program's segments is
  left out before anything is decoded, with 16 bytes either side (`imageBytesLeftOut`). A program file can carry
  copied ROM code or tables, and no operand inside such a copy is ever reported.
* **Recursive descent from the exec address.** References found this way are `"source": "static"`. Descent
  follows fall-through, branch and call targets inside the image. These end a path: `JMP`, `BRA`/`LBRA`, `RTS`,
  `RTI`, a pull of PC, and a jump through a register or memory.
* **A linear sweep at every byte.** References only it finds are `"source": "candidate"`. They come from code the
  descent didn't reach (jump tables, code after a computed jump), or from data that happens to decode as an
  instruction. Past `--max-candidates` distinct candidate targets, all of that program's candidates are dropped.
* **What counts as a reference:**
  * a `JSR`/`JMP` extended, `BSR`/`LBSR`, or a branch into $8000-$BFFF (`target`);
  * a `JSR`/`JMP [$A00x]` through BASIC's call vectors. Only the vector's address is recorded (`slot`, with
    `target` null); its value is ROM data and is never read.
  * Direct-page `JSR`/`JMP` are skipped, since DP isn't known statically.
* **Lines in `census.jsonl`:** `{ program, from, target, slot?, kind, source }`, addresses only.
* **Limits.** It misses targets computed at run time, and code a program decompresses or loads later. It can list
  dead code. ROM copies shorter than 16 bytes in a program file are not left out (out of scope, as above).

## tokens.js

```
node tools/census/tokens.js --roms ~/roms --keywords keywords.txt [--out tokens.json]
```

`keywords.txt` holds one keyword per line, typed from the **public Dragon 64 manual**; `#` starts a comment. For
each keyword, the probe:

1. boots BASIC to its OK prompt, once, then restores that state for each keyword;
2. types `10 KEYWORD` and RETURN;
3. finds the stored line in RAM below $8000 by its shape alone, with no BASIC address built in. The shape is
   `[next-line address][0, 10][bytes][0]`, where the next-line address points just past the terminator, at the
   `0 0` that ends the program.

The output is `{ line: 10, results: [{ keyword, bytes }], failed: [{ keyword, error }] }`. `--boot FILE` gives a
`.cloadm` script that brings the machine to the prompt instead (the self-test's stand-in line editor uses it).

## Self-test

`node tests/census.test.js` runs both tools on the built-in firmware with programs written for this project:

* `selftest/calls.asm` calls the ROM stub's vectors and routines, including one that returns a ROM byte, which the
  guard must refuse; after it, recording stops.
* `selftest/fakebasic.asm` is a stand-in line editor with made-up keywords and tokens.

The test also runs a program for each leak path, on the built-in ROM stub:

* reading ROM and computing on it;
* keeping a refused call's ROM byte in RAM and passing it on;
* the $FFE0-$FFFF vectors;
* an instruction reading ROM at its PC from the top of RAM;
* a `JMP` through a ROM word;
* copying ROM out;
* scanning the ROM.

It drives a stand-in machine through the cases that need exact timing:

* a boot that copies ROM into RAM;
* the real ROM's load path: runs left in the RAM vector area and the stack, which the sweep must mark over exactly
  their length, including a run the program's image overlaps;
* a short copy that only the 16-read heuristic catches;
* a second program after a stop;
* RAM written by a dirty stretch that never returned. It runs a mutant of every guard.
