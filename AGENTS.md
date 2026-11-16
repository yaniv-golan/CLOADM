# Contributor guide

CLOADM is a browser emulator of the Dragon 32/64/200, Tandy Color Computer 1/2/3, MC-10 and clones. This guide
applies to everyone who changes it, human or coding agent. Read `README.md`, `docs/architecture.md` and
`docs/verification.md` before you start. This file says how to work and, above all, **what you must show before you call anything
done**.

## 1. Hard rules

1. **No copyrighted ROMs, ever.** Don't download, fetch, commit, generate from memory, or ask for BASIC, DOS, disk
   controller, character generator or speech ROMs, and don't use any you find. Users supply their own dumps at run
   time. All verification runs on firmware written for this project (assembly sources in `tools/mame-diff/`), which
   is installed in MAME under the ROM file names MAME expects. A test that only passes with a real ROM is not a test
   here.
2. **No build step and no runtime dependencies.** `js/` is plain ES modules loaded by the browser as they are.
   Playwright and MAME are development tools only.
3. **Don't weaken a check to make it pass.** Never edit `tests/regress-hashes.json`, loosen a tolerance, skip a
   comparison or add a known-difference exception unless section 4.6 allows it. Never write vacuous tests
   (`|| true`, constant conditions, asserting that code returns what it returned).
4. **No legacy.** When you change an interface, update every caller; don't leave compatibility wrappers, aliases or
   dead code behind.
5. **Behaviour that MAME already verifies must not change by accident.** Run `node tests/regress.test.js` after every
   meaningful change, not only at the end.
6. Keep the browser-free core browser-free: nothing under `js/` except `js/host/`, `js/ui/` and `js/video/canvas.js`
   may touch `window`, `document` or other DOM APIs. `js/emu.js` must still load in Node.

## 2. Where things go

| What | Where | Contract |
|---|---|---|
| A chip (FDC, ACIA, 6845, sound chip, 6309 core) | `js/chips/`, `js/cpu/` | Knows nothing about machines; talks through callbacks or a bus; `saveState()` / `loadState()` |
| A cartridge or expansion device | `js/machines/bus.js` style `Device` subclass, registered in `devices` | `attach(host)`, `reset()`, `rom()`, `readIO()`, `writeIO()`, interrupts only through `host.setLine(source, line, level)`, timing only through `host.schedule()` / `host.cancel()`, `saveState()` and a static `fromState()` |
| Timing | The machine's scheduler (`schedule(at, name, arg, pri)`, handlers via `on(name, fn)`) | Events are plain data so snapshots can hold them. An I/O access whose result depends on time calls `processEvents(this.ioTime())` first. No `setTimeout`, no wall-clock time in emulation |
| A model or option | `js/machines/profiles.js` | Data only; options are validated through `profile.options` |
| Media formats | `js/media/` | Pure functions from bytes to bytes or structures, round-trippable |
| Front-end logic without a DOM | `js/session.js` | Testable in Node |
| Page UI | `js/ui/<panel>.js`, one module per panel | Thin; calls the Session |
| Browser services (storage, Web Serial, gamepads, audio) | `js/host/` | Behind a small interface the core can be tested without |

Every new stateful component goes into the snapshot (`saveState` / `loadState`) and into `tests/state.test.js`.

## 3. How to work

1. One feature or fix, or a clearly separable part of one, per branch. For anything large, open an issue first so
   the approach can be agreed.
2. Before writing code, write down how you will prove it is correct (section 5 gives the oracle per area). If no
   oracle is listed for something you're adding, find one before building it.
3. Write the verification firmware or test first, run it against MAME to get the expected behaviour, then implement.
4. Commit in small, working steps. Every commit passes `node tests/all.js`.
5. Update the documentation the change affects (`README.md` and `docs/using.md` feature tables,
   `docs/verification.md`, the commands in `docs/development.md`) and `CHANGELOG.md` in the same branch.

## 4. Definition of done: the proof ladder

A change is done only when every applicable level below passes. Your report (section 6) shows the evidence.

### 4.1 All suites pass
```
node tests/all.js
```
This runs every `tests/*.test.js`, including the regression gate. Exit code 0 is required.

### 4.2 Existing behaviour is unchanged
`node tests/regress.test.js` hashes the full instruction traces (registers and cycle counts) and every rendered
frame of the diagnostic firmware that MAME verified. If a hash changes, either you broke something (fix it), or
the change is intended. In that case the MAME comparisons for every affected profile must pass (4.4), then you
record the new values with `--update` and explain why in the commit message.

### 4.3 New tests for the new code
* Unit tests with real assertions for the new chip, device, format, Session method or UI behaviour. Include error
  cases: bad images, wrong sizes, write-protected media, missing ROMs, and options a model doesn't have.
