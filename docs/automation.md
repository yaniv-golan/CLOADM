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
| `--option KEY=VALUE` (`-o`) | a machine option, checked against the model: `ram=16`, `cpu=6309`, `becker=true`, … |
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
can be mixed with other steps on the command line.

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
