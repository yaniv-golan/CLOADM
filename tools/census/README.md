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
* Effects: the registers going in and coming out, the cycles spent in ROM, the values written to RAM outside
  $8000-$FEFF.
* Nothing read from **$8000-$FEFF** is output. That range covers BASIC, its RAM copy in the 64K mode, and a
  cartridge or DOS at $C000. Writes into it are not recorded.

Four guards enforce this, in `lib.js`. Each one has a test and a mutant that the test catches:

1. **Taint.** Every byte read from $8000-$FEFF as data is tainted. Instruction fetches at the PC are not, apart
   from the two bytes of a ROM vector that a `JSR [$A002]` reads to find its target. So is every byte read from a
   RAM cell that ROM code filled with a tainted value. Taint follows each stretch of ROM code, and the registers ROM
   leaves behind are carried to the next call. A record whose registers in or out, or whose written values, hold a
   tainted value is **refused**. It is counted (`refused` in the aggregate) and written as addresses only:
   `{ program, target, from, kind, refused }`.
   * 0 and $FF are never tainted: they are the fill of empty memory and the commonest constants.
   * A value ROM computes *from* a ROM byte, rather than copying it, is not followed; guards 2 and 3 bound that.
   * The rule is conservative by design. A refused call is lost detail; a leaked byte would be a breach.
2. **Tripwire.** Each program's output values form one stream. It is checked with `js/media/romrefs.js`'s window
   check (the one shared snapshots use) against the ROM images. A 16-byte run of any image discards everything
   that program produced.
3. **Scan limit.** A program that enters more than `--max-targets` (512) distinct ROM addresses counts as a scan of
   the ROM and is discarded.
4. **No read-out steps.** A `.cloadm` script given to the census may only feed the machine and let time pass: load,
   type, wait-for, frames, and so on. `peek`, `disasm`, `registers`, `screen`, `screenshot`, `save-snapshot`,
   recordings and traces are refused. The census sets the machine and the ROMs itself. A failing step is reported
   by its error code only, since a message could quote the screen.

The token probe's guard: a keyword must be a word of letters, digits and `$`, or one operator character. The line
is typed as `10 KEYWORD`, never run. Its stored bytes are written only if each is a token (bit 7 set) or a character
of the typed line, and there are no more of them than characters typed. The same tripwire watches the whole output.

## census.js

```
node tools/census/census.js --roms ~/roms [--out DIR] [--frames N] game.cas tool.bin disk.vdk session.cloadm
```

Runs each program on a Dragon 64 with the ROMs given.

* A `.cas`, `.bin`, `.vdk` or any other file the CLI's `--load` takes is loaded and run for `--frames` frames
  (default 3000, a minute).
* A `.cloadm` script runs its steps.

Every control transfer into $8000-$BFFF from outside it is logged: JSR, JMP, BSR/LBSR, indirect jumps through the
vectors, RTS/RTI/PULS landing in ROM, and interrupts.

| Option | Meaning |
|---|---|
| `--out DIR` | where `census.jsonl` and `census.json` go (default `./census-out`) |
| `--max-per-site N` | JSONL records per (program, from, target, kind); all are counted in the aggregate (default 20) |
| `--max-writes N` | writes kept per record; the rest are counted in `writesDropped` (default 256) |
| `--max-targets N` | the scan limit (default 512) |
| `--no-roms` | run on the built-in firmware (the self-test) |

`census.jsonl` holds one record per line:

```
{"program":"game.cas","target":45328,"from":12290,"kind":"jsr-indirect",
 "regsIn":{"a":72,"b":0,"x":0,"y":0,"u":0,"s":972,"dp":0,"cc":192},
 "regsOut":{"a":72,"b":0,"x":0,"y":0,"u":0,"s":974,"dp":0,"cc":192,"pc":12294},
 "cyclesInRom":5,"ramWritesOutsideRom":[{"addr":1024,"value":72}]}
```

* A record runs from the first instruction in ROM to the first one outside it again.
* `regsOut.pc` is where control left.
* `"open": true` marks a call still in ROM when the run ended.
* When ROM calls a RAM hook, the hook's return into ROM starts a new record of kind `rts`.

`census.json` holds `{ range, programs, failed, entries }`. Each entry is `{ address, hex, programs, calls,
refused, kinds, inRegs, outRegs, ramEffects }`, sorted by the number of programs using the address, then by calls.

* `inRegs` and `outRegs` list up to 8 distinct values per register (`more` when there were others). `outRegs`
  lists only registers the call changed.
* `ramEffects` lists each address written, with its count and up to 8 values.

The exit code is 0, or 1 when a program was discarded (the reason goes to standard error).

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
  guard must refuse.
* `selftest/fakebasic.asm` is a stand-in line editor with made-up keywords and tokens.

The test plants ROM values and checks that the guards stop them, and runs mutants of the guards.