* Format code: round-trip tests (parse, then write, then compare bytes) and tests on hand-built images whose
  expected contents are derived independently, not by running the code under test.
* Register new test files under `tests/` with the `.test.js` suffix so that `tests/all.js` picks them up.

### 4.4 Lockstep comparison with MAME (any hardware behaviour)
MAME 0.264 is the reference (`/usr/games/mame`; elsewhere `apt install mame`). For every chip, device, model or
CPU you add:

1. Write diagnostic firmware in assembly that exercises the feature thoroughly. Cover every register and
   command, status bits, interrupts and their timing, edge cases and error paths. The firmware must end in its
   HALT loop. Put it in `tools/mame-diff/<family>/` (or a new folder with the same structure: `spec.js`,
   `gen-diag.js` if generated, `*.asm`).
2. Install it in MAME in place of the relevant ROM. That's BASIC for machine features, or the cartridge ROM for a
   cartridge or controller. Select the device with MAME's slot options (for example
   `-ext dragon_fdc`, `-ext multi`, `-ext orch90`). `mame -listslots <system>` lists them.
3. Run `node tools/mame-diff/run.js <profile>` (extend `run.js` and the specs as needed). Required result: **every
   instruction identical in all registers and cycle counts, and the firmware reaches HALT**.
4. For anything visible, add the video comparison (`--video`, `run-vdg.js` pattern): every pixel of every mode and
   every mid-frame change you introduce.
5. For data that leaves the machine (disk images written, printer output, serial bytes, saved tapes), compare the
   bytes MAME produces with the bytes we produce from the same firmware.
6. For sound chips, have MAME record audio with `-wavwrite` and compare the samples with ours. State the tolerance
   and the reason for it.
7. Add the new firmware run to `tests/regress.test.js` so the fast gate covers it from then on.

Headless MAME quirks are already handled in `tools/mame-diff/lib/`. Use them rather than reinventing them:
* trace through a named pipe;
* use `totalcycles` (never `%d` in the trace format);
* deduplicate CWAI/SYNC re-logs;
* `-video none` delivers the previous frame's bitmap.

Traces are large: delete them afterwards and kill stuck `mame` processes. They can fill a disk quickly.

### 4.5 Snapshots
New state must survive `saveState` → JSON (`state.toJSON` / `fromJSON`) → `loadState`. Extend
`tests/state.test.js`: save in the middle of the new activity (a disk transfer, a sound playing, a serial byte in
flight), restore into a fresh machine, and show the instruction trace and frames continue identically to the
uninterrupted run.

### 4.6 When MAME is not the right oracle
* **No MAME support for the feature:** use the chip datasheet or the published hardware documentation. Cite the
  exact source (document, page, table) in the code and the test, and test against values taken from it.
* **You believe MAME is wrong:** you need a primary source (datasheet, schematic, measurements of real hardware)
  saying so. Implement the hardware behaviour. If the comparison must still run, reproduce MAME's behaviour behind
  `config.mameCompat` (see the CoCo 3 clock-change slice model in `js/machines/coco3.js`). Document the deviation
  in `docs/verification.md` under "Deviations from MAME".
* **Nothing can be verified automatically** (Web Serial to real hardware, GPU shader looks, touch feel): say so
  in the report. Give the manual test steps you used and the result.

### 4.7 The real page works
```
node tools/browser-check.js [--screenshots DIR]
```
This serves the repository and loads every model in Chromium, requiring no page errors and a running screen. It
also runs LIZA end to end through the keyboard and checks the local-file notice. Extend it for every new UI feature
(a panel opens, a disk mounts, a download is produced) so the feature is exercised through the page, not just
through the Session. Look at the screenshots of anything visual.

## 5. Oracle per area

