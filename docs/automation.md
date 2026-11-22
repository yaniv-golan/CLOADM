# Automation: the command line and the Node API

[CLOADM](../README.md) › Automation

CLOADM runs headless in Node, with no browser: for CI pipelines, tests of your own Dragon, CoCo or MC-10 programs,
and AI coding agents that need to run a program and read what it printed. There are three ways in:

* **`cli/cloadm.js`**, a command-line tool: steps on the command line or in a script file, human or JSON output,
  and exit codes a pipeline can act on.
* **`cli/cloadm.js --mcp`**, a Model Context Protocol server: a coding agent (Claude Code, Cursor, Claude Desktop)
  boots machines and drives them through tools, keeping them between calls ([mcp.md](mcp.md)).
* **The Node API**: the same `Session` the page uses (`js/emu.js`), driven from your own script.

All three need only Node 22.12 or later, from a checkout of this repository. Nothing is installed: there are no npm
dependencies, no build step, and no `package.json` (see [Packaging](#packaging)).

## ROMs

Nothing here needs a ROM to run machine code. Without ROMs every machine runs CLOADM's own built-in firmware,
which runs machine-code programs, the bundled programs (the welcome menu, LIZA, the colour demo, 2048 and
Minesweeper) and anything you
assemble with the bundled assembler. BASIC needs the BASIC ROMs, which CLOADM never ships: give the tool your own
dumps with `--roms` (a file, a ROM pack `.zip` saved from the page, or a directory of them). In CI, keep them out of
the repository and out of the logs: store them as an encrypted secret or in a private artifact store and write them
to a temporary directory in the job (the [GitHub Actions example](#github-actions) does this). The steps
that read the machine (`--peek`, `--disasm`, `--registers`, `--step`, `--screen`, `--screenshot`, and the `--json`
output that carries their results) show memory, code and the screen, which can hold copies of ROM code, so don't
publish their output from a run with your ROMs.

## The command line

```sh
node cli/cloadm.js --help
node cli/cloadm.js --list-machines
node cli/cloadm.js --machine coco --program liza --wait-for 'text:/^> ?$/m' --type 'I need a holiday\n' --wait-for 'text:WHY DO YOU NEED' --screen
```

Every option is a **step**, run in the order given. The machine setup comes first:

| Step | What it does |
|---|---|
| `--machine ID` (`-m`) | the model, default `dragon64`; `--list-machines` lists the ids, their options and ROM files |
| `--option KEY=VALUE` (`-o`) | a machine option, checked against the model: `ram=16` (the CoCo 1/2: 4, 16, 32 or 64), `cpu=6309` (the models with a 6309 variant), `hires=max3-right`, …; `becker=true` is **CoCo-family only**. Each model offers its own set (`--list-machines`; [which model has which](#which-storage-and-serial-paths-each-model-has)): the Dragon 64 has `cpu`, `ram`, `hires` and `ssc`, and `-o becker=true` on it is `bad-option` (exit 2) |
| `--roms PATH` | your ROM dumps: a file, a ROM pack `.zip` or a directory (repeatable). Without it the machine runs the built-in firmware |
| `--no-roms` | the built-in firmware even with ROMs given |
| `--fast-cas` | `.cas` programs go straight into memory instead of through BASIC's `CLOAD` |

Then, in any order:

| Step | What it does |
|---|---|
| `--program welcome\|liza\|demo\|2048\|minesweeper` | a bundled program (no ROMs needed; the demo and the games on a 6809-family machine) |
| `--load FILE` | a binary, `.cas`, `.wav`, cartridge or BASIC listing, loaded and run as dropping it on the page; a disk image goes in drive 0 |
| `--asm FILE` | assemble a source file with the bundled assembler, for the machine's CPU, and run it (`INCLUDE`s are read from its folder) |
| `--cart FILE` | plug in a cartridge ROM image |
| `--tape FILE` | put a `.cas` or `.wav` in the deck without loading it (then type `CLOAD`) |
| `--disk [N=]FILE` | mount a VDK, JVC/DSK or DMK image in drive N (default 0); needs your disk ROM |
| `--load-snapshot FILE` | open a snapshot, switching to its machine |
| `--type TEXT` | type at the keyboard, then run until the machine has taken the keys. `\n` or `{ENTER}` is ENTER; also `{BREAK}`, `{CLEAR}`, `{UP}`, `{DOWN}`, `{LEFT}`, `{RIGHT}`, `{SPACE}`; `\\` is a backslash |
| `--hold KEYS[:N]` | hold keys down in the keyboard matrix for N frames (default 1), then let go, for programs that read the matrix themselves (games): `RIGHT:10`, `LEFT+SPACE:3`, `{UP}`, `Z:5`. Names are the matrix's: letters, digits, `UP` `DOWN` `LEFT` `RIGHT` `SPACE` `ENTER` `CLEAR` `BREAK` `SHIFT` (and the CoCo 3's `ALT` `CTRL` `F1` `F2`) |
| `--frames N`, `--seconds S` | run N frames, or S seconds of emulated time |
| `--wait-for COND` | run until `text:REGEX` is on the screen, `mem:ADDR=VALUE` holds, or the PC reaches `pc:ADDR` (it stops at that instruction); exit 1 at the timeout |
| `--timeout S` | emulated seconds each later `--wait-for` and `--type` may take (default 10) |
| `--expect-screen REGEX`, `--expect-mem ADDR=VALUE` | must hold now, or exit 1 |
| `--expect-screenshot FILE` | the frame must match a reference PNG pixel for pixel, or exit 1 (see [Pictures and sound](#pictures-and-sound)) |
| `--tolerance N` | how many pixels each later `--expect-screenshot` may find different (default 0) |
| `--diff FILE` | each later `--expect-screenshot` writes a picture of the differences to FILE |
| `--screen` | the text on the screen |
| `--screenshot FILE` | the frame as a PNG |
| `--wav FILE` | record the machine's sound from here until `--wav-stop` or the end of the run, as a 16-bit mono WAV (see [Pictures and sound](#pictures-and-sound)) |
| `--wav-stop` | end the recording and write its file |
| `--peek ADDR[:LEN]` | memory as the CPU sees it, with no side effects |
| `--poke ADDR=V[,V…]` | write through the memory map (ROM and I/O take nothing) |
| `--save-snapshot FILE` | the machine as a snapshot file, which the page opens too |
| `--info` | the machine, its options, ROMs or firmware, frame count and PC |
| `--registers` | the CPU's registers (the 6309's extra ones too) |
| `--set-register NAME=VALUE` | set one, e.g. `pc=$3000` |
| `--disasm [ADDR][:COUNT]` | disassemble COUNT instructions (default 8, at most 64) at ADDR (default: the PC), in the machine's own instruction set |
| `--step N` | run exactly N instructions (at most 100000), then the registers |
| `--reset` | the reset button: with ROMs a warm reset (RAM kept); on the built-in firmware the program it ran starts again, as on the page |
| `--power-cycle` | off and on: RAM back to its power-on contents, what is inserted stays |
| `--view main\|plus` | which of the Dragon 64 Plus's two screens is shown, and so read by `--screen` and `--screenshot`: `main` (the VDG) or `plus` (the 80-column HD6845S), as the page's Display tab sets it |

And outside the steps: `--describe` prints the whole interface as JSON (every step with its command-line form, help
and an example, the exit codes, the error codes, the keys), `--list-machines` lists the models (`--json` for JSON),
`--help` prints the summary.

Addresses and values are `$hex`, `0xhex` or decimal. A regular expression is `/source/flags` or just the source; the
screen text it is matched against is the rows joined with newlines.

**Screen text** comes from the same readers as Claude's `screen_text` tool (`js/claude/readtools.js`): the MC6847's
32x16 text screen on every VDG machine (wherever the CoCo 3's GIME moves it), every CoCo 3 GIME text mode (32 to 80
columns), and the Dragon 64 Plus's 80-column HD6845S screen. That last one is read while it is the screen shown: on
the page that is the Display tab's choice, here `--view plus` (`--view main` goes back to the VDG). Rows have their
trailing spaces trimmed and trailing blank rows are left out. A graphics mode, or a screen the readers cannot decode,
gives no text and says why.

**Pictures** are the frame's own pixels, unscaled: 320x240-ish for VDG machines (with the border), 640x240 for the
CoCo 3, so a display stretches them to 4:3. They are the colours `machine.render()` gives, before the page's CRT and
artifact-colour display effects. A picture is the last frame the video chip drew, while `--screen` and `--peek` read
memory now: a program that changes the screen part way through a frame shows the change in the next picture, so
run a frame (`--frames 1`) before a screenshot of something that just changed.

### Which storage and serial paths each model has

Options and paths differ by model, so a command that works on one machine can be refused on another. Machine options are
checked against the model (`bad-option` names what it has: `the Dragon 64 has no option "becker" (it has cpu, ram, hires, ssc)`).
This table is built from `js/machines/profiles.js` and the machines themselves, and `tests/dev-docs-headless.test.js`
fails when it and the code differ:

| Model | Options | Tape | Disk controller (a cartridge; your own ROM) | 6551 ACIA | Bit-banger serial port | Becker port (DriveWire) |
|---|---|---|---|---|---|---|
| `dragon32` | `cpu`, `ram`, `hires` | cassette | DragonDOS or Delta DOS | no | no | no |
| `dragon64` | `cpu`, `ram`, `hires`, `ssc` | cassette | DragonDOS or Delta DOS | yes, with its port | no | no |
| `dragon200`, `tanodr64` | `cpu`, `ram`, `hires` | cassette | DragonDOS or Delta DOS | yes, with its port | no | no |
| `dragon200e` | `cpu`, `ram`, `hires`, `inverseVideo` | cassette | Disk BASIC (RS-DOS) [^200e] | chip only, no port | yes [^200e] | no |
| `dgnalpha` | `cpu`, `ram` | cassette | its own, built in (2 drives) | chip only, no port | no | no |
| `d64plus` | `cpu`, `ram` | cassette | DragonDOS or Delta DOS | chip only, no port | no | no |
| `coco`, `coco2b` | `cpu`, `ram`, `hires`, `becker`, `ssc` | cassette | Disk BASIC (RS-DOS) | no | yes | yes |
| `mx1600`, `lzcolor64`, `cd6809`, `cp400` | `cpu`, `ram`, `hires`, `becker` | cassette | Disk BASIC (RS-DOS) | no | yes | yes |
| `coco3` | `cpu`, `ram`, `hires`, `becker`, `ssc` | cassette | Disk BASIC (RS-DOS) | no | yes | yes |
| `coco3p` | `cpu`, `ram`, `hires`, `becker` | cassette | Disk BASIC (RS-DOS) | no | yes | yes |
| `mc10`, `alice` | `cpu`, `ram` | cassette | none (no cartridge port) | no | yes | no |

[^200e]: How the code treats the Dragon 200-E today: it is picked out by its own keyboard layout, so the places that
    ask "is this a Dragon?" (the disk cartridges it offers, the parallel printer, the serial port) see a CoCo-family
    machine there: it offers the RS-DOS cartridge and has the bit-banger in place of the Dragons' parallel printer. Its
    6551 is present but, as on the Alpha and the 64 Plus, its port is not wired to a plug.

What each column means, and the way in:

* **Tape**: the cassette deck every model has (`--tape FILE`, `--load FILE.cas`; `insertTape` in Node).
* **Disk controller**: a cartridge in the cartridge port with your own disk ROM (`--roms`, then `--disk [N=]FILE`);
  the Dragon Alpha's controller is built in. The MC-10 and Alice have no cartridge port, so no disk.
* **6551 ACIA** (Dragon 64, 200 and Tano at `$FF04-$FF07`; [the machine notes](machines.md) list the Dragon 64's
  serial port): "with its port" means `session.attachSerial('terminal' | 'loopback' | 'none', { baud })` plugs something
  into its RS-232 port. There is no command-line step for serial: it is Node only
  ([a custom peer](#a-snapshot-with-a-serial-peer-outside-the-machine)).
* **Bit-banger**: the CoCo's and the MC-10's serial port, driven by the program through PIA1 (`attachSerial('printer' |
  'terminal' | 'loopback', { baud })`; a serial printer is plugged in by default).
* **Becker port**: `becker=true` (the `?becker=true` of the page) puts the DriveWire port at `$FF41-$FF42`; the
  Dragons have no `becker` option.

### Pictures and sound

`--expect-screenshot ref.png` compares the frame with a reference PNG, every pixel's red, green, blue and alpha
exactly. Make the reference with `--screenshot` once, look at it, and check it in. More than `--tolerance` pixels
different (default 0) fails the run with exit 1 (`expect-failed`), and the error (with `--json`, `error.screenshot`)
gives `differing` (the count), `first` (`x`, `y`, and the `expected` and `actual` colours as `#RRGGBBAA`), `width`,
`height` and `tolerance`; a passing step's result has the same fields. A reference of another size fails the same
way. With `--diff out.png` set first, the comparison also writes a picture of the frame with every differing pixel
red and the rest at a third of their brightness. The reference can be any non-interlaced PNG with grey or a palette at
1, 2, 4 or 8 bits, or RGB, grey with alpha or RGBA at 8 bits (with a `tRNS` transparency where the format has one), so
an image editor's copy, small palettes included, compares too; anything else (16 bits a sample, interlaced) is
`bad-media`.

```sh
node cli/cloadm.js --load game.bin --wait-for 'mem:$3005=1' --frames 1 --diff diff.png --expect-screenshot ref.png
```

`--wav out.wav` records the sound of every frame that runs after it until `--wav-stop` or the end of the run (also
when the run fails, so the recording of a failure is kept): 16-bit signed mono PCM at 44100 Hz. The samples come from
the page's own audio path: each frame's sound levels (the DAC, the single-bit output and any sound cartridge, mixed
by the machine) go through the page's output stage (`js/host/audio.js`), which gives 44100 / fps samples per frame,
the fraction carried, each the level averaged over its stretch of the frame. The page then blocks DC and sets the
volume; the recording does neither, so the levels can be checked exactly: the 6-bit DAC's value d (PIA1 `$FF20` bits
7-2) is the sample 320 x d (0 to 20160), the single-bit sound adds 10240 (32 DAC steps), and a level that changes inside a sample's
stretch gives the average. Everything is emulated time, so the same run gives the same file, byte for byte. The
`wav` step's result gives `file`, `rate`, `bits`, `dacStep`, and, once written, `samples` and `seconds`.

```sh
node cli/cloadm.js --load game.bin --wait-for 'mem:$3008=14' --wav catch.wav --frames 12 --wav-stop
cmp catch.wav tests/sound/catch.wav     # a sound effect, as a regression reference
```

### Script mode

`--script FILE` reads steps from a file, one per line, with the step names above and no dashes; `#` starts a comment.
The argument is the rest of the line, trimmed; the one rule for quotes is that when it starts and ends with a double
quote, that one pair is taken off and nothing else changes. So `type " B "` keeps its spaces, `type ""A""` types `"A"`,
and `type "C` types `"C`. On the command line the shell does the quoting, and the argument is taken as it is. A script
can be mixed with other steps on the command line. The short names `m` (machine) and `o` (option) work in a script
as they do on the command line (`-m`, `-o`); no other step has an alias.

```text
# example: liza-script
machine coco
program liza
wait-for text:/^> ?$/m
type "I need a holiday\n"
wait-for text:WHY DO YOU NEED A HOLIDAY
expect-screen HOLIDAY
peek $0400:4
screenshot liza.png
screen
```

```sh
node cli/cloadm.js --script test.cloadm --json
```

### Output and exit codes

Without `--json` the tool prints what `--screen`, `--peek` and `--info` ask for, and nothing else, on stdout; an error
goes to stderr, with the screen when a condition failed. With `--json` it prints one JSON object on stdout:

```json
{
  "ok": true,
  "exit": 0,
  "machine": { "machine": "coco", "name": "CoCo 1/2", "config": { "cpu": "6809", "ram": 64 }, "roms": false, "frame": 211, "pc": 45312 },
  "steps": [
    { "step": "program", "program": "liza", "message": "liza.bin: …" },
    { "step": "wait-for", "condition": "text:WHY DO YOU NEED", "frames": 42, "met": true },
    { "step": "screen", "text": true, "mode": "MC6847 text", "cols": 32, "base": 1024, "lines": ["…"], "rows": 9 },
    { "step": "peek", "address": 1024, "length": 4, "bytes": [76, 73, 90, 65] }
  ]
}
```

A failed run adds `error: { kind, code, message, screen }` (`screen` when a condition failed; `errors`, a list of
`{ line, message }`, when an assembly failed; `screenshot` when an `--expect-screenshot` failed), and `roms` lists how each ROM file given was identified. `machine` is
`null` when the run stopped before a machine was built. `--registers`, `--disasm` and `--step` give `registers`
(an object of lower-case names), `instructions` (`address`, `bytes`, `text`, `size`, and `target` where an operand
points somewhere) and `cycles`; `--asm` gives `exec`, the `segments` written and the program's `symbols`.

| Exit code | Meaning |
|---|---|
| 0 | every step succeeded |
| 1 | a condition failed: a `--wait-for` timed out, an `--expect-*` (`--expect-screenshot` too) did not hold, or the machine did not take typed keys in time |
| 2 | usage error: an unknown step, a bad argument, a key the keyboard does not have, setup after other steps |
| 3 | media or ROM error: a file that can't be read (a `--script` file too) or isn't what the step needs, missing ROMs, something that needs BASIC run without it |
| 4 | an internal error (a bug: please report it) |

Every error also has a `code`, stable across versions, so a caller can act on the cause rather than parse the message:

| Code | Exit | Meaning |
|---|---|---|
| `bad-argument` | 2 | a step's argument is malformed or out of range |
| `unknown-step` | 2 | no step or option of that name |
| `setup-order` | 2 | a machine setup step after other steps |
| `no-steps` | 2 | nothing to do |
| `bad-option` | 2 | the model has no such option, or not that value |
| `untypable` | 2 | the machine's keyboard cannot type a character or key |
| `cannot-read` | 3 | a file could not be read |
| `cannot-write` | 3 | a file could not be written |
| `bad-media` | 3 | a file is not what the step needs (format, kind, assembly errors) |
| `missing-roms` | 3 | the ROMs given do not include what the model needs to boot |
| `rejected` | 3 | the machine refused the media or request (a BASIC program without BASIC, a disk without a disk ROM, an unknown register) |
| `timeout` | 1 | a `--wait-for` did not hold within its timeout |
| `expect-failed` | 1 | an `--expect-*` did not hold |
| `keys-not-taken` | 1 | the machine did not read the typed keys within the timeout (they are dropped) |
| `internal` | 4 | a bug in CLOADM |

### Timing

Everything runs in emulated time. Each step runs whole frames (a `--wait-for pc:` stops mid-frame, at the instruction),
as fast as the host can run them, and nothing reads the wall clock: the page's turbo and fast-tape modes, which are
about real time, are off, so a tape loads in its emulated time (`--fast-cas` skips it for `.cas` files). The same
inputs therefore give the same frames, screens and pictures on every run and every machine. `--seconds` and
`--timeout` are emulated seconds: a 50 Hz machine runs 50 frames a second. `--save-snapshot` records the time it was
taken; set `SOURCE_DATE_EPOCH` (seconds since 1970) for byte-identical snapshot files.

### A graphics program has no text to wait on

`--wait-for text:` needs something on the screen to read, and a graphics program has none: its screen is a bitmap. Wait on
something it does keep in memory instead. The guest here, `docs/examples/framecount.asm` (a PMODE 4 screen, 6809, no
ROMs), adds one to a byte at `$3100` on every video field and, once a tick, reads the keyboard matrix: with SPACE down it
records that tick's counter in `$3101` and inverts one byte of the picture on row 96. So the byte is the clock to wait on,
and the key is visible in the picture and in `$3101`:

```sh
node cli/cloadm.js --asm docs/examples/framecount.asm --wait-for 'mem:$3100=3' --hold SPACE:2 --wait-for 'mem:$3100=7' --expect-mem '$3101=5' --step 200 --json
node cli/cloadm.js --asm docs/examples/framecount.asm --wait-for 'mem:$3100=3' --hold SPACE:2 --frames 1 --screenshot key.png
```

The first command's `--json` steps (trimmed) are:

```json
{ "step": "wait-for", "condition": "mem:$3100=$03", "frames": 5, "met": true }
{ "step": "hold", "keys": ["SPACE"], "frames": 2 }
{ "step": "wait-for", "condition": "mem:$3100=$07", "frames": 2, "met": true }
{ "step": "expect-mem", "address": 12545, "value": 5, "met": true }
{ "step": "step", "instructions": 200, "cycles": 800 }
```

`frames` is what each run step ran (the counter took 5 frames to reach 3: the guest first clears its 6 KiB picture, which takes
about two and a half frames); `--info` gives the machine's frame count so far (`frame`), and `--step N` gives the `cycles`
those N instructions took. Everything is emulated time, so the same command gives the same numbers on every run. The same
recipe in Node: wait on the byte, hold the key, wait for the next counter value, capture a PNG, and read the elapsed frames and
CPU cycles (`machine.frameCount`, and `machine.now()`, the machine's own cycle count):

```js
// example: frame-counter
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session, assemble } from './js/emu.js';
import { framePng } from './cli/cloadm.js';

const fail = (what) => { throw new Error(`example: ${what}`); };
const s = new Session({ welcomeMenu: false });
s.switchMachine('dragon64', {}, { menu: false });
const m = s.machine;
const res = assemble(readFileSync('docs/examples/framecount.asm', 'utf8'), '6809');
if (!res.ok) fail(res.errors.map((e) => e.message).join('; '));
s.runAssembled(res);

// wait on a byte of the guest's memory: whole frames, with a bound; what elapsed comes back
const waitFor = (addr, value, maxFrames = 300) => {
  const at = { frames: m.frameCount, cycles: m.now() };
  while (s.readByte(addr) !== value) { if (m.frameCount - at.frames > maxFrames) fail(`address ${addr} never became ${value}`); s.runFrames(1); }
  return { frames: m.frameCount - at.frames, cycles: m.now() - at.cycles };
};
const boot = waitFor(0x3100, 3);                   // the guest's counter, with no text on the screen
m.setKey('SPACE', true);                           // a key down in the keyboard matrix, as a finger would hold it
s.runFrames(2);                                    // the guest's next two ticks both read it
m.setKey('SPACE', false);
const next = waitFor(0x3100, 7);                   // the next counter value we want
if (s.readByte(0x3101) !== 5) fail(`SPACE was last seen at tick ${s.readByte(0x3101)}, not 5`);
const png = framePng(m.render());                  // the last frame the video chip drew
if (png[1] !== 0x50 || png.readUInt32BE(16) !== 320 || png.readUInt32BE(20) !== 240) fail('not a 320x240 PNG');
writeFileSync(join(tmpdir(), 'framecount-key.png'), png);
if (boot.frames !== 5 || next.frames !== 2) fail(`elapsed frames ${boot.frames} and ${next.frames}`);
if (next.cycles < 2 * 17700 || next.cycles > 2 * 17800) fail(`2 frames took ${next.cycles} cycles`);   // 17,784 a frame on the Dragon 64
console.log('example passed');
```

**Input is latched at the guest's tick, not at the video field.** The guest samples the keyboard matrix once per tick, so
what it "presses" is the matrix's state at that instant; a key that goes down and up between two ticks is never seen. The
harness changes the matrix straight away (`--hold` and `machine.setKey` set the key before the frames run and let go after
them), so a key held for N frames is there for every tick inside them. A guest that ticks on every field (as this one polls
the field-sync flag) sees a hold of one frame; a guest that works for three fields between samples needs a hold of at least
three, or a hold that waits on the guest's own counter (`--wait-for` on the byte that says it has read the keys).
`--type` and `typeText` are different: they go through a key queue that applies changes at frame starts, one new press a
frame, each held at least 3 frames (`js/machines/keyqueue.js`), which suits a keyboard routine that reads a character, not a
sample on a chosen tick.

**A video field is the frame.** The VDG's field sync comes once per frame and is the guest's tick when it waits for it, so the
rate is the video standard's, not the family's: **PAL** machines (the Dragon 32, 64, 200, 200-E, the Dragon Professional (Alpha)
and the Dragon 64 Plus, and the **CoCo 3 (PAL)**, `coco3p`) run 17,784 CPU cycles a frame, 49.97 fields a second on the Dragons
(888,625 Hz) and 50.04 on the CoCo 3 (PAL) (889,844 Hz); **NTSC** machines (the CoCo 1/2, 2B and clones, the CoCo 3, the **Tano
Dragon 64**, which is NTSC, the MC-10 and the Alice) run 14,934 cycles a frame, 59.92 a second (894,886 Hz). `--frames`,
`--hold` counts and the `frames` in a `--wait-for` result are those frames, and a `mem:` condition is checked as each frame
ends, so a wait finishes at the first frame boundary at which the byte holds, not at the instruction that wrote it (use
`--wait-for pc:` to stop at an instruction). A guest that does more than a frame's work between field syncs simply ticks slower
than the frames run: its counter then advances less than once a frame.

**What "cycles" counts.** `--step N` reports CPU cycles. `machine.now()` is the machine's own clock, which is the CPU cycle on
the Dragons, the CoCo 1/2 and the MC-10 but the GIME's clock (four times the 0.89 MHz CPU cycle: 59,736 a frame NTSC, 71,136 PAL)
on the CoCo 3, where the CPU runs at two speeds; `machine.cpu.totalCycles` counts CPU cycles on every model.

## For coding agents

Writing a game? [Game development](game-development.md) is the guide: the hardware a game uses, a starter game, and
its tests (keys held with `--hold`, the picture with `--expect-screenshot`, the sound with `--wav`).

Everything an agent needs is in the tool itself: `--describe` is the interface as data, every error has a code, the
failure of a condition carries the screen it failed on, waits are conditions rather than sleeps, and the same inputs
always give the same results, so a retry or a bisection behaves.

Run one command line per question (or one `--script`), and carry the machine from one call to the next with
`--save-snapshot` and `--load-snapshot`: a snapshot restored continues exactly as the machine would have. An agent
that keeps machines open between calls uses the MCP server instead: [mcp.md](mcp.md).

### GitHub Actions

```yaml
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
        with: { repository: yaniv-golan/cloadm, path: cloadm }
      - uses: actions/checkout@v4
        with: { path: game }
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      # Machine code needs no ROMs: assemble the program, run it, wait for its title, keep a screenshot
      - run: >
          node cloadm/cli/cloadm.js --machine coco --asm game/src/game.asm
          --wait-for 'text:PRESS FIRE' --type ' ' --wait-for 'mem:$0100=1'
          --screenshot game.png --json > result.json
      # BASIC needs your ROMs: a base64 ROM pack in a repository secret, written outside the workspace
      - run: |
          mkdir -p "$RUNNER_TEMP/roms"
          printf '%s' "$ROM_PACK" | base64 -d > "$RUNNER_TEMP/roms/cloadm-roms.zip"
          node cloadm/cli/cloadm.js --machine coco --roms "$RUNNER_TEMP/roms" --load game/basic/menu.bas \
            --wait-for 'text:MAIN MENU' --screen
        env:
          ROM_PACK: ${{ secrets.COCO_ROM_PACK }}
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: screen, path: game.png }
```

The step fails when the tool exits non-zero, so a `--wait-for` that times out fails the job, with the screen in the
log.

## The Node API

The command line is a thin layer over the `Session` (`js/session.js`), which you can drive yourself. The library is
plain ES modules: import `js/emu.js` from an ES module (`.mjs`, or `--input-type=module`), or `require()` it from
CommonJS (Node 22.12 or later). This example runs from the repository root and checks its own results:

```js
// example: node-api
import { readFileSync } from 'node:fs';
import { Session, screenTextTool, frameToRGBA, assemble } from './js/emu.js';
import { framePng } from './cli/cloadm.js';

const fail = (what) => { throw new Error(`example: ${what}`); };

// a machine: the model and its options (profiles in js/machines/profiles.js), the built-in firmware without ROMs
const s = new Session({ welcomeMenu: false });
s.switchMachine('coco', { ram: 32 }, { menu: false });
// your ROMs, if you have them: s.addRoms([{ name: 'bas13.rom', bytes }]) identifies them for every model

// a bundled program; s.load(name, bytes) loads any binary, .cas, .wav, cartridge or BASIC listing
await s.startLiza((name) => readFileSync(`examples/${name}`));
s.runFrames(60);                                  // one second of emulated time, the same on every run

// typing: '\n' is ENTER; the keys go in over the next frames
s.typeText('I need a holiday\n');
s.runFrames(120);

// the screen, through Claude's screen_text reader (the Session is its target)
const screen = screenTextTool(s);
if (!screen.lines.includes('WHY DO YOU NEED A HOLIDAY?')) fail(`LIZA did not answer: ${screen.lines.join(' | ')}`);

// memory: side-effect-free reads, writes through the memory map (-> how many bytes landed)
if (s.readByte(0x400) !== 0x4C) fail('the screen does not start with L');
if (s.pokeBytes(0x3F00, [1, 2, 3]) !== 3 || s.readByte(0x3F01) !== 2) fail('poke');

// machine code from the bundled assembler, run on the built-in firmware
const res = assemble('        ORG $3000\nSTART   LDA #$2A\n        STA $3100\nDONE    BRA DONE\n        END START\n', '6809');
s.runAssembled(res);
s.runFrames(1);
if (s.readByte(0x3100) !== 0x2A) fail('the assembled program did not run');

// the picture: a Frame of colour codes and a colour table; frameToRGBA gives the pixels, framePng a PNG file
const frame = s.machine.render();
const rgba = frameToRGBA(frame);
const png = framePng(frame);
if (rgba.length !== frame.width * frame.height || png[1] !== 0x50) fail('render');

// snapshots: a file the page opens too, restored into another Session
const { bytes } = await s.snapshotFile();
const t = new Session({ welcomeMenu: false });
t.switchMachine('dragon64', {}, { menu: false });
t.openSnapshot(await t.readSnapshot(bytes));
s.runFrames(10); t.runFrames(10);
if (t.machine.id !== 'coco' || !frameToRGBA(t.machine.render()).every((p, i) => p === frameToRGBA(s.machine.render())[i])) fail('snapshot');
console.log('example passed');
```

`tests/cli.test.js` runs this example and the script above on every test run, so they stay correct.

### A complete example that runs from outside the repository

`docs/examples/headless-frame.mjs` is one runnable file that uses only the public modules (`js/emu.js`, and `cli/cloadm.js`
for the PNG encoder; no test helper): it makes a Session on a Dragon 64, assembles `docs/examples/framecount.asm` (read from the
repository) and loads it as a DragonDOS binary (`session.load`), waits on the guest's frame counter, holds SPACE in the keyboard matrix, steps a frame,
reads the raw framebuffer (`frame.data`: one colour code a pixel; `frame.table`: the RGBA of each code; `frame.active`: where
the 256x192 picture sits inside the border), writes a PNG and prints what elapsed. It finds the repository from its own
path, so it runs from any directory; a copy of the one file anywhere else needs only `CLOADM_DIR` pointing at the repository
(the guest source and the modules are read from there):

```sh
cd /tmp                                              # anywhere
node /path/to/cloadm/docs/examples/headless-frame.mjs out.png
CLOADM_DIR=/path/to/cloadm node my-copy-of-it.mjs out.png
```

```json
{"png":"out.png","frame":[320,240],"picture":{"x":32,"y":24,"width":256,"height":192},"litOnRow96":16,"frames":8,"cycles":142264,"counter":6,"keySeenAtTick":5}
```

`tests/dev-docs-headless.test.js` runs it from a temporary directory outside the repository (and from a copy of the `.mjs`
alone, with `CLOADM_DIR`), and compares the line above with what it prints, so it cannot rot. Everything it calls is reachable from `js/emu.js` and `cli/cloadm.js`, but not every call is in
the stability table below: `machine.setKey`, `machine.keyPos`, `machine.frameCount`, `machine.now()` and the `Frame`
fields are what the command line itself uses, and are not promised there.

### A snapshot with a serial peer outside the machine

A snapshot holds the machine and the serial device plugged into it. For the terminal that is the device's kind and baud, the
line level, the **bytes handed to the machine that it has not finished receiving** (`queue`) and the decoder of the byte
being sent the other way (`tests/state.test.js`: "The serial terminal: a byte on its way to the machine is part of the
snapshot"; and "The Dragon 64's 6551 ACIA with a loopback plug", a byte shifted out and back when the snapshot is taken). It does **not** hold your peer:
its own queue (what it has not yet handed over), what it has received, its backing file or the offset in it, or the
`onReceive` hook (`Session.openSnapshot` makes a new machine and re-plugs only the Session's own terminal log, `terminalBytes`,
which starts empty). So a peer that must resume has three jobs, in this order:

1. **Freeze.** Stop handing over bytes (no more `serialSend`) and stop the host side. Then `machine.serialPort.flush(machine.now())`:
   the port decodes what the machine sends lazily, so this delivers every byte the machine has *completely* sent to
   `onReceive`, and the one in the middle of being sent stays in the decoder (which the snapshot holds) and arrives after the
   restore (`tests/state.test.js` flushes before it snapshots the bit-banger).
2. **Save the peer next to the snapshot**, under the same name: the number of bytes it **handed to the machine** (not the
   number the machine has read: the difference is the queue, which is in the snapshot), what it has received and its offset
   in the backing file.
3. **Resume.** `openSnapshot` in the new Session, hook `serialPort.onReceive` again, rebuild the peer from its saved state and
   carry on from the byte after the last one it handed over. The queued bytes arrive by themselves; handing them over
   again would send them twice.

```js
// example: serial-peer
import { readFileSync } from 'node:fs';
import { Session, assemble } from './js/emu.js';

const fail = (what) => { throw new Error(`example: ${what}`); };
const FILE = [...'HELLO, DRAGON! 0123456789'].map((c) => c.charCodeAt(0));   // the peer's backing "file"
// the guest: a 1200-baud receiver on the CoCo's bit-banger that keeps what it receives at $3200 (COUNT at $31FF)
const guest = assemble(readFileSync('docs/examples/serialrx.asm', 'utf8'), '6809');
if (!guest.ok) fail('serialrx.asm does not assemble');
const start = () => {
  const s = new Session({ welcomeMenu: false });
  s.switchMachine('coco', {}, { menu: false });
  s.attachSerial('terminal', { baud: 1200 });
  s.runAssembled(guest);
  s.runFrames(2);
  return s;
};
const received = (s) => String.fromCharCode(...Array.from({ length: s.readByte(0x31FF) }, (_, i) => s.readByte(0x3200 + i)));

// the peer: hands the machine three bytes of its file every other frame; its state is how many it has handed over
class Peer {
  constructor(session, saved = { sent: 0, got: [] }) {
    this.session = session; this.sent = saved.sent; this.got = saved.got.slice();
    session.machine.serialPort.onReceive = (b) => this.got.push(b);   // what the machine sends back (this guest sends nothing)
  }
  tick() { for (let i = 0; i < 3 && this.sent < FILE.length; i++) this.session.serialSend([FILE[this.sent++]]); }
  save() { return JSON.parse(JSON.stringify({ sent: this.sent, got: this.got })); }
}
const run = (s, peer, frames) => { for (let f = 0; f < frames; f++) { if (f % 2 === 0) peer.tick(); s.runFrames(1); } };

// the uninterrupted run
const a = start(); run(a, new Peer(a), 120);
if (received(a) !== 'HELLO, DRAGON! 0123456789') fail(`uninterrupted: ${received(a)}`);

// frozen part way, in this order: stop feeding, flush the port, snapshot, save the peer
const s = start(), peer = new Peer(s);
run(s, peer, 5);
s.machine.serialPort.flush(s.machine.now());
const snapshot = (await s.snapshotFile()).bytes, saved = peer.save();
if (s.readByte(0x31FF) >= saved.sent) fail('nothing is on its way to the machine: pick another moment');   // handed over 9, received 8

// resumed: a new Session, the hook again, the peer rebuilt and carrying on from the byte after the last one handed over
const t = new Session({ welcomeMenu: false });
t.openSnapshot(await t.readSnapshot(snapshot));
if (t.machine.serialPort.kind !== 'terminal' || t.machine.serialPort.baud !== 1200) fail('the terminal is not back');
run(t, new Peer(t, saved), 120);
if (received(t) !== received(a)) fail(`resumed: ${received(t)}`);

// resumed from what the machine had READ instead of what the peer had HANDED OVER: the byte on the wire arrives twice
const u = new Session({ welcomeMenu: false });
u.openSnapshot(await u.readSnapshot(snapshot));
run(u, new Peer(u, { sent: s.readByte(0x31FF), got: [] }), 120);
if (received(u) === received(a) || u.readByte(0x31FF) !== a.readByte(0x31FF) + 1) fail(`the wrong resume should send one byte twice: ${received(u)}`);
console.log('example passed');
```

The example runs on the CoCo's bit-banger because its guest is small. The Dragon 64, 200 and Tano's 6551 has its own port object
(`machine.serialPort` is it too: `attachSerial`, `serialSend`, `onReceive` and `flush` are the same calls) and its registers and
shift state are in the snapshot as well (`tests/state.test.js`: "The Dragon 64's 6551 ACIA with a loopback plug", a byte shifted out
and back when the snapshot is taken). The example does not exercise the machine-to-peer direction: its guest only receives.

### What is stable

| Stable: kept working, changes noted in the CHANGELOG | |
|---|---|
| The command line | every step, its argument syntax, the `--json` fields above, the exit codes and error codes; `--describe` gives them all with `schemaVersion`, which goes up when one changes incompatibly |
| `new Session({ welcomeMenu })` | `false` for scripts: nothing offers the welcome menu |
| `switchMachine(id, config, { menu })`, `machine`, `profiles` | the models and their options |
| `addRoms(files)`, `machineRoms()`, `runWithoutRoms()` | your ROMs, identified per model |
| `load(name, bytes, { remember: false })`, `insertTape`, `await importDisk(name, bytes, drive)`, `startLiza`, `startWelcome`, `runAssembled(assemble(src, cpu))` | media and programs |
| `runFrames(n)` | emulated frames, no clock; `advance(ms)` is the page's real-time pacing |
| `typeText(text)`, `untypable(text)` | typing; for BREAK, CLEAR and the arrows, `machine.typist.press(key)` with ROMs (the keyboard matrix), and `machine.stubKeys.push(code)` on the built-in firmware (its POLCAT codes: BREAK 3, CLEAR 12, LEFT 8, RIGHT 9, DOWN 10, UP 94) |
| `screenTextTool(session)`, `screenText()` | the screen as text (the first is the full reader; the second the raw 32x16 VDG page) |
| `readByte(addr)`, `pokeBytes(addr, bytes)` | memory |
| `machine.render()`, `frameToRGBA(frame)`, `framePng(frame)` | pictures |
| `await snapshotFile()`, `await readSnapshot(bytes)`, `openSnapshot(snap)` | snapshots |
| `debug` (`addBreakpoint`, `step`, `registers`, …) | the debugger, as the page's Debugger screen uses it |

Everything else — the chips, the CPU cores, the machine classes, the scheduler, the snapshot's `state` layout and
the Claude chat — is internal: it changes whenever the emulation needs it to.

## Packaging

The tool is `cli/cloadm.js`, a CommonJS script like the rest of `tools/` and `tests/`, run as
`node cli/cloadm.js`. There is deliberately no root `package.json`: the repository is a static site with no build
step, and its tests and tools are CommonJS `.js` files, which a root `package.json` with `"type": "module"` would
turn into ES modules and break; one without it would add an npm surface (installs, a lockfile, a `bin` link) for a
tool that needs none. To call it `cloadm`, add an alias (`alias cloadm='node /path/to/cloadm/cli/cloadm.js'`) or put
a one-line wrapper on your `PATH`.

---

See also: [Game development](game-development.md) · [Using CLOADM](using.md) · [Development](development.md) · [Architecture](architecture.md)
