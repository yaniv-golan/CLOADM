# Contributor guide

CLOADM is a browser emulator of the Dragon 32/64/200, Tandy Color Computer 1/2/3, MC-10 and clones. This guide
applies to everyone who changes it, human or coding agent. Read `README.md`, `docs/architecture.md` and
`docs/verification.md` before you start. This file says how to work and, above all, **what you must show before you call anything
done**.

## Start here

The short version, for a first session. Everything below it is the full guide, and it still applies.

**The commands you'll use** (no `package.json` on purpose: there is nothing to install and no `npm test`):

```
node tests/all.js                                   # the full suite gate (~5-6 min; `git fetch --tags` first); exit 0 = all passed
node tests/all.js --only cli,game-guide             # a quick subset while you work (marked SUBSET RUN: not the gate)
node tests/regress.test.js                          # the regression hashes alone (MAME-verified traces and frames)
node tools/browser-check.js --only pwa,models       # the browser-check groups your change touches: the local browser gate (4.7)
node tools/browser-check.js                         # the whole page check (15-20 min, alone on the machine); CI and a daily run do it
node tools/build-examples.js                        # rebuild examples/*.bin from source; also updates sw.js's file list
node tools/pwa-files.js --write                     # update sw.js's offline file list after adding/removing a served file
node cli/cloadm.js --asm prog.asm --frames 50 --screen   # assemble, run headless, print the screen (docs/automation.md)
node cli/cloadm.js --script test.cloadm             # a scripted end-to-end test (keys, screen, pictures, sound)
node tools/mame-diff/run.js <profile> [--video]     # lockstep / pixel comparison with MAME 0.264 (needs mame)
```