| Area | How to prove it |
|---|---|
| Scanline video | Firmware that changes VDG/SAM/GIME modes, palette, CSS and the MC-10 latch at chosen lines; `--video` comparison per frame against MAME on SAM, MC-10 and CoCo 3 profiles; existing hashes unchanged except where a mid-frame effect is now visible (justify each one) |
| Media backend | Interface tests in Node with an in-memory implementation; Playwright tests with real OPFS in Chromium, including reload persistence and the import/download fallback; File System Access paths may be tested with a mocked handle, and that must be stated |
| Floppy disks | WD2797 lockstep against MAME (`-ext dragon_fdc` for Dragon, `coco_fdc` for CoCo) with our own firmware as the DOS ROM: seek, step, read/write sector and track, read address, force interrupt, status and DRQ/INTRQ timing, NMI/HALT behaviour. Disk images written by MAME and by us from the same firmware must be byte-identical. VDK/DSK/JVC/DMK round-trips; write-protect; 4 drives |
| Cartridges | Multi-Pak slot switching and interrupt routing in lockstep (`-ext multi`); banked ROM cartridges (`cocopak_banked`); Orchestra-90 (`orch90`), Games Master (`gmc`), Speech/Sound Pak (`ssc`): register behaviour in lockstep, audio against `-wavwrite` with a stated tolerance. Chip ROMs (SP0256) are user-supplied, so test with a ROM image built by our own firmware where possible, and state what can't be covered |
| Cassette | Our firmware writes bits through the cassette port as BASIC's writer would; the .CAS we capture must decode to exactly the bytes written. WAV loading: decode WAVs we synthesise with noise, speed drift, inverted phase and DC offset, and decode our own WAV export back to identical bytes. MAME: load our exported files into MAME and read them with our firmware |
| Printer, serial, DriveWire | Printer: firmware output compared byte for byte with MAME's printer output. 6551 ACIA and bit-banger: lockstep, plus bytes compared with MAME's serial loopback or null modem. DriveWire: protocol tests against the DriveWire 4 specification on the Becker port (MAME `coco_dwsock`); WebSocket channels against a local test server. Web Serial to real hardware: manual steps and results in the report |
| More models | MAME drivers: `dragon200e`, `cp400`, `d64plus`, `dgnalpha`, plus RAM options (`--ram`). Lockstep and `--video` for each, including the 200-E character set and the 6845 80-column display |
| 6309 | Per-instruction tests for every 6309 opcode and mode (as in `tests/cpu.test.js`, values from the HD6309 documentation); assembler round-trip for all opcodes; lockstep against MAME `cocoh`, `coco3h`, `dragon64h` and `tanodr64h` with firmware that runs native mode, the new registers, traps and timing |
| Snapshots | State tests for every machine and device; file save/load through the page (browser check); quick slots survive reload; snapshots from a different machine, config or ROM are rejected with a clear message; a version field is present |
| Debugger | Disassembler round-trip: assemble every opcode and mode, disassemble, reassemble and compare bytes (6809, 6309, 6803). Breakpoints and watchpoints stop at exactly the right instruction or access (compare against the trace); single-step equals one traced instruction; stepping doesn't change the trace compared with free running. Panel exercised in the browser check |
| Display | NTSC artifact colours and phase switch compared with MAME `--video` on the artifact modes. Signal-model unit tests on known patterns. The shader has no automatic oracle: screenshots at fixed settings plus a stated manual review |
| Input | Mapping tests (translated and positional keyboard, keyboard joystick); gamepads through a mocked `navigator.getGamepads` in Playwright; Hi-Res joystick and mouse interface timing in lockstep with firmware that reads them (MAME `-ext max` and CoCo 3 settings); touch through Playwright touch events |
| Config, embedding, PWA | Every URL parameter covered by browser-check cases; the embed API tested through the Session in Node and through an embedding test page in Playwright; the PWA tested offline in Playwright (service worker installed, context offline, page reloads and runs); settings export/import round-trip with ROMs excluded |
| Claude chat terminal | No MAME oracle (section 4.6): the DriveWire channel follows the DriveWire 4 specification and reuses the DriveWire tests. Chat firmware runs in Node against a mocked backend: typed lines reach the backend byte for byte, and streamed replies (including lowercase, long words and lines longer than the screen) appear on screen exactly as specified, checked through the frames. Backend tests use a mocked `fetch`: request shape, streaming, HTTP and network errors, invalid key. Tests show the key never reaches machine memory, snapshots or settings exports. The browser check covers `?app=claude`, the key panel and a chat against a mocked API. A chat with the real API is a manual test, and its steps and result go in the report |

## 6. Report (in the pull request description)

Give these, and no claims beyond them:

1. **What changed:** files and a one-paragraph design summary.
2. **Commands run and their results**, pasted as short excerpts:
   * `node tests/all.js` (the summary line);
   * `node tests/regress.test.js`;
   * each `node tools/mame-diff/run.js <profile> [...]` (instruction counts, "identical", HALT reached);
   * any `--video` or byte/audio comparisons (frames or bytes compared, tolerance);
   * `node tools/browser-check.js`.
3. **New tests and firmware:** what each one covers.
4. **Deviations from MAME:** each with its source and where it is documented. Write "none" if there are none.
5. **Not verified:** everything you couldn't check automatically, with the manual steps you did instead. Write
   "none" only if that is true.

If any level fails and you can't fix it, the change is not done. Report it as blocked, with the failing output,
rather than as done.
