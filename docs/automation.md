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
| `--asm FILE` | assemble a source file with the bundled assembler, for the machine's CPU, and **run** it (`INCLUDE`s are read from its folder); to write a file instead, see [Assemble to a file](#assemble-to-a-file) |
| `--symbols FILE` | read a symbol map (what `--assemble --map` writes, or an LWLINK or CMOC map) into the labels `--disasm` shows and `--wait-for pc:LABEL` reaches; it replaces the labels `--asm` gave |
| `--cart FILE` | plug in a cartridge ROM image |
| `--tape FILE` | put a `.cas` or `.wav` in the deck without loading it (then type `CLOAD`) |
| `--disk [N=]FILE` | mount a VDK, JVC/DSK or DMK image in drive N (default 0). Without your disk ROM it goes in on the disk controller alone, for a program that reads the disk through the controller's registers (`DIR` and the other disk commands need the disk ROM): the step prints the note to stderr, and with `--json` its result has it as `note` (an added field: the schema version is unchanged) |
| `--load-snapshot FILE` | open a snapshot, switching to its machine |
| `--type TEXT` | type at the keyboard, then run until the machine has taken the keys. `\n` or `{ENTER}` is ENTER; also `{BREAK}`, `{CLEAR}`, `{UP}`, `{DOWN}`, `{LEFT}`, `{RIGHT}`, `{SPACE}`; `\\` is a backslash |
| `--hold KEYS[:N]` | hold keys down in the keyboard matrix for N frames (default 1), then let go, for programs that read the matrix themselves (games): `RIGHT:10`, `LEFT+SPACE:3`, `{UP}`, `Z:5`. Names are the matrix's: letters, digits, `UP` `DOWN` `LEFT` `RIGHT` `SPACE` `ENTER` `CLEAR` `BREAK` `SHIFT` (and the CoCo 3's `ALT` `CTRL` `F1` `F2`) |
| `--frames N`, `--seconds S` | run N frames, or S seconds of emulated time |
| `--wait-for COND` | run until `text:REGEX` is on the screen, `mem:ADDR=VALUE` holds, or the PC reaches `pc:ADDR` or `pc:LABEL` (it stops at that instruction; a label comes from `--asm` or `--symbols`, in any letter case); exit 1 at the timeout |
| `--timeout S` | emulated seconds each later `--wait-for` and `--type` may take (default 10) |
| `--expect-screen REGEX`, `--expect-mem ADDR=VALUE` | must hold now, or exit 1 |
| `--expect-screenshot FILE` | the frame must match a reference PNG pixel for pixel, or exit 1 (see [Pictures and sound](#pictures-and-sound)) |
| `--tolerance N` | how many pixels each later `--expect-screenshot` may find different (default 0) |
| `--diff FILE` | each later `--expect-screenshot` writes a picture of the differences to FILE |
| `--screen` | the text on the screen |
| `--screenshot FILE` | the frame as a PNG |
| `--wav FILE` | record the machine's sound from here until `--wav-stop` or the end of the run, as a 16-bit mono WAV (see [Pictures and sound](#pictures-and-sound)) |
| `--wav-stop` | end the recording and write its file |
| `--record FILE` | record the picture and sound from here until `--record-stop` or the end of the run, as one AVI file (see [Recording a clip](#recording-a-clip)) |
| `--record-dir DIR` | the same as a PNG per frame, a WAV and an ffconcat list, with no size limit |
| `--record-stop` | end the recording and write it |
| `--serial-trace FILE` | trace the serial port from here to the end of the run (the last 65,536 events), written as JSON Lines, one event a line, also when the run fails (see [The serial port from Node](#the-serial-port-from-node)) |
| `--disk-trace FILE` | trace the disk controller from here to the end of the run (the last 65,536 events), written as JSON Lines, one event a line, also when the run fails (see [Tracing the disk controller](#tracing-the-disk-controller)) |
| `--profile FILE[:cycles\|samples]` | profile where the CPU spends its time from here to `--profile-stop` or the end of the run, by symbol (see [Finding hot spots](#finding-hot-spots)); FILE gets a text table, or JSON with `--json` |
| `--profile-stop` | end the profile and write its file |
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
* **Disk controller**: a cartridge in the cartridge port. With your own disk ROM (`--roms`, then `--disk [N=]FILE`) the
  DOS comes with it; without one, `--disk` (`importDisk` in Node) plugs in the bare controller, with an empty ROM
  socket, for a program that drives the chip itself ([Reading a disk with no DOS ROM](#reading-a-disk-with-no-dos-rom));
  `DIR` and the other disk commands need the ROM. The Dragon Alpha's controller is built in. The MC-10 and Alice have no cartridge port, so no disk. The command line
  can trace it (`--disk-trace FILE`; [Tracing the disk controller](#tracing-the-disk-controller)).
* **6551 ACIA** (Dragon 64, 200 and Tano at `$FF04-$FF07`; [the machine notes](machines.md) list the Dragon 64's
  serial port): "with its port" means `session.serial.attach('terminal' | 'loopback' | 'none', { baud })` plugs
  something into its RS-232 port. Plugging in and sending are Node only ([the serial port from
  Node](#the-serial-port-from-node)); the command line can trace the port (`--serial-trace FILE`).
* **Bit-banger**: the CoCo's and the MC-10's serial port, driven by the program through PIA1
  (`session.serial.attach('printer' | 'terminal' | 'loopback', { baud })`; a serial printer is plugged in by default).
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

### Recording a clip

`--record clip.avi` records every frame that runs after it, picture and sound together, until `--record-stop` or the
end of the run (also when the run fails: the file holds the frames recorded until then). The file is a RIFF AVI 1.0
with two streams, readable by ffmpeg, VLC and video editors, and needing nothing else to make it (no ffmpeg):

* **video:** 8-bit palettized, uncompressed: the frame's own colour codes and its 256-entry colour table (the frame
  `--screenshot` saves, unscaled), with a palette-change chunk before any frame whose table changed (the CoCo 3's
  composite monitor, artifact colours). The frame rate is the machine's exact one, `tickHz / frameCycles` as a
  fraction: 888625/17784 (about 49.97) on the PAL Dragons, 3579545/59736 (about 59.92) on the NTSC CoCo 1/2 and MC-10.
* **audio:** 16-bit mono PCM at 44100 Hz, the samples `--wav` makes (see [Pictures and sound](#pictures-and-sound)).
  Frame k gets the samples from floor(k x 44100 / fps) to floor((k + 1) x 44100 / fps), the remainder carried as an
  exact fraction, so picture and sound stay in step however long the clip: no resampling and no drift to correct.

Everything is emulated time, so the same command gives the same file, byte for byte. The `record` step's result gives
`file`, `fps` (the fraction), `rate`, `bits`, and, once written, `frames`, `width`, `height`, `size` and `samples`.

```sh
node cli/cloadm.js --load game.bin --wait-for 'text:PRESS SPACE' --record attract.avi --seconds 20
node cli/cloadm.js --script playthrough.cloadm      # a script with record clip.avi ... record-stop around the play
ffmpeg -i attract.avi -c:v libx264 -pix_fmt yuv420p -vf scale=iw*2:ih*2:flags=neighbor -c:a aac attract.mp4   # to share it
```

An AVI 1.0 file stops at 1 GiB (about four and a half minutes of a 320x240 Dragon screen): the frame that would pass it ends the
run with `record-too-big` (exit 3), the file written up to that frame. For longer runs, `--record-dir DIR` records the
same frames as `DIR/frame00000.png`, `frame00001.png`, ..., the sound as `DIR/sound.wav`, and `DIR/frames.ffconcat`, a
list for ffmpeg's concat demuxer giving each frame's duration to the microsecond (rounded from the exact start times,
so the durations add up to the clip's exact length):

```sh
node cli/cloadm.js --load game.bin --record-dir clip --seconds 600
ffmpeg -f concat -i clip/frames.ffconcat -i clip/sound.wav -c:v libx264 -pix_fmt yuv420p -c:a aac clip.mp4
```

A recording keeps one picture size. A frame of another size (the Dragon 64 Plus switched to its 80-column screen with
`--view plus`) ends the run with `record-size-changed` (exit 3), naming the frame; the frames before it are written.
Record each part on its own: `--record-stop`, the change, then a new `--record`.

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

### Assemble to a file

`--asm` assembles **and runs** a program on a machine. `--assemble` only **writes a file** and builds no machine, so it needs no
ROMs, takes no steps and runs in a fraction of a second, for a build script that hands the binary to something else:

```sh
node cli/cloadm.js --assemble game.asm --cpu 6809 --format dragondos --out game.bin --map game.map
node cli/cloadm.js --assemble game.asm --machine coco --out game.bin     # --format decb, and the CPU, come from the model
node cli/cloadm.js --load game.bin --symbols game.map --wait-for pc:LOOP --expect-mem '$3100=65'   # a second process runs it
```

| Option | |
|---|---|
| `--assemble FILE` | the source; `INCLUDE`s are read from its folder |
| `--out FILE` | where the binary goes (required) |
| `--cpu 6809\|6309\|6803\|7000` | the instruction set. With `--machine` it is the model's default (`--cpu` must be one the model has) |
| `--machine ID` | the model, to take the CPU and the format from |
| `--format dragondos\|decb\|raw\|cas\|wav` | **DragonDOS**: `$55 type load length exec $AA` and the data, one contiguous range (a gap between two pieces is zero-filled up to 256 bytes; a bigger one is `bad-media` with the hint `use --format decb`). **decb**: the segmented Color BASIC `LOADM` file, `$00 length address data` per piece and `$FF $00 $00 exec`. **raw**: the bytes of the one contiguous range with no header (the same gap rule). Without `--format` it follows `--machine`: the Dragons get `dragondos`, the CoCos `decb`; the MC-10 and Alice load `.c10` tapes, not binary files, so `--machine mc10` or `alice` is refused (exit 2: "The MC-10 loads .c10 tapes, not binary files: there is no file format to save a program in for it.") whatever `--format` says (the message adds that `--format cas` or `wav` writes a tape for it, which they do load); for a 6803 program as bytes use `--cpu 6803 --format raw` with no machine. **cas** and **wav** are a tape: see [A tape for a real Dragon or CoCo](#a-tape-for-a-real-dragon-or-coco). Without `--machine`, `--format` and `--cpu` are required |
| `--name NAME`, `--square` | for `--format cas` or `wav`: the file's name on the tape (up to 8 printable ASCII characters; default the source's file name, upper case) and, for `wav`, a square wave instead of a sine |
| `--map FILE` | one `NAME $ADDR` line per symbol, sorted by address |
| `--json` | `{ ok, exit, assemble: { source, cpu, machine, format, out, size, load, exec, segments, map } }`, or `error` as for any run |

The errors are the ones every run has: an unreadable source is `cannot-read`, an assembly error or a gap is `bad-media` (exit 3,
`errors` listing the lines), a file that cannot be written is `cannot-write`, a wrong or missing option is a usage error
(exit 2). The Dragon 200-E is a Dragon here (it loads DragonDOS files), although the page's media matching counts it with the CoCos.

`--symbols FILE` is the other half: it reads a map into the session's labels (`--asm` gives the program's own), so `--disasm` puts the
label before the instruction (`label` and `targetLabel` in `--json`) and `--wait-for pc:LABEL` stops at it. It reads the `NAME $ADDR` lines `--map` writes, plain
`name address` lines with a hexadecimal address, and an LWLINK `-m` map (`Symbol:` lines); a line it cannot read is `bad-media`
and names the line. The LWLINK and CMOC forms are the formats as documented, tested on hand-written samples, not on a map from the
tool itself.

In Node, `toBinary(result, { format: 'dragondos' | 'decb' })` makes the same bytes (the format is required: there is no default,
because which one a program wants depends on the machine that loads it); `writeDragonDos(segments, exec, { type, maxGap })` (`maxGap` 256 by default, the same limit as the command line) and
`writeDecb(segments, exec)` in `js/media/formats.js` are the writers behind it, the round-trip partners of `parseDragonDos` and
`parseDecb`; `formatSymbols`, `parseSymbols` and `lookupSymbol` are in `js/asm/symbols.js`.

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
`{ line, message }`, when an assembly failed; `screenshot` when an `--expect-screenshot` failed; `machine: { pc,
frame, cycles }`, `serial` (`session.diagnostics().serial`: the device, the 6551's status decoded, the bytes still
on their way to the machine; `null` on a model without a serial port) and `disk` (`session.diagnostics().disk`: the
disk controller's status decoded; `null` without one) when a `timeout` or `keys-not-taken` stopped the run), and `roms` lists how each ROM file given was identified. `machine` is
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
| `rejected` | 3 | the machine refused the media or request (a BASIC program without BASIC, a disk on a machine with no drives, an unknown register) |
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
const m = s.shownMachine;
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
rate is the video standard's, not the family's. **PAL** machines (`dragon32`, `dragon64`, `dragon200`, `dragon200e`, `dgnalpha`,
`d64plus`: the Dragons but the Tano; and `coco3p`, the CoCo 3 (PAL)) run 17,784 CPU cycles a frame, 49.97 fields a second on the
Dragons (888,625 Hz) and 50.04 on the CoCo 3 (PAL) (889,844 Hz). **NTSC** machines (`coco`, `coco2b`, `mx1600`, `lzcolor64`,
`cd6809`, `cp400`: the CoCo 1/2, 2B and clones; `coco3`; `tanodr64`, the Tano Dragon 64, which is NTSC; and `mc10` and `alice`) run
14,934 cycles a frame, 59.92 a second (894,886 Hz). `--frames`,
`--hold` counts and the `frames` in a `--wait-for` result are those frames, and a `mem:` condition is checked as each frame
ends, so a wait finishes at the first frame boundary at which the byte holds, not at the instruction that wrote it (use
`--wait-for pc:` to stop at an instruction). A guest that does more than a frame's work between field syncs simply ticks slower
than the frames run: its counter then advances less than once a frame.

**What "cycles" counts.** `--step N` reports CPU cycles. `machine.now()` is the machine's own clock, which is the CPU cycle on
the Dragons, the CoCo 1/2 and the MC-10 but the GIME's clock (four times the 0.89 MHz CPU cycle: 59,736 a frame NTSC, 71,136 PAL)
on the CoCo 3, where the CPU runs at two speeds; `machine.cpu.totalCycles` counts CPU cycles on every model.

### Applying input on a guest write

Holding keys for whole frames ties input to the video field, not to the guest's own loop. A guest whose tick is not one field
(or a port compared against another renderer, run for run) reads the input at a different point of its loop each run, and two
runs that should match drift apart. `session.watchWrites({ start, end }, fn)` calls `fn` for each CPU write to `start`..`end`
(inclusive) after the writing instruction finishes and before the next one starts, so input can be applied exactly when the
guest writes its frame-complete marker:

* `fn` gets `{ address, value, old, pc, at, frame }`: the byte written and the one it replaced, the address of the instruction
  that wrote it, the machine's time of the write (`machine.ioTime()`, in `machine.now()` units) and the frame it was in
  (`machine.frameCount`). `at` always falls within the writing instruction's own time; on the Dragons and CoCo 1/2 at the slow
  rate it is the start of the instruction's last cycle for most instructions (the timing checked against MAME; the CPU core
  counts a push's cycles as it goes, so `PSHU A,B` times its two bytes at its 5th and 6th cycles of 7), at the address-dependent and fast rates the
  access's own cycle, and on the CoCo 3 the access's time in GIME clocks. A two-byte write (`STD`) or a push (`PSHS`) gives one event a byte, in the order the bus made them.
* In `fn`, `machine.setKey`, the joystick (`machine.joy`) and mouse (`machine.mouse`), `session.serial.send` and
  `session.pokeBytes` take effect from the next instruction. Returning `'stop'` stops the run there, as a debugger stop
  (`session.paused`, `debug.stopReason.kind === 'write'`; `debug.resume()` and `runFrames` go on). `switchMachine`,
  `openSnapshot` and `snapshotFile` throw a `SessionError` inside `fn`.
* A write in a frame's last instruction is delivered before that frame ends. On a CoCo 3 instruction held by the disk
  controller's HALT, each write is reported once, when the instruction completes.
* Only the CPU's bus writes are reported: `pokeBytes`, a load and the debugger's memory edits are not.
* `remove()` takes the observer off (a second call does nothing). Observers belong to the Session, not the machine: they move
  to the new machine on `switchMachine` and `openSnapshot`, and no snapshot carries them. With none registered the machine
  runs exactly as before; with one, the Session runs each frame an instruction at a time (up to about 1.5 times the work).

This guest is `docs/examples/framecount.asm` with a marker: each tick it counts `FRAME`, writes the count to `DONE`, then reads
the keyboard and records in `KEYSEEN` and `HELD` the ticks that found SPACE down. The observer presses SPACE as the guest
writes marker 10 and lets go at marker 12, so exactly ticks 10 and 11 see it, whatever the frame timing:

```js
// example: input-on-write
import { Session, assemble } from './js/emu.js';

const fail = (what) => { throw new Error(`example: ${what}`); };
const res = assemble(`FRAME   EQU     $3100
KEYSEEN EQU     $3101
DONE    EQU     $3102
HELD    EQU     $3103
        ORG     $3000
START   ORCC    #$50
        CLR     FRAME
        CLR     KEYSEEN
        CLR     HELD
TICK    LDA     $FF02           ; wait for the field sync
WAITFS  LDA     $FF03
        BPL     WAITFS
        INC     FRAME
        LDA     FRAME
DONEPC  STA     DONE            ; the frame-complete marker
        LDA     #%01111111      ; keyboard column 7 (SPACE)
        STA     $FF02
        LDA     $FF00
        ANDA    #%00101000
        CMPA    #%00101000
        BEQ     NOKEY
        LDA     FRAME           ; SPACE is down at this tick
        STA     KEYSEEN
        INC     HELD
NOKEY   LDA     #$FF
        STA     $FF02
        BRA     TICK
        END     START`, '6809');
if (!res.ok) fail(res.errors.map((e) => e.message).join('; '));

const s = new Session({ welcomeMenu: false });
s.switchMachine('dragon64', {}, { menu: false });
s.runAssembled(res);
const m = s.shownMachine, DONEPC = res.symbols.get('DONEPC');
const w = s.watchWrites({ start: 0x3102, end: 0x3102 }, (ev) => {
  if (ev.pc !== DONEPC || ev.old !== ((ev.value - 1) & 0xFF)) fail(`unexpected write ${JSON.stringify(ev)}`);
  if (ev.value === 10) m.setKey('SPACE', true);    // the guest's next keyboard read sees it
  if (ev.value === 12) m.setKey('SPACE', false);
  if (ev.value === 15) return 'stop';              // stop right after the marker write
  return undefined;
});
s.runFrames(30);
if (!s.paused || s.debug.stopReason.kind !== 'write' || s.readByte(0x3100) !== 15) fail('no stop at marker 15');
if (s.readByte(0x3103) !== 2 || s.readByte(0x3101) !== 11) fail(`SPACE seen ${s.readByte(0x3103)} times, last at tick ${s.readByte(0x3101)}`);
w.remove();
s.debug.resume();
s.runFrames(2);
if (s.paused || s.readByte(0x3100) !== 16) fail(`after resume, tick ${s.readByte(0x3100)}`);
console.log('example passed');
```

### Finding hot spots

A slow build tells you how many frames it takes, not where they go. A **profile** charges every CPU cycle to the
instruction that spent it, folds the counts into the program's symbols, and says which of that time was spent
**spinning**: waiting on a poll rather than computing.

```sh
node cli/cloadm.js --asm docs/examples/framecount.asm --frames 5 --profile hot.txt --frames 50 --profile-stop
```

```text
889199 cycles; halted 0; outside any symbol 0
 share         count   spin  where
 99.9%        888449    99%  WAITFS $3046-$3068  polls $FF02 $FF03
  0.1%           500     1%  NOKEY $3069-$30FF  polls $FF02 $FF03
  0.0%           250     8%  TICK $3043-$3045  polls $FF02 $FF03
(counts are keyed by CPU address: banked or MMU-mapped code that runs at one address is counted together)
```

Here nearly all the time is the field-sync wait (`WAITFS` polling `$FF03`, PIA0's field-sync flag): the program is
idle, not slow (`$FF02` is read to clear the flag). A row that is hot and **not** spin is where to optimise.

* **Symbols.** The labels `--asm` gave, or a map read with `--symbols` (`--assemble --map`, an LWLINK or CMOC map), as
  they are when the profile is written. A symbol's range runs from its address to the next symbol's, at most 4K bytes;
  addresses no symbol covers are counted in 256-byte pages (`symbol` null), and `unattributed` is their total.
* **`cycles`** (the default) is exact: the total is the CPU's cycle count over the profile (`cpu.totalCycles`; CPU
  cycles on the CoCo 3 too, whatever its GIME clock does). **`samples`** takes one PC every 1000 cycles and counts
  samples. Cycles in which the disk controller's HALT holds the CPU are no instruction's: they are the `(halted)` row.
  The cycles an interrupt takes to enter (stacking the registers) count to the instruction it interrupted.
* **Spin.** The instructions are taken 32 at a time; a window is spin when it ran at most 4 distinct instructions,
  wrote no RAM, and read I/O (`$FF00`-`$FFFF`; on the MC-10 the `$BF00`-`$BFFF` page: keyboard read, VDG latch write) or read one RAM byte more than once. A row's `spin.share` is the part of its count made in spin
  windows, and `spin.polls` the addresses those windows read. A delay loop that only counts in a register is compute.
  The MC-10's 6803 keeps its ports, timer and serial registers (`$0000`-`$001F`) and its own RAM (`$0080`-`$00FF`, while
  the RAM control register's RAME bit is set)
  off the machine's bus, so the profile sees no access to them: a wait on a 6803 port alone counts as compute.
* **One address space.** The counts are keyed by CPU address: code banked in or mapped by the CoCo 3's MMU at the same
  address is counted together, and the report says so (`note`).
* **Cost.** While a profile runs, the machine runs 1.4 to 1.7 times slower (`node tools/profile-cost.js` measures it on
  the Dragon 64, CoCo 3 and MC-10); with none, nothing is attached and nothing is slower. A profile is host state:
  no snapshot carries it, and opening a snapshot starts it empty.

From Node, `session.profile({ mode, every, symbols, buckets })` starts one; `report({ top })` reads it at any time and
`stop()` ends it with its last report: `{ mode, every, total, halted, unattributed, rows, ranges, note }`, each row
`{ symbol, start, end, count, share, spin: { share, polls } }`, largest first (`top`, default 30, of them). `every`
is the sample period in cycles; `buckets` (default 4096) the most ranges a report keeps, the smallest beyond it
summed in one `(other)` row; `symbols` a Map or object of name to address, by default the Session's labels.

```js
// example: hot-spots
import { readFileSync } from 'node:fs';
import { Session, assemble, profileText } from './js/emu.js';

const fail = (what) => { throw new Error(`example: ${what}`); };
const s = new Session({ welcomeMenu: false });
s.switchMachine('dragon64', {}, { menu: false });
s.runAssembled(assemble(readFileSync('docs/examples/framecount.asm', 'utf8'), '6809'));
s.runFrames(5);                              // past its start (it clears the picture first)

const t0 = s.shownMachine.cpu.totalCycles;
const p = s.profile();                       // mode 'cycles': every cycle, exactly
s.runFrames(50);
const r = p.stop();
console.log(profileText(r));

if (r.total !== s.shownMachine.cpu.totalCycles - t0) fail('the total is not the CPU\'s cycle count');
const top = r.rows[0];
if (top.symbol !== 'WAITFS' || top.share < 0.99) fail(`the hot spot is ${top.symbol}`);
if (top.spin.share < 0.95 || !top.spin.polls.includes('$FF03')) fail('the field-sync wait is not spin on $FF03');
console.log('example passed');
```

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

// the screen, through Claude's screen_text reader. Its tools take a TARGET - Session.chatTarget() gives one
// (the machine in use; the BASIC session if a full-screen chat is open), not the Session itself, which has two
// machines and says which it means through an accessor
const screen = screenTextTool(s.chatTarget());
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
const frame = s.shownMachine.render();
const rgba = frameToRGBA(frame);
const png = framePng(frame);
if (rgba.length !== frame.width * frame.height || png[1] !== 0x50) fail('render');

// snapshots: a file the page opens too, restored into another Session
const { bytes } = await s.snapshotFile();
const t = new Session({ welcomeMenu: false });
t.switchMachine('dragon64', {}, { menu: false });
t.openSnapshot(await t.readSnapshot(bytes));
s.runFrames(10); t.runFrames(10);
if (t.shownMachine.id !== 'coco' || !frameToRGBA(t.shownMachine.render()).every((p, i) => p === frameToRGBA(s.shownMachine.render())[i])) fail('snapshot');
console.log('example passed');
```

`tests/cli.test.js` runs this example and the script above on every test run, so they stay correct.

### Which machine the developer API acts on

A Session has one machine in use, except while the Claude chat is full screen: then the chat's own machine is on
screen (`shownMachine`) and the person's machine, the BASIC session, runs beside it, a frame for each of the chat's
(`personMachine`; the two are the same machine otherwise). The developer API always acts on the **person's** machine,
never the chat machine: `serial` (its device, `send`, subscribers and traces), `disk` (`status` and traces),
`watchWrites`, `profile` and `diagnostics()`, like the loads, disks and tapes. Their probes, taps and listeners are
on the Session's hooks registry (`js/hooks.js`), which moves with the person's machine: a full-screen chat opening or
closing leaves them where they are. The debugger (`debug`) is the exception: it belongs to the machine on screen. A
`watchWrites` callback that returns `'stop'` on the BASIC session beside a full-screen chat stops that machine right
after the write and pauses the Session as a debugger stop, as it would with the BASIC session on screen.

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
alone, with `CLOADM_DIR`), and compares the line above with what it prints, so it cannot rot. Everything it calls is in the stability table below.

### The serial port from Node

`session.serial` is the serial port of the Session's machine (the Dragon 64, 200 and Tano's 6551; the CoCo's and the
MC-10's bit-banger), for a program that talks to the guest over the wire: a file server, a modem, a test harness.

```js
session.serial.device                    // { chip: '6551' | 'bit-banger', kind, baud, kinds } or null (no serial port)
session.serial.attach('terminal', { baud: 9600 })   // 'none' | 'printer' | 'terminal' | 'loopback' (as kinds lists)
session.serial.send([0x41, 0x0D])        // a Uint8Array or an array of 0..255 -> the count; anything else is a SessionError
session.serial.send('RUN\n', { text: true })        // text, newlines as CR, one byte a character
const sub = session.serial.subscribe({ tx(bytes, info) {}, rx(bytes, info) {} }, { flush: 'frame' });
sub.unsubscribe();                       // idempotent
session.serial.flush();                  // deliver every byte completely sent by now
const trace = session.serial.trace({ limit: 4096, registers: 'writes' });   // -> { events, dropped, stop() }
session.serial.status();                 // the 6551's status register, decoded, read without side effects (null on a bit-banger)
session.diagnostics();                   // { pc, frame, now, cycles, serial: { device, status, queued }, disk }
```

**Bytes both ways.** `tx` gets the bytes the machine sent, as the printer or terminal plugged in decoded them; `rx`
gets the bytes `send` handed over, each once it has crossed the wire into the machine (its stop bit has ended), not
when it was sent. `bytes` is a `Uint8Array`; `info` is `{ at, frame, device }`: `at` the machine tick of each byte
(for `tx` the receiver's last sample, the middle of the stop bit; for `rx` the end of the stop bit), `frame` the frame
count when it was delivered, `device` the kind plugged in (a `tx` subscriber hears the serial printer too; the page's
terminal log, the serial panel's own subscriber, keeps only what reached the terminal).
Delivery is at the end of each frame and on `flush()`; a subscriber with `{ flush: 'instant' }` also gets what has
crossed before each instruction the CPU starts (a probe on the machine, there only while such a subscriber is: it
costs a flush an instruction), when `runFrames` returns and when a debugger stops the machine (a breakpoint or
watchpoint), so it sees a byte by the instruction after the one it crossed in. The loopback plug and `'none'` decode
nothing, so their subscribers hear nothing (the 6551's trace still does).

Any number of subscribers get the same bytes in the order they subscribed; the page's terminal log is one of them,
the serial panel's own. A subscriber may call `send` from `tx` (an echo, a protocol's reply). One that throws is unsubscribed, the
others still get their bytes, and the error is thrown after them, out of the `runFrames` (or `flush`) that delivered
it. Subscriptions and traces belong to the Session: `switchMachine`, `openSnapshot` and a power cycle move them to the
new machine (the Session's hooks registry, `js/hooks.js`), and no snapshot holds them (a new Session subscribes
again). They are on the person's machine ([Which machine](#which-machine-the-developer-api-acts-on)). Any number of traces can run at once, each with its own options.

**Why did it stall?** `trace` keeps the last `limit` events in a ring, oldest first (`dropped` counts the ones
pushed out); `stop()` ends it. Every event is `{ at, frame, pc, kind, ... }`:

| `kind` | When | Also |
|---|---|---|
| `tx-load` | the 6551 moves a byte from its transmit data register to the shift register (its start bit begins) | `byte`, `status` |
| `tx` | a byte has gone out: the 6551's stop bit has ended; on the bit-banger, the device has decoded it | `byte` (`status` on the 6551) |
| `rx` | a byte has come in: into the 6551's receive data register; across the bit-banger's wire | `byte` (`status` on the 6551) |
| `overrun` | the 6551 lost a byte: the receive data register was still full | `byte` (the lost one), `status` |
| `framing`, `parity` | the byte just received has that error (6551) | `byte`, `status` |
| `reg-write` | the CPU wrote a 6551 register (0 data, 1 programmed reset, 2 command, 3 control) | `reg`, `value` |
| `reg-read` | with `registers: 'all'`: the CPU read one; a run of the same read giving the same value is one event | `reg`, `value` (what the read returned), `count` |

`status` is the status register as a read would give it; the trace never reads the chip, because a status read
clears the interrupt and a data read clears RDRF. Back to back, the 6551 receives a byte every 10 bit times (a bit is
16 clocks of 1.8432 MHz divided by the control register's divider) and sends one every 10 bit times and one clock,
as MAME's model does (`tests/serial-api.test.js` checks both against the times worked out by hand). A trace costs
nothing when there is none, and does not change the emulation: the MAME-verified runs' hashes are the same with one
on. On the command line, `--serial-trace FILE` writes the same events as JSON Lines, and a `timeout` or
`keys-not-taken` error carries `machine` and `serial` ([Output and exit codes](#output-and-exit-codes)).

### Tracing the disk controller

A disk driver with a wrong sector-length bit, or a byte loop too slow for the controller, looks from outside like a
frozen game. `session.disk` shows what the controller was asked and how each command ended, on every controller:
the Dragon FDC's WD2797, the Premier (Delta) FDC's WD2791, the CoCo FDC's WD1773 and the Dragon Alpha's built-in
WD2797, in the cartridge port, in a Multi-Pak's slot or built in.

```js
const trace = session.disk.trace({ limit: 4096 });   // -> { events, dropped, stop() }
session.disk.status();                   // the controller's registers and status, decoded, without side effects (null: no controller)
session.diagnostics().disk;              // the same
```

`trace` keeps the last `limit` events in a ring, oldest first (`dropped` counts the ones pushed out); `stop()` ends
it. Every event is `{ at, frame, pc, kind, ... }` (`at` the machine tick, `pc` where the CPU was):

| `kind` | When | Also |
|---|---|---|
| `command` | a command takes effect in the controller (its commit delay after the CPU wrote it) | `cmd` (the command byte), `name` (`restore`, `seek`, `step`, `step-in`, `step-out`, `read-sector`, `write-sector`, `read-address`, `read-track`, `write-track`, `force-interrupt`), `drive` (0-3; `null` with none selected), `side`, `track` and `sector` (the registers), `density` (`'single'` or `'double'`) |
| `done` | a command ended: the controller raised INTRQ, or a force interrupt cut it short (then `interrupted: true`) | `cmd`, `name`, `status` (the status register then), `bytes` (the data register reads or writes the CPU made while DRQ was up), `requested` (the sector's length as the controller took it: from the ID's length code, with the WD2797's `b` flag; 6 for read address, 0 for type I (even when a force interrupt cut it short), `null` when no sector was found, for track commands and when a type II or III command was cut short), `lostData`, `crc`, `rnf` (record not found; seek error for type I), `writeProtect` |
| `reg-write` | the CPU wrote a controller register or the drive latch | `reg` (`'command'`, `'track'`, `'sector'`, `'data'`, `'latch'`), `addr` (the address written: `$FF40-$FF43` and the latch at `$FF48` on the Dragon FDC, `$FF48-$FF4B` and `$FF40` on the CoCo FDC, `$FF40-$FF43` and `$FF44` on the Premier; `null` for the Alpha's latch, which is the AY-3-8912's port A), `value` (as the CPU wrote it) |

The two bugs in the trace:

* **A wrong sector-length bit.** The WD2797 reads a sector's length from its ID field and the command's `b` flag (bit
  3): with it set, length code 1 is 256 bytes; without it, 512. A `read-sector` of `$80` on a 256-byte-sector disk
  ends with `requested: 512` (and usually `crc: true`, the controller having run past the sector's end).
* **A byte loop too slow.** In double density a byte passes the head every 32 us, about 28 CPU cycles at 0.89 MHz. A
  loop slower than that ends with `lostData: true` and `bytes` short of `requested`: the controller dropped every
  byte after the first one the CPU missed.

`status()` decodes the status register as the command type in force gives it (type I: `index`, `track0`,
`seekError`, `headLoaded`; types II and III: `drq`, `lostData`, `rnf`, `deletedMark`; both: `busy`, `crc`,
`writeProtect`, `notReady`), with `value`, `controller`, `chip`, `command`, `name`, `track`, `sector`, `data`, the
INTRQ and DRQ lines (`intrq`, `drqLine`), `drive` and `density`. It peeks: reading the status register clears INTRQ,
and the trace and `status()` never do. `value` and the registers are the chip's own; the WD2791's data bus is
inverted, so its CPU reads their complement.

A trace costs one test at each end of a command (and one at each controller register access) when there is none,
and does not change the emulation: the MAME-verified floppy runs hash the same with one on
(`tests/disk-trace.test.js`). Any number of traces can run at once, each with its own ring. Like the serial trace,
they belong to the Session: `switchMachine`, `openSnapshot` and a power cycle move them to the new machine, a disk
cartridge plugged in later is traced too, and no snapshot holds them. On
the command line, `--disk-trace FILE` writes the same events as JSON Lines, also when the run fails, and a `timeout`
or `keys-not-taken` error carries `disk` ([Output and exit codes](#output-and-exit-codes)).

### A snapshot with a serial peer outside the machine

A snapshot holds the machine and the serial device plugged into it. For the terminal that is the device's kind and baud, the
line level, the **bytes handed to the machine that it has not finished receiving** (`queue`) and the decoder of the byte
being sent the other way (`tests/state-carts.test.js`: "The serial terminal: a byte on its way to the machine is part of the
snapshot"; and "The Dragon 64's 6551 ACIA with a loopback plug", a byte shifted out and back when the snapshot is taken). It does **not** hold your peer:
its own queue (what it has not yet handed over), what it has received, its backing file or the offset in it, or its
subscription (in the same Session `openSnapshot` keeps every subscription; a new Session has none). So a peer that must resume has three jobs, in this order:

1. **Freeze.** Stop handing over bytes (no more `send`) and stop the host side. Then `session.serial.flush()`: the port
   decodes what the machine sends lazily, so this delivers every byte the machine has *completely* sent, and the one in
   the middle of being sent stays in the decoder (which the snapshot holds) and arrives after the restore
   (`tests/state-carts.test.js` flushes before it snapshots the bit-banger).
2. **Save the peer next to the snapshot**, under the same name: the number of bytes it **handed to the machine** (not the
   number the machine has read: the difference is the queue, which is in the snapshot), what it has received and its offset
   in the backing file.
3. **Resume.** `openSnapshot` in the new Session, subscribe again, rebuild the peer from its saved state and carry on
   from the byte after the last one it handed over. The queued bytes arrive by themselves; handing them over again
   would send them twice.

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
  s.serial.attach('terminal', { baud: 1200 });
  s.runAssembled(guest);
  s.runFrames(2);
  return s;
};
const received = (s) => String.fromCharCode(...Array.from({ length: s.readByte(0x31FF) }, (_, i) => s.readByte(0x3200 + i)));

// the peer: hands the machine three bytes of its file every other frame; its state is how many it has handed over
class Peer {
  constructor(session, saved = { sent: 0, got: [], arrived: 0 }) {
    this.session = session; this.sent = saved.sent; this.got = saved.got.slice(); this.arrived = saved.arrived;
    session.serial.subscribe({
      tx: (bytes) => this.got.push(...bytes),          // what the machine sends back (this guest sends nothing)
      rx: (bytes) => { this.arrived += bytes.length; },  // what has crossed the wire into the machine
    });
  }
  tick() { for (let i = 0; i < 3 && this.sent < FILE.length; i++) this.session.serial.send([FILE[this.sent++]]); }
  save() { return JSON.parse(JSON.stringify({ sent: this.sent, got: this.got, arrived: this.arrived })); }
}
const run = (s, peer, frames) => { for (let f = 0; f < frames; f++) { if (f % 2 === 0) peer.tick(); s.runFrames(1); } };

// the uninterrupted run
const a = start(), pa = new Peer(a); run(a, pa, 120);
if (received(a) !== 'HELLO, DRAGON! 0123456789' || pa.arrived !== FILE.length) fail(`uninterrupted: ${received(a)}, ${pa.arrived} arrived`);

// frozen part way, in this order: stop feeding, flush the port, snapshot, save the peer
const s = start(), peer = new Peer(s);
run(s, peer, 5);
s.serial.flush();
const snapshot = (await s.snapshotFile()).bytes, saved = peer.save();
if (saved.arrived >= saved.sent) fail('nothing is on its way to the machine: pick another moment');   // handed over 9, 8 across

// resumed: a new Session, subscribed again, the peer rebuilt and carrying on from the byte after the last one handed over
const t = new Session({ welcomeMenu: false });
t.openSnapshot(await t.readSnapshot(snapshot));
if (t.serial.device.kind !== 'terminal' || t.serial.device.baud !== 1200) fail('the terminal is not back');
const pt = new Peer(t, saved);
run(t, pt, 120);
if (received(t) !== received(a) || pt.arrived !== FILE.length) fail(`resumed: ${received(t)}, ${pt.arrived} arrived`);

// resumed from what the machine had READ instead of what the peer had HANDED OVER: the byte on the wire arrives twice
const u = new Session({ welcomeMenu: false });
u.openSnapshot(await u.readSnapshot(snapshot));
run(u, new Peer(u, { sent: s.readByte(0x31FF), got: [], arrived: 0 }), 120);
if (received(u) === received(a) || u.readByte(0x31FF) !== a.readByte(0x31FF) + 1) fail(`the wrong resume should send one byte twice: ${received(u)}`);
console.log('example passed');
```

The example runs on the CoCo's bit-banger because its guest is small. The Dragon 64, 200 and Tano's 6551 takes the same
calls, and its registers and shift state are in the snapshot as well (`tests/state-carts.test.js`: "The Dragon 64's 6551 ACIA
with a loopback plug", a byte shifted out and back when the snapshot is taken). The example does not exercise the
machine-to-peer direction: its guest only receives (`tests/serial-api.test.js` runs both directions on both chips).

### Reading a disk with no DOS ROM

A Dragon disk program that runs its own disk code (a game that loads its levels, a loader of your own) needs the Dragon disk
**controller**, not a DOS. The two are separate parts: the controller is the WD2797 chip and its latch at `$FF40-$FF4F`; DragonDOS is a
ROM in the cartridge (`ddos10.rom`, yours to supply) whose code boots from the disk and gives BASIC its `LOAD` and `DIR`. With a DOS
ROM the machine boots from the disk and the DOS drives the chip for you. Without one, nothing drives the chip but your program:
the cartridge space reads `00`, BASIC has no disk commands, and the guest does a restore, a seek and the reads itself.

`docs/examples/disk-read.mjs` is one runnable file, public modules only (`js/emu.js`), no test helper, that does it from any directory
(from a copy elsewhere set `CLOADM_DIR`):

```sh
node docs/examples/disk-read.mjs
```

1. **A disk in memory.** `blankDisk('vdk', 40, 1)` makes a 40-track single-sided VDK image; `diskGeometry(bytes, 'vdk')` says where a
   sector sits in the file (`headerSize`, `sectors`, `firstSector`, `sectorSize`), and the example writes a known pattern into every
   sector.
2. **A controller with no ROM.** `new devices.dragonfdc()` is the Dragon controller cartridge without a ROM image;
   `machine.insertCartridge(fdc)` plugs it in and `fdc.mount(0, { bytes, format: 'vdk', name })` puts the disk in drive 0. (With no
   DOS ROM the Session's own `importDisk` does the same, and keeps the image in the disk library; the example shows the parts.)
3. **A guest that drives the chip.** `docs/examples/diskread.asm` (6809, built-in firmware) sets the drive latch (`$FF48`: drive 0,
   motor on, double density, NMI off), restores, reads track 0 sector 1, seeks to track 2 and reads sector 5, each 256 bytes with the
   read-sector command `$88` and a DRQ polling loop on `$FF40`/`$FF43`, then writes `$A5` to a done byte. The read command's bit 3
   matters: on a WD2797 it says that the ID's length code 1 means 256 bytes (without it the same code means 512). The loop has to
   take a byte every 28 CPU cycles (double density at 0.89 MHz), or the chip sets *lost data*; the guest's loop takes 26 at most.
4. **The host waits on the byte, and compares.** `session.runAssembled(assemble(...))` runs the guest; the example runs frames
   until `$3100` is `$A5` (bounded), then checks, for each read, that the controller's status shows no error, that the guest took
   exactly 256 bytes, and that RAM holds the sector's bytes. It prints the elapsed frames and CPU cycles:

```json
{"reads":[{"track":0,"sector":1,"at":"$3200","bytes":256,"match":true,"status":"$00"},{"track":2,"sector":5,"at":"$3300","bytes":256,"match":true,"status":"$00"}],"frames":13,"cycles":231185}
```

The numbers are emulated time, so they are the same on every run: the disk turns at 300 rpm, so 13 frames (0.26 s) are mostly the head
stepping to track 2 and the wait for each sector to come round. `tests/disk-read-example.test.js` runs the example from a temporary
directory, and runs it against three broken guests (the wrong sector-length bit, one byte too few, no seek), each of which it must
reject. A guest that asks for a sector the disk does not have never sees DRQ; a program for real use also watches the busy bit
or a timer.

**From the command line.** With no disk ROM, `--disk` plugs the controller in on its own, with an empty ROM socket, and mounts the
disk there (it says so on stderr, and as `note` in `--json`), so the same guest runs without Node:

```sh
node cli/cloadm.js --disk t.vdk --asm docs/examples/diskread.asm --wait-for 'mem:$3100=$A5' --peek '$3200:4' --peek '$3300:4'
```

`--wait-for` runs until the guest sets its done byte, and `--peek` shows the first bytes of the two sectors it read; `--disk` may come
before or after `--asm`. With a DragonDOS ROM given (`--roms DIR --disk t.vdk`) the controller comes with the DOS instead and the
machine boots from the disk; that path needs a ROM CLOADM does not ship, and is not run here. The Node names the example uses
(`devices.dragonfdc`, `machine.insertCartridge`, `fdc.mount`,
`blankDisk`, `diskGeometry`) are public from `js/emu.js` but are not in the stability table below.

### A tape for a real Dragon or CoCo

A game that is to be played from a cassette needs a tape file, and for a real tape player a recording of one: leaders of `$55`
bytes in front of every block, silence around the namefile, a signal of 1200 and 2400 Hz cycles. `buildCas` and `casToWav` make
both from a binary, and `--assemble --format cas|wav` does it from source:

```sh
node cli/cloadm.js --assemble game.asm --machine dragon64 --format cas --name GAME --out GAME.cas
node cli/cloadm.js --assemble game.asm --machine dragon64 --format wav --name GAME --out GAME.wav
node cli/cloadm.js --assemble game.asm --machine coco --format wav --square --out GAME.wav     # a square wave
node cli/cloadm.js --assemble game.asm --machine mc10 --format cas --out GAME.c10               # the MC-10's tape: a .c10 file
```

`docs/examples/bin-to-wav.mjs` is the same in Node, one runnable file with the public modules only (`js/emu.js`), from any directory
(from a copy elsewhere set `CLOADM_DIR`):

```sh
node docs/examples/bin-to-wav.mjs outdir       # writes GAME.cas and GAME.wav there
```

1. `buildCas([{ name, type: 'binary', load, exec, data }], { family })` is the `.CAS` bytes: a namefile block (the name padded to 8, the
   file type, the ASCII flag, the gap flag, the exec and load addresses), the data in blocks of up to 255 bytes, and an end-of-file block, each
   with its 128-byte `$55` leader, `$3C`, type, length, checksum and a trailing `$55`: the stream the writer firmware in
   `tools/mame-diff/tape/csave.asm` writes, which the tape tests check against MAME. Several files go in one list; `type` is `'basic'`,
   `'data'` or `'binary'` (`ascii: true` for BASIC saved as text; a data file is always ASCII, and text is gapped). `family` is `'dragon'`, `'coco'` or `'mc10'`; the three write the same blocks.
2. `casToWav(cas, { family, gaps: 'player', wave: 'sine', sampleRate: 44100, amplitude })` is the signal, one cycle per bit, least
   significant bit first, starting upwards; `wave: 'square'` gives a hard edge. `gaps: 'player'` adds what a tape player does to a
   `.CAS` file: **2 s of silence at the start, 1 s before each later namefile block and 1 s after each namefile block, and a
   leader of 128 `$55` bytes in front of the first block, each namefile and the block after it, made up to 128 when the file has
   fewer**. That is MAME's layout, which the emulated deck plays for a `.CAS` (measured in `tools/mame-diff/tape/gaps.asm`); the
   code is shared: `tapeGaps(cas, { pad })` says where, the deck (`js/media/tape.js`) plays it and `casToSamples` writes it into the
   samples, so a WAV is the tape the emulated machine loads. `gaps: 'none'` plays the bytes as they are. The MC-10 family has no
   motor relay and is not padded: its WAV has no silence, and the 128-byte leader the deck plays in front of its bytes.
3. `wavToCas` reads it back: the `.CAS` bytes exactly (for the MC-10 family after its own leader), also with noise, speed drift,
   inverted phase and a DC offset added.

```json
{"cas":526,"wav":496686,"seconds":5.63,"blocks":3,"file":{"name":"GAME","load":12288,"exec":12288,"bytes":112},"silences":[{"at":0,"seconds":2},{"at":2.76,"seconds":1}]}
```

`tests/bin-to-tape.test.js` checks the stream byte by byte against blocks written out in the test, the silences and leaders in the
signal, the exact decode with impairments, and that the emulated deck plays the WAV into our block-reading firmware
(`tools/mame-diff/tape/cload.asm`, `cload6803.asm`) so that the file's bytes end up in memory on the Dragon 64, Dragon 32, CoCo, CoCo 3, MC-10 and
Alice; it breaks the code three ways (no leader before the second file, a wrong checksum, the MC-10 padded) and each must fail. MAME
reads the same WAVs with the same firmware (`node tools/mame-diff/tape/run-tape.js`), and a real Dragon or CoCo has not been
used: how a given player and a given cable behave is for the person with the hardware. A tape holds one contiguous range per file,
as `CLOADM` loads it: a program in pieces more than 256 bytes apart is `bad-media`.

### What is stable

| Stable: kept working, changes noted in the CHANGELOG | |
|---|---|
| The command line | every step, its argument syntax, the `--json` fields above, the exit codes and error codes; `--describe` gives them all with `schemaVersion`, which goes up when one changes incompatibly |
| `new Session({ welcomeMenu })` | `false` for scripts: nothing offers the welcome menu |
| `switchMachine(id, config, { menu })`, `shownMachine`, `personMachine`, `profiles` | the models and their options. `shownMachine` is the machine on screen (and `machine` is gone: it did not say which of the two it meant); `personMachine` is the one the person works on, the same machine unless a full-screen chat is open |
| `addRoms(files)`, `machineRoms()`, `runWithoutRoms()` | your ROMs, identified per model |
| `load(name, bytes, { remember: false })`, `insertTape`, `await importDisk(name, bytes, drive)`, `startLiza`, `startWelcome`, `runAssembled(assemble(src, cpu))` | media and programs |
| `buildCas(files, { family })`, `casToWav(cas, { family, gaps, wave, sampleRate, amplitude })`, `casToSamples(cas, opts)`, `tapeGaps(cas, { pad })`, `wavToCas(wav)` | a program as a `.CAS` tape and as the signal a player plays (see "A tape for a real Dragon or CoCo") |
| `toBinary(result, { format })`, `writeDragonDos(segments, exec, { type, maxGap })`, `writeDecb(segments, exec)`, `parseSymbols(text)`, `formatSymbols(symbols)`, `setLabels(map)` | a program as a file (`format`: `'dragondos'` or `'decb'`, required) and its symbols |
| `runFrames(n)` | emulated frames, no clock; `advance(ms)` is the page's real-time pacing |
| `typeText(text)`, `untypable(text)` | typing; for BREAK, CLEAR and the arrows, `machine.typist.press(key)` with ROMs (the keyboard matrix), and `machine.stubKeys.push(code)` on the built-in firmware (its POLCAT codes: BREAK 3, CLEAR 12, LEFT 8, RIGHT 9, DOWN 10, UP 94) |
| `screenTextTool(session.chatTarget())`, `screenText()` | the screen as text (the first is the full reader and takes a tool target, never a Session; the second the raw 32x16 VDG page) |
| `readByte(addr)`, `pokeBytes(addr, bytes)` | memory |
| `machine.render()`, `frameToRGBA(frame)`, `framePng(frame, scale)` | pictures; `framePng` is imported from `cli/cloadm.js` (it uses Node's zlib), the rest from `js/emu.js` |
| `Frame`: `width`, `height`, `aspect`, `active`, `data`, `table` | the picture `machine.render()` returns: `data` is one byte (a colour code) a pixel, `width * height` of them; `table` is the 256-entry RGBA of each code (`0xAABBGGRR`); `active` is `{ x, y, width, height }` of the picture inside the border, or `null` when it moves with the mode (the CoCo 3's) |
| `machine.setKey(name, down)`, the key names `Object.keys(machine.keyPos)` | the keyboard matrix, as a finger holds a key; an unknown name does nothing. The `[row, column]` values of `keyPos` are internal |
| `machine.frameCount`, `machine.now()`, `machine.tickHz`, `machine.cpu.totalCycles` | emulated time: frames run, the machine's clock (see "What 'cycles' counts" above: the GIME's on the CoCo 3), that clock's rate in Hz, and CPU cycles |
| `await snapshotFile()`, `await readSnapshot(bytes)`, `openSnapshot(snap)` | snapshots |
| `serial` (`device`, `attach`, `send`, `subscribe`, `flush`, `trace`, `status`), `diagnostics()` | the serial port: its device, the bytes both ways and when they are delivered, the trace's event kinds and fields, and where the machine is ([the serial port from Node](#the-serial-port-from-node)) |
| `disk` (`trace`, `status`), `diagnostics().disk` | the disk controller: the trace's event kinds and fields and the status decoded ([Tracing the disk controller](#tracing-the-disk-controller)) |
| `debug` (`addBreakpoint`, `step`, `registers`, …) | the debugger, as the page's Debugger screen uses it |
| `watchWrites({ start, end }, fn)` | the memory-write observer ([Applying input on a guest write](#applying-input-on-a-guest-write)) |
| `profile({ mode, every, symbols, buckets })` → `report({ top })`, `stop()`, `profileText(report)` | hot spots ([Finding hot spots](#finding-hot-spots)); the report's fields |

Not promoted, although they are reachable: `machine.serialPort`, `pcWatch`, `stubKeys` and the typist's internals (`machine.typist`
beyond `press`, which the typing row names).

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