Which suites and groups to run for what you changed: [docs/development.md, "The fast loop"](docs/development.md#the-fast-loop).
Which proof levels apply to your kind of change: [section 4, "Which levels apply"](#which-levels-apply).

**The rules most often broken:**

1. **No ROMs.** Never fetch, commit, recreate or use BASIC, DOS, cartridge, character or speech ROMs (rule 1.1).
2. **Never edit `tests/regress-hashes.json` by hand.** A hash changes only through `node tests/regress.test.js
   --update`, after the MAME comparisons for every affected profile pass, with the reason in the commit message (4.2).
3. **CHANGELOG entries go under `## [Unreleased]` only.** A released section is history: never add to or reword it
   (`tests/changelog.test.js` compares each one with its git tag).
4. **Commit as yourself, with your GitHub noreply address** (`git config user.email
   "<id>+<login>@users.noreply.github.com"`), never as "Claude" or another tool's identity.
5. **No force-push and no rebase of a branch you have pushed.** To catch up, merge the base branch in.
6. **CI attempt 1 must be green, and is never re-run.** Attempt 1 is the full browser gate. A red run is fixed with a
   new commit, not re-run until it passes (section 6).

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
| An MCP tool | `js/mcp/tools.js` (transport-neutral), served by `cli/cloadm.js --mcp` (`cli/mcp.js`) | Documented in `docs/mcp.md`; tested in `tests/mcp.test.js` |
| The agent skill | `skills/cloadm/`, copied byte for byte to `.agents/skills/cloadm/` | Names every tool by what it does; `tests/skill.test.js`; evals in `tests/skill-evals/` |
| Plugin and extension manifests | `.claude-plugin/`, `mcpb/manifest.json` | One version, from CHANGELOG.md's "Next version" line; `tests/plugin.test.js` |

Every new stateful component goes into the snapshot (`saveState` / `loadState`) and into the state tests
(`tests/state.test.js`, or `tests/state-fdc.test.js`, `tests/state-carts.test.js` or `tests/state-tape.test.js` for a
floppy controller, a cartridge or the cassette).

## 3. How to work

1. One feature or fix, or a clearly separable part of one, per branch. For anything large, open an issue first so
   the approach can be agreed.
   The scope comes from the brief or issue you are given (the task description), the oracle from section 5.
2. Before writing code, write down how you will prove it is correct (section 5 gives the oracle per area). If no
   oracle is listed for something you're adding, find one before building it.
3. Write the verification firmware or test first, run it against MAME to get the expected behaviour, then implement.
4. Commit in small, working steps. Every commit passes `node tests/all.js`.
5. Update the documentation the change affects (`README.md` and `docs/using.md` feature tables,
   `docs/verification.md`, the commands in `docs/development.md`) and `CHANGELOG.md` in the same branch.
6. A change to an MCP tool's name, arguments or behaviour updates `docs/mcp.md`, the skill (both copies) and its
   evals in the same branch. The plugin and extension version comes only from CHANGELOG.md's "Next version" line.
   Never add a top-level `bin/` directory: Cowork and claude.ai refuse a plugin that has one, and the repository root
   is the plugin.
7. To poke a running machine while you develop, the MCP server (`node cli/cloadm.js --mcp`, or the plugin) is a quick
   way in. It is not a substitute for the proof ladder below.

### Adding an example program or game

A program under `examples/` (a demo, a game, a tool that runs on the built-in firmware):

1. The source, `examples/<name>.asm` or `examples/<name>/<name>.asm`; your own code, no ROM code.
2. An entry in the list in `tools/build-examples.js`, then `node tools/build-examples.js`. It writes the `.bin` and
   brings `sw.js`'s offline file list up to date; commit both. (A served file added any other way needs `node
   tools/pwa-files.js --write`, or `tests/pwa.test.js` fails.) The one exception to the list is `examples/demo.bin`,
   which `tools/build-demo.js` builds from its hand-encoded source: it predates the list and stays out of it.
3. A test, `tests/<name>.test.js`, with real assertions: a play script (`.cloadm`) run through `cli/cloadm.js` on
   each machine it supports (`--expect-screen`, `--expect-mem`, `--expect-screenshot`, `--wav`), and mutants of the
   program that must fail it ([docs/game-development.md](docs/game-development.md) and
   `tests/starter-game.test.js` show how).
4. Documentation: a mention in the `build-examples.js` line of `docs/development.md` (every `tests/*.test.js` runs on its own, and `node tests/all.js --only <name>` takes the names, so a new test needs no list entry); the
   feature tables in `README.md` and `docs/using.md` if users see it; `CHANGELOG.md` under `[Unreleased]`.
5. Proof: 4.1, 4.2 (hashes unchanged: an example changes no emulation), 4.3, and 4.7 with `--only pwa` plus any
   group that offers it on the page; 4.4 and 4.5 are "not applicable" in the report (see "Which levels apply").

## 4. Definition of done: the proof ladder

A change is done only when every applicable level below passes. Your report (section 6) shows the evidence.

**The gate is a green CI run on the exact commit.** Every push to `main` and to contributor branches (`claude/**`,
`ds/**`) runs the `tests` workflow (`.github/workflows/tests.yml`) once on the pushed head; for a branch with another
name, run it by hand (Actions → tests → Run workflow). A pull request into `main` also runs it, on the merge result
GitHub builds for the PR (`refs/pull/N/merge`): that run's SHA is a merge commit, so it is the proof that merging the
branch keeps `main` green, not the proof for the branch -- report the run on the pushed head. It runs
`node tests/all.js` (in parallel parts, `--shard i/n`, which `gates` checks cover every suite once) and every group of
the browser check, split over parallel shards that together must cover every group. Its final job, `gates`, is
green only if all of them passed, and its summary gives the commit SHA and tree hash (`git rev-parse HEAD^{tree}`).
That run, on the SHA you report, is the proof for levels 4.1, 4.2 and 4.7. Run the same commands locally while you
develop (sections 1 and 3 still apply); CI doesn't replace them, it records the final result once. CI has no MAME,
so levels 4.4 to 4.6 are still run locally and reported.

### Which levels apply

Every change runs 4.1, 4.2 and 4.3. The others depend on what you changed; when one does not apply, say so in the
report with the reason ("4.4: not applicable, no hardware behaviour changed"), never by leaving it out.

| Change | 4.4 MAME lockstep | 4.5 snapshots | 4.6 other oracle | 4.7 browser check |
|---|---|---|---|---|
| A chip, CPU, device, cartridge or model (hardware behaviour) | yes, every affected profile | yes, for new state | only where MAME can't be the oracle | yes if the page exposes it |
| Video or sound output | yes, with `--video` / `-wavwrite` | if new state | for things MAME lacks | yes (look at the screenshots) |
| A media format (disk, tape, cartridge file) | bytes the machine writes, against MAME | if mounted state changes | the format's spec | yes if the page mounts it |
| An example program or game on the built-in firmware (no ROMs) | no: it adds no hardware behaviour | no, unless it adds machine state | its own end-to-end test is the oracle | `--only pwa` (it is served offline), plus the group that offers it on the page, if any |
| A UI panel or page behaviour (`js/ui/`, `play/`, `css/`) | no | if it saves settings or state | no | yes: extend a group and run the whole check |
| The CLI, Node API or Session (no hardware change) | no | if it touches snapshots | no | only if the page uses it |
| Tests, tools or CI (`tests/`, `tools/`, `.github/`) | no | no | no | if `tools/browser-check*.js` changed |
| Documentation only | no | no | no | no (4.1 still runs `readme.test.js` and the guide tests) |

### Without MAME

If MAME isn't installed where you work (CI has none either), don't skip 4.4 silently and don't claim it. Run every
other level, then list each MAME comparison the change needs under "Not verified" in the report, as the exact
commands a maintainer should run, for example:

```
node tools/mame-diff/run.js dragon64              # lockstep, every instruction and cycle, to HALT
node tools/mame-diff/run.js coco3 --video         # every pixel of every mode
node tools/mame-diff/tape/run-tape.js dragon64    # the tape round trip through MAME
```

with what each one should show ("identical", HALT reached, frames compared). A change that needs 4.4 is not done
until a maintainer has run them: say so, rather than reporting it as done.

### 4.1 All suites pass
```
node tests/all.js
```
This runs every `tests/*.test.js`, including the regression gate. Exit code 0 is required. A separate
`node tests/regress.test.js` run isn't required on a tree `all.js` has run on; it stays the command for a quick
check while developing and for `--update`.

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
New state must survive `saveState` → JSON (`state.toJSON` / `fromJSON`) → `loadState`. Extend the state test that
holds its area (`tests/state.test.js`, or `state-fdc`, `state-carts` or `state-tape`; a new check's name also goes into
that suite's list in `tests/state-check-names.json`): save in the middle of the new activity (a disk transfer, a sound playing, a serial byte in
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
node tools/browser-check.js --only <group,…> [--screenshots DIR]   # the groups your change touches
```
The browser check serves the repository and loads every model in Chromium, requiring no page errors and a running
screen. It also runs LIZA end to end through the keyboard and checks the local-file notice. Extend it for every new UI
feature (a panel opens, a disk mounts, a download is produced) so the feature is exercised through the page, not just
through the Session. `--list-groups` lists the groups; [docs/development.md, "The fast
loop"](docs/development.md#the-fast-loop) says which ones a change touches.

**Where each part runs.**
* **Locally (before you push):** `git fetch --tags`, then `node tests/all.js`, plus the browser-check groups the change
  touches (`--only …`). That is the local gate; the whole check is not required locally.
* **A change that touches NitrOS-9, disks or CoCo 3 boot** also runs `node tools/nitros9/fetch.js` and then `--only
  nitros9` locally, with the images present (CI has no images, so the group only SKIPs there), and the report says so.
* **CI attempt 1** runs every group, split over parallel shards: that is the full browser gate. It is never re-run; a
  red shard is fixed with a new commit.
* **Once a day** (`.github/workflows/browser-daily.yml`, not a gate) the whole check runs in ONE process on
  `claude/v0.2-stage` and on `main`, and its summary lists every FAIL line. It catches what shards cannot: a group
  that fails only after another has run in the same browser. A failure there is fixed, never quarantined or skipped.

**Screenshots.** Authors look at the local screenshots (`--screenshots DIR`) of the groups they touched. Reviewers open
the CI run's `browser-check-screenshots-<shard>` artifacts.

The browser check is timing-sensitive under load: while it runs, nothing else runs on the same machine or
container (no test suites, builds, MAME or a second browser check).

**The CI shards are generated, never edited.** `.github/browser-check-shards.json` is the plan
`node .github/scripts/browser-check-shards.js --write` makes from the measured group times in
`.github/browser-check-timings.json`, and the `shards` job fails if the file is not that plan or a group is in no
shard, in two, or untimed. A new group is timed with `node tools/browser-check.js --only <group> --timings t.json`,
then `node .github/scripts/browser-check-shards.js --merge t.json` (which also writes the shards). To rebalance from
CI's own times, `--merge` the `browser-check-timings` artifact of a green run (a smoothed average: one noisy run moves
a group's time by only the file's `"smoothing"` weight).

## 5. Oracle per area

| Area | How to prove it |
|---|---|
| Scanline video | Firmware that changes VDG/SAM/GIME modes, palette, CSS and the MC-10 latch at chosen lines; `--video` comparison per frame against MAME on SAM, MC-10 and CoCo 3 profiles; existing hashes unchanged except where a mid-frame effect is now visible (justify each one) |
| Media backend | Interface tests in Node with an in-memory implementation; Playwright tests with real OPFS in Chromium, including reload persistence and the import/download fallback; File System Access paths may be tested with a mocked handle, and that must be stated |
| Floppy disks | WD2797 lockstep against MAME (`-ext dragon_fdc` for Dragon, `coco_fdc` for CoCo) with our own firmware as the disk ROM: seek, step, read/write sector and track, read address, force interrupt, status and DRQ/INTRQ timing, NMI/HALT behaviour. Disk images written by MAME and by us from the same firmware must be byte-identical. VDK/DSK/JVC/DMK round-trips; write-protect; 4 drives |
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
2. **Gate and commands run, with their results:**
   * the green CI run: its URL, the commit SHA and the tree hash from its `gates` summary, which must be the head
     of the branch under review (this replaces pasting local `tests/all.js`, `regress` and browser-check runs).
     The attempt (shown in the `gates` summary) must be 1: a re-run is not the gate. A red attempt 1 is fixed with a
     new commit, and the report names what failed and what fixed it;
   * whether `--only nitros9` ran locally with the images, for a change that touches NitrOS-9, disks or CoCo 3 boot;
   * each `node tools/mame-diff/run.js <profile> [...]` (instruction counts, "identical", HALT reached), pasted as a
     short excerpt;
   * any `--video` or byte/audio comparisons (frames or bytes compared, tolerance).
3. **New tests and firmware:** what each one covers, and the mutations (deliberate breakages) that turned them red.
4. **Deviations from MAME:** each with its source and where it is documented. Write "none" if there are none.
5. **Not verified:** everything you couldn't check automatically, with the manual steps you did instead. Write
   "none" only if that is true.

If any level fails and you can't fix it, the change is not done. Report it as blocked, with the failing output,
rather than as done.

## 7. Review

1. Check that the reported CI run is green, attempt 1, and that its SHA and tree hash are the branch head you are
   reviewing. Open its screenshot artifacts for anything visual.
2. Read the diff. Replay the author's mutations (the deliberate breakages that showed their tests fail) and at
   least two of your own; each must turn a test red. Replay them with `--only`: `node tests/all.js --only <suite>` and
   `node tools/browser-check.js --only <group>` for the groups the mutant touches.
3. Re-run the gates locally only if the branch changes `tests/`, `tools/` or `.github/` in a way that isn't purely
   additive (a changed or removed check, tolerance or shard list). Any change to `.github/` counts as not purely
   additive, because the run being verified is the branch's own workflow. Otherwise the green run stands.
4. A small fix within the change's scope may be re-reviewed by the same reviewer as a delta on the previous review.
   Give all findings in one verdict.
5. **Integrating** (squashing reviewed branches onto the integration branch): no local run is needed when the
   squashed commit's tree (`git rev-parse HEAD^{tree}`) equals the tree in the branch's green `gates` summary.
   Otherwise run `node tests/all.js` plus the browser-check groups the merged changes touch. Batch 3-4 squashes per
   push, so each CI run gates several of them at once.
