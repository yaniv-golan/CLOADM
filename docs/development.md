# Development

[CLOADM](../README.md) › Development

## Running it locally

Run it locally with any static server: `python3 -m http.server`, then open `http://localhost:8000/play/`
(`http://localhost:8000/` is the landing page). Opening the files straight from disk shows how instead: browsers
don't load ES modules from `file://`.

## The command line and the Node API

`node cli/cloadm.js` runs any model headless from a script or CI: load a program, type, wait for text on the screen,
a byte or the PC, read the screen, memory and registers, step and disassemble, save PNGs and snapshots, with `--json`
output, exit codes and error codes; `--describe` gives the whole interface as JSON. `node cli/cloadm.js --mcp` is the
MCP server for coding agents ([mcp.md](mcp.md)): the tools in `js/mcp/tools.js`, transport-neutral, mounted on stdio
by `cli/mcp.js`.
[automation.md](automation.md) is the guide, with the Node API under it and what of it is stable.

## The fast loop

The full gates are slow (`node tests/all.js` about 5-6 minutes, the browser check 15-20), so while you work run the
suites and groups for what you changed: `node tests/all.js --only <part of a name>[,...]` runs the suites whose file
names contain one of the parts, and `node tools/browser-check.js --only <group>[,...]` the browser-check groups
(`--list-groups` lists them).

| You changed | Suites (`tests/all.js --only ...`) | Browser-check groups (`--only ...`) |
|---|---|---|
| `js/cpu/` (6809, 6309, 6803) | `cpu,opcodes,disasm,asm,nmi-arm,regress` | `models,cpu6309` |
| Video: `js/chips/` VDG, SAM, GIME, 6845, `js/video/` | `video,mc6847,mc6845,coco3,composite,sammem,samrate,regress,state` | `models,display,glLoss` |
| Machines and profiles (`js/machines/`) | `machine,models,bus,coco3,mc10,alpha,d64plus,state,snapshot,regress` | `models,powerOn` |
| Floppy disks, `js/media/` | `fdc,disk,detect,state` (`disk` also selects the `disks*` suites) | `disk,media` |
| Cassette | `tape` | `tape,tapePanel` |
| Cartridges and sound chips | `bus,carts,ssc,sp0256,ay8910,audio` | `cartridge,sscBoard,audio` |
| Serial, printer, DriveWire | `serial,acia,drivewire,web-serial` | `driveWire,webSerial,printer` |
| The assembler (`js/asm/`) | `asm,includes,disasm` | `debugger` |
| Debugger | `debugger,debug-session,halt` | `debugger,debuggerScreen` |
| Keyboard and input | `input,keyqueue,keyboard-symbols,touch-joystick,press-break` | `input,inputScreen,touchJoystick,keyboardSymbols,typing` |
| `js/session.js`, snapshots | `session,snapshot,state,restore-points` | `snapshot,state` |
| The Claude chat and Ask Claude | `claude,chat-firmware` | `claude,ask,commands,chatScreen` |
| `cli/` (the command line and the MCP server) | `cli,mcp,game-guide,starter-game` | none |
| `examples/` (a program or game) | `pwa,starter-game,game-guide,welcome` and the example's own suite | `pwa` (and the group that offers it) |
| `js/ui/`, `play/`, `css/`, `index.html` | `session,readme,screen-alternative` | the panel's groups and `semantics`, then the whole check |
| Docs (`README.md`, `docs/`) | `readme,romdocs,game-guide` | none |
| `CHANGELOG.md` | `changelog` | none |
| The test runner (`tests/all.js`, `suite-verdict.js`, `no-exit.js`) | `allsummary,allsignal,exitguard,exitcode` | none |
| `tools/browser-check*.js`, `.github/` | `browser-check` | the groups it touches |

A subset run says `SUBSET RUN (--only ...), not the full gate` on its summary line: it is never the proof. The full
gates are still required:

* **before every push:** `node tests/all.js` in full (the regression hashes included);
* **before pushing anything the page runs** (`js/`, `play/`, `css/`, `index.html`, `sw.js`, `tools/browser-check*.js`):
  the whole browser check, in one process, with nothing else running on the machine;
* **before you call the change done:** a green CI run, attempt 1, on the exact commit you report (AGENTS.md section 4).

When a full run fails, its last line names the failing suites (`FAILED: a.test.js, b.test.js`); rerun just those with
`--only` while you fix them, then the full gate again.

## Tests and tools

Contributors follow [AGENTS.md](../AGENTS.md): the rules, where code goes, and the proof required before a change
counts as done.

CI (`.github/workflows/tests.yml`) runs the gates once per push, on the pushed head of `main` and of `claude/**` and
`ds/**` branches (other branches: Actions → tests → Run workflow): `node tests/all.js`, and the browser check split into parallel shards (`--only <groups>`, listed in
`.github/browser-check-shards.json`). `node .github/scripts/browser-check-shards.js` fails if a browser-check group
is in no shard, in two, or isn't a group (it reads the groups from `node tools/browser-check.js --list-groups`, the
`GROUPS` table itself); run it after adding a group, and add the group to a shard. A green run's
`gates` summary (commit SHA, tree hash, each job's counts) is the definition of done; see AGENTS.md section 4.
Don't run anything else on the machine while the browser check runs: it is timing-sensitive under load.

```
node tests/all.js            # every suite below in a worker pool (--jobs N to cap it), one line each, the regression gate included (exit 0 = all passed, and every suite must also have printed its summary line: one that exits 0 half done is a failure); a failing run ends with FAILED: <the suites>; --only <part>[,...] runs a subset, marked as not the gate
node tools/browser-check.js  # the real pages in Chromium: the landing page (desktop and phone) and /play/: every model, LIZA end to end, the file:// notice, Capture & share and opening snapshots, the favicon and no missing file requested by any page; the feedback model (toasts on the page the user is on, cleared by the next action, Undo, Details, desktop and phone). Every "← Emulator", Esc and Back return to the emulator, from `/play/` and `?app=claude`, after a reload and from a page loaded on a view (`--only emulatorBack`). `--only feedback,library` runs just those groups (an unknown group is an error); see "What the gates' results mean" below
node tools/capture-images.js # recapture img/*.png (site and README pictures) from the emulator, with no ROMs
node tests/cpu.test.js       # 6809 instruction tests, scripted (all tests load js/emu.js via tests/load.js)
node tests/opcodes.test.js   # 126 instructions table-driven from the MC6809 data sheet: result, flags and cycles
node tests/machine.test.js   # headless machine test with the stub firmware and demo
node tests/asm.test.js       # assembler encodings + scripted LIZA conversation
node tests/disasm.test.js    # disassembler: every 6809/6803 opcode against the data sheet, round-trip, data lengths
node tests/debugger.test.js  # debugger core: breakpoints, watchpoints, stepping, trace, against a free run
node tests/debug-session.test.js  # the debugger through the Session: lifetime, symbols, errors, snapshots
node tests/halt-held.test.js # CoCo 3 instruction held by HALT: CPU redirected while held; debugger steps, stops, counts
node tests/halt-replay.test.js # CoCo 3 held instruction run again: exact reads (6309 TFM, all forms), malformed snapshot state
node tests/coco3-buslog.test.js # CoCo 3 bus log: carried only with a HALT-capable device (logBus), hot-plug, snapshots, the guards
node tests/held-writeio.test.js # a write from outside during a held access: queued, made between instructions, same machine either way
node tests/coco3.test.js     # CoCo 3: MMU, GIME interrupts, timer, speed, video
node tests/mc10.test.js      # MC-10: 6803 core, assembler plugin, machine
node tests/sp0256.test.js    # SP0256 speech chip: sequencer, paging, branches, handshake, RCU, timing (GI design spec)
node tests/liza6803.test.js  # LIZA for the 6803: same conversation as the 6809 build on mc10 and alice; BREAK, CLEAR, backspace
node tests/state.test.js     # snapshots: save mid-run and part-way along a swept line, restore, identical frames
node tests/snapshot.test.js  # snapshot files: format and version, defective files, every model opened elsewhere, ROMs by CRC, switching, slots
node tests/press-break.test.js # BREAK delivery: our own firmware scans the matrix on dragon64, coco3 and mc10
node tests/video.test.js     # scanline video: beam position, SAM display counter, mid-line mode splits
node tests/serial.test.js    # serial line receiver and port devices, PIA output callback, printer paths, the Session's terminal
node tests/acia.test.js      # the 6551 alone: registers, data sheet rates, frames in every format both ways, errors, interrupts, state
node tests/drivewire.test.js # the DriveWire server against the DW4 specification, the Becker port, the Session, a WebSocket channel
node tests/claude-chat-drivewire.test.js # the Claude chat end to end over DriveWire channel 14 on the Becker port (mocked fetch)
node tests/restore-points.test.js # Ask Claude's restore points: one path for every acting tool, exact restores on 6809/6803/CoCo 3, a failed restore keeps everything, a disk rolls back only for the same mount and only when written
node tests/claude-acting-contract.test.js # Claude's acting tools: every tool x every outcome as the model receives it (mocked fetch), schemas vs constants, the consent gate and restore point for every tool
node tests/claude-ask-acting.test.js     # the person's input pauses an acting call at its gate (a card, an INCLUDE read): nothing acts, no restore point; Resume, Stop and the turn's end
node tests/web-serial.test.js # DriveWire to a real CoCo over Web Serial, against a mocked serial port
node tests/drivewire-samename-servers.test.js # the store's case rule reaches all three DriveWire servers (Becker, serveRealCoco over a stub port, the chat's), with a case-sensitive control
node tests/composite.test.js # composite colour: NTSC artifact colours per phase and PAL line blending on known patterns
node tests/display.test.js   # Display tab settings (validated, remembered, applied per machine) and picture size
node tests/bus.test.js       # expansion bus: cartridge ROM/I-O, CART autostart, NMI/HALT lines, interrupt hub, the floating bus
node tests/carts.test.js     # cartridges: SN76489A, banked ROM, Orchestra-90, Multi-Pak, board choice, CART tied to Q, Session
node tests/session.test.js   # Session: model switching, ROM sockets, loading every file kind, pacing
node tests/reset.test.js     # Reset: never changes the machine, keeps RAM for a program's warm start, the boot watchdog arms only on a power-on, ROM-drop offers
node tests/snapshot-boot.test.js   # a snapshot opened is not a power-on: no boot failure after it, while a real power-on still has one
node tests/cli.test.js       # cli/cloadm.js as a child process: exit codes, --json, wait-for, typing, screen text, PNG pixels, snapshots, scripts, the guide's examples
node tests/skill.test.js     # the agent skill: the .agents copy identical, frontmatter, its tool table equal to the server's, its claims and PMODE 4 recipe run on the server
node tests/skill-evals/run.js # the skill's evals with and without it: real, billed Claude runs (needs the claude CLI), not in tests/all.js
node tests/plugin.test.js    # the plugin, marketplace and Claude Desktop extension manifests: one version, paths, placeholders, the tool list, the server starting as each starts it
node tests/mcp.test.js       # the MCP server over stdio: both protocol eras, every tool's results and errors against the in-page tools, handles, --read-only, the media root, cancellation, --serve
node tests/mcp-roms.test.js  # add_roms / remove_roms with stand-in ROMs: a local https server (a CA made for the run), every URL refusal (http, private/loopback/CGNAT/link-local, redirects, size, timeout, not a ROM), data, the media root, consent (elicitation), the store across restarts, --read-only, no ROM bytes in results
node tests/cli-agent.test.js # cli/cloadm.js beyond the basics: --describe, error codes, the debugger steps against the Session's debugger, DriveWire stalls, special keys, script quoting, --view
node tests/cli-wav.test.js   # --wav: a known DAC pattern's levels and timing, determinism, snapshots mid-sound, the box filter of the level events
node tests/cli-screenshot.test.js  # --expect-screenshot (tolerance, diff, PNG layouts, errors) and --hold
node tests/starter-game.test.js    # the starter game: its build, play script, picture and sound references, and mutants that must fail
node tests/game-guide.test.js      # docs/game-development.md's programs and commands, run (the settling patterns too, each shown to matter)
node tests/config.test.js    # URL parameters: every one checked (options against each model), bad values reported, links written and read back
node tests/embed.test.js     # the embed API through its message protocol: calls, errors, events, frames
node tests/pwa.test.js       # the service worker keeps every file the site serves (and build-examples.js keeps the list current); the manifest and its icons
node tests/install.test.js   # the install offer's rules: stored answers, Not now twice, a dismissed prompt, who is offered, the 60 s clock, each browser's steps
node tests/settings.test.js  # settings export and import round trip; ROMs and programs never in it, ignored if added
node tests/storage-move.test.js  # moving the library to another store: what is copied, kept, merged (ROM sockets and names), refused; reconnecting a folder copies only this visit's files
node tests/media-store.test.js  # storage layer: the MediaStore contract, random access, quota, localStorage migration
node tests/mame-lib.test.js    # the MAME runner: a failed start or exit status stops a comparison; the timeout only warns
node tests/audio.test.js     # audio output stage: sound unchanged, no pop at unlock, reset, machine switch, pause and resume
node tests/audio-worklet.test.js  # the AudioWorklet path: queue order, underrun to silence, bounded drop-oldest, the MessagePort sink, the processor
node tests/keyqueue.test.js  # fast typing: bursts read back from the keyboard matrix on every family and typed into LIZA, in order and complete
node tests/roms.test.js      # ROM identification across machines (synthetic images only), library, offers
node tools/gen-rom-docs.js   # regenerate docs/roms.md from the profiles (tests/romdocs.test.js checks it)
node tools/gen-page-preload.js  # regenerate the <link rel="modulepreload"> list in play/index.html (tests/pagepreload.test.js checks it)
node tools/page-load.js      # how long /play/ takes to start over a throttled link: modulepreload's effect (see below)
node tests/readme.test.js    # README.md and docs/*.md: only what GitHub renders; links, anchors and pictures resolve; no private or ROM-folder links
node tests/tape.test.js      # cassette: WAV files, decoding impaired recordings, capturing csave.asm's output on every SAM model and the MC-10, Session
node tests/tape-load.test.js # a tape dropped on the page: restarted, CLOADM, EXEC only when BASIC is back, a self-starting tape left alone (BASIC stand-in)
node tests/input.test.js     # input: both keyboard modes on every family, the keyboard joystick, gamepads, the CoCo Max module
node tools/mame-diff/tape/run-tape.js [profile ...]   # MAME records our writer firmware; MAME reads our .CAS and WAVs with our reader firmware
node tools/mame-diff/tape/run-playback.js [profile ...]   # how a .CAS is played: the same silences and the same blocks read as MAME (--ours: ours only)
node tests/tokens.test.js    # design tokens: agreed values, WCAG contrast, self-hosted WOFF2 fonts and licences
node tests/zip.test.js       # ZIP reader and inflate (hand-built archives; zlib as the oracle)
node tests/rompack.test.js   # ROM pack round trip; ROMs never in settings export or share links
node tests/detect.test.js    # media detection; disk fixtures made with MAME's imgtool (tests/fixtures/disks)
node tests/disk.test.js      # disk images: VDK, JVC and DMK to and from flux, hand-derived MFM cells and CRCs, round trips
node tests/fdc.test.js       # floppy controller cartridges register by register: commit delays, step rates, index, CRCs, NMI/HALT
node tests/nmi-arm.test.js   # when a CPU starts taking NMI: on the 6809 LDS, LEAS and TFR r,S arm it and EXG does not; on the 6309 only LDS and LEAS do; an earlier edge is lost
node tests/disks.test.js     # disks through the Session: stored, mounted and written back by range on the media store, write-protect, download, errors
node tests/disks-mount-race.test.js   # a Library rename, import or delete of the image a mount is reading: it reads again or fails clearly
node tests/disks-mount-case.test.js   # writes to the image being mounted under its own name or another case spelling, on case-sensitive, case-insensitive and unmeasured stores
node tests/disks-newdisk.test.js      # a new blank disk formatted by our firmware; newDisk against an import of the same name
node tests/importmedia-finally.test.js # the creation landing behind the Library's import: it lands only at the end, so a second creation asked inside the case probe is refused, and one queued behind a probe that throws still refuses
node tests/ay8910.test.js    # AY-3-8910/8912 against its data manual: tone, noise, the 16 envelope shapes, mixer, ports
node tests/alpha.test.js     # the Dragon Alpha's wiring: ROM banks, PIA2, the AY as the drive latch, NMI through PIA2 CA2
node tools/build-demo.js     # rebuild examples/demo.bin
node tools/build-examples.js # rebuild examples/liza.bin, liza6803-{mc10,alice}.bin, welcome.bin, welcome6803-{mc10,alice}.bin, chat.bin and starter-game/catch.bin from their .asm sources, then bring sw.js's offline file list up to date
node tests/welcome.test.js   # welcome program on every 6809 model: screen, menu keys and events, the tune on the DAC
node tests/demo-tone.test.js # the welcome demo plays one short clean tone (440-880 Hz, 0.3-0.5 s, $80 +/- amp), then nothing on the DAC; the bars are as defined (Dragon 64, CoCo, CoCo 3)
node tests/privacy-copy.test.js # the ROM privacy copy (README, docs, front, /roms, Help, play) says both halves: CLOADM never uploads ROMs; what Claude reads from memory, ROM areas included, goes to Anthropic
node tests/cpu6309-offer.test.js   # the welcome menu is offered on every 6309 model ('menu', 'back'), and the file it fetches is the 6809 build (welcome.bin), as the 6809 gets
node tests/cpu6309-session.test.js # the HD6309 runs the 6809 builds: welcome menu, LIZA, the demo and the chat firmware on every 6309 model, each ending in the same state as on the 6809
node tests/returning.test.js # returning visits: greetings, carry-on (option 6; 5 on the 6803 build), what ran last, back to the menu from LIZA (BYE or BREAK) and the demo
node tests/power-on.test.js  # without ROMs: Reset restarts what runs; power-on, a machine switch and a snapshot of the stub's prompt bring the welcome menu (6809 and 6803)
node tests/welcome6803.test.js # the 6803 welcome on mc10 and alice: raw screen cells, per-machine subtitle, keys, the two builds differ only at the HALT
node tests/regress.test.js                # fast gate: trace and frame hashes of the diagnostic firmware (seconds, no MAME; tests/all.js runs it too; --count prints the number of cases)
node tests/allsummary.test.js             # the gate itself: the FAILED: line and --only subset runs; a suite that exits 0 without printing its summary (a pending promise, or one printed only from an exit handler) fails; a suite that prints a "FAIL " line and exits 0 fails; normal suites pass; summaries printed from every writer and quote style are read; fixtures stay out
node tests/fastloop.test.js               # the fast-loop table above: every suite pattern selects a suite, every group exists; AGENTS.md's Start-here scripts exist
node tests/allsignal.test.js              # a signal to the gate stops every suite and exits 128+n; nothing survives
node tests/changelog.test.js              # a released CHANGELOG section equals the same section in its git tag (named corrections aside); needs the tags (CI fetches them, `git fetch --tags` locally: without them it prints a SKIP line per tag)
node tests/exitcode.test.js               # no suite or tool forces process.exit() (the Node 25 deadlock), by static scan
node tests/exitguard.test.js              # the same rule at run time, against every spelling a static scan cannot see
node tests/screen-alternative.test.js     # the screen canvas's text alternative: screen_text's rows, blank and block screens, a graphics mode, 80-column GIME
node tools/mame-diff/run.js <profile>     # lockstep trace comparison with MAME (needs mame; exit 0 = identical)
node tools/mame-diff/run.js <profile> --video [--artifact N]   # pixel comparison of every display mode with MAME
node tools/mame-diff/run.js coco3 --video --attr   # the GIME's text attributes, exactly (blank glyphs, so the fonts never show)
node tools/mame-diff/run.js coco3 --video --text [--cpu 6309]   # the GIME text screens, and Claude's screen_text on them
node tools/mame-diff/run.js d64plus --plustext [--video]   # the Dragon 64 Plus's 80-column text screens (lockstep; --video: every pixel)
node tools/mame-diff/run.js d64plus --paging [--video]   # the Dragon 64 Plus's $FFE2 paging: $04 is the motherboard RAM, the VDG never sees a bank (lockstep; --video: every pixel)
node tools/mame-diff/run.js coco3 --video --composite [--artifact N]   # the CoCo 3 on MAME's composite monitor (BPI, MOCH, artifact colours)
node tools/mame-diff/run.js <profile> --raster  # mid-line video changes swept across every beam position, against MAME
node tools/mame-diff/run.js <profile> --printer # printer output byte for byte against MAME's printer file
node tools/mame-diff/run.js <profile> --serial  # the bit-banger (or the Dragon 64's 6551) in lockstep with MAME's loopback plug
node tools/mame-diff/drivewire/run-dw.js [profile ...] [--no-trace]  # DriveWire over the Becker port: lockstep with MAME (TCP to our server), and byte for byte
node tools/nitros9/fetch.js && node tests/nitros9.test.js   # NitrOS-9 boot test (images fetched to a cache, never committed; tests/os9.test.js, tests/nitros9-session.test.js and the browser check's nitros9 group use them too, and skip without them)
node tools/nitros9/boot-floppy-mame.js <_40d_1.dsk> --cpu 6809 --record tests/fixtures/nitros9/coco3-6809-floppy.json   # the floppy boot's MAME reference (controller register writes)
node tools/mame-diff/run.js coco3 --fdc cocofdc --halt   # the controller's HALT and NMI in halted sector reads at 0.89 and 1.78 MHz, with MAME
node tools/mame-diff/run.js coco3 --fdc cocofdc --halt --empty   # a halted read on a drive with no disk: the CPU held for good, as in MAME
node tools/mame-diff/run.js coco3 --fdc cocofdc --nitros9 [--cpu 6309]   # the NitrOS-9 floppy loader on a hand-built boot floppy, with MAME
node tools/browser-check.js --only nitros9   # Boot NitrOS-9 from the page (the release images when fetched)
node tools/browser-check.js --only semantics # landmarks, headings, closed surfaces hidden for real, the screen's text alternative, a reading mode (Readability)
node tools/nitros9/boot-mame.js <image> --cpu 6809 --seconds 30 --type 'dir\r' --at 15 --record tests/fixtures/nitros9/coco3-6809-becker.json   # its MAME reference (also boot.js: the same boot on ours)
node tools/mame-diff/run.js <profile> --rate    # SAM CPU rate firmware (sam/rate.asm) in lockstep with MAME (mameCompat)
node tools/mame-diff/run.js <profile> --ops     # every instruction class at the SAM rates (sam/ops.asm), with MAME
node tools/mame-diff/run.js <profile> --pia1b   # PIA1 port B's input pins (RAM size sense, serial in), with MAME (SAM machines, the Alpha and CoCo 3)
node tools/mame-diff/run.js <profile> --reset [--cpu 6309]   # the Reset button (sam/reset.asm): MAME's soft reset and ours, RAM kept, BASIC's warm-start vector taken and refused (SAM machines; the 6309 on dragon64h, tanodr64h)
node tools/mame-diff/run.js dragon64 --fdc --images   # floppy controllers in lockstep with MAME, then the disk images byte for byte (also --fdc premierfdc, coco, coco3, dgnalpha --fdc alphafdc; --write: the mounting tests' firmware; --nmi: when the 6809 starts taking NMI; --multi: in a Multi-Pak's slot 4 with the Multi-Pak firmware; --blank vdk:40x1: a new blank disk formatted, add --no-trace for images only)
node tools/mame-diff/run.js dgnalpha --board          # the Dragon Alpha's own hardware in lockstep (alpha/board.asm)
node tools/mame-diff/run.js dgnalpha --sound          # the Alpha's AY-3-8912 and DAC against MAME's -wavwrite
node tools/mame-diff/run.js dragon64 --sound          # the DAC and single-bit sound (dragon32, coco too) against -wavwrite, through --wav's path
node tools/mame-diff/run.js <coco|coco3|dragon64|dragon32> --cart <banked|bankedshort|gmc|orch90|multi> [--audio]   # cartridges in lockstep with MAME, then their sound against MAME's -wavwrite
node tools/mame-diff/sam/run-fastvid.js <profile>   # fast-rate video: MAME keeps the screen, ours loses it (see above)
node tools/mame-diff/sam/run-samv.js [<profile> ...]  # SAM display counter at V=0 and V=1 (sam/samv.asm), every pixel against MAME
node tools/mame-diff/sam/run-hires.js <profile> [max3|rat]   # Hi-Res interfaces and the CoCo 3 Rat mouse, in lockstep with MAME
XROAR=/path/to/xroar node tools/mame-diff/sam/run-xroar.js [rate|ops|diag]   # per-instruction timing against XRoar
node tests/buscycles.test.js # 6809 bus cycles: count for every opcode, addresses of sample sequences
node tests/samrate.test.js   # SAM rate: instruction times per rate and address range, worked out by hand
node tests/tape-rate.test.js # a cassette load at rate 01 succeeds or fails by the loader's own timing
```

**What the gates' results mean.** `node tests/all.js` includes the regression gate: `regress.test.js` is one of its
suites (sharded on 4 or more cores), and the run prints `regress 146/146 included` from what the shards reported
against `node tests/regress.test.js --count`. A run in which the shards did not cover every case fails, even if each
shard exited 0, so a separate `node tests/regress.test.js` adds nothing.

`node tools/browser-check.js` runs its groups (`models`, `romUi`, … in the order of `GROUPS` in the file, plus a
final `missing files` check) one at a time, each on its own (`tools/browser-check-lib.js`):

* `--only g1,g2` (or `--only=g1,g2`) runs those groups. A name that is no group, or an empty list, is a usage error: the valid groups
  are listed, nothing runs, and the exit code is 2. `--list-groups` prints the group names, one per line, and runs
  nothing (no browser needed).
* A group that throws is that group's `FAIL`, printed with the stack; what it left open (its pages and contexts) is
  closed, and the next group runs. A browser that went away is started again for the next group.
* Every wait is checked. `waitFor` and `waitForFrames` wait on a condition, with a limit (30 s, or the frames of
  machine time a step is given) that only stops a page that hangs; a wait that reaches its limit is a
  `FAIL wait timed out (limit) at browser-check.js:line: condition`, even when nothing else looks at its result.
  The one exception is `maybeWaitFor(why, …)`: a wait whose timeout is the expected outcome (a check that something
  does not happen), with the reason in the call. A page that is gone is a FAIL in every wait, optional or not: an
  evaluate that fails because the page crashed, closed or navigated away is a `FAIL wait: the page is gone …` where
  the wait was called. In `maybeWaitFor` any evaluate that throws is a FAIL, and the page must still be the same
  document when its time is up; it then returns `null`, so a negative check passes only on `false`. A few loops poll outside these helpers (downloads arriving, requests
  reaching a mocked API, the embed API's calls from its host page); what they wait for is asserted by the check that
  follows them. A check given a Promise (a missing `await`) is a FAIL.
* Fixed sleeps are gone where a condition exists. What is left is a window in which something must *not* happen, or
  a fixture: a toast's 4 s that must not run out while it waits for room (feedback model, 5 s), "Reset says nothing"
  and "a typed POKE says nothing" (0.5 and 0.8 s), the embedded page that must not show its welcome menu (1.5 s and at
  least 60 emulated frames each), calls from a sibling frame that must be ignored (1 s), the rate-limited chat that
  must not retry by itself (0.5 s), a network response held back 1.5 s to start the welcome program late, and the
  page-loop group's replaced `requestAnimationFrame`. Windows where the page's own loop is what would act are counted
  in its animation frames (`ticks`), not in wall time.
* A check that cannot run here is a `SKIP` with its reason, counted in the summary, never silent. The NitrOS-9
  release images are the case: they are never fetched in CI, so there the two release-image checks are `SKIP`;
  locally, after `node tools/nitros9/fetch.js`, they run. A cached image that does not match its pinned SHA-256 is a
  `FAIL`, not a `SKIP`.
* The run ends with `FAILED group <name>: …` for each failed group, then
  `groups: N run, P passed, F failed · checks: n ok, n FAIL, n SKIP`, then `browser check passed` (with the SKIP
  count, if any) or `browser check FAILED`. Exit code: 0 only if every check, wait and group passed; 1 otherwise;
  2 for a usage error.

**How /play/ starts.** The page's module graph is 100 modules and about 815 KB of plain ES modules with no
build step, and it is six imports deep (the page → the Session → the machine families → the chips → the CPUs).
Left to itself the browser learns about a module only when the module that imports it has arrived, so the
deepest files are not even requested until several round trips in. `play/index.html` therefore carries a
generated `<link rel="modulepreload">` for every module the page's static imports reach
(`tools/gen-page-preload.js`; `tests/pagepreload.test.js` fails when it is stale). Nothing about what runs
changes, only when each file is requested. Measured with `node tools/page-load.js` (Chromium, 200 ms
round-trip, 100 Mbit/s, so the link is latency-bound as a phone on mobile data is): the last module was
requested at **3,821 ms without the list and 218 ms with it**, and the page reached "started" at 4,287 ms and
4,225 ms.

The "started" figure barely moves, and the tool prints why: it breaks the time into the first module (216 ms),
the modules in flight, and what happens after the last one (about 250 ms, mostly the emulated machine booting).
What is left in the middle is not the waterfall any more but the transfer itself: 100 modules over HTTP/1.1's
six connections a host is about 17 round trips, so at 200 ms of latency it costs about 3.4 s however early all
the requests are made. Getting past that needs fewer modules or fewer bytes on the startup path (or HTTP/2),
not a preload list. On a 1,500 kbit/s link, where bandwidth dominates, the list changes nothing (6,137 ms and
6,154 ms to the last module), which is why the latency-bound profile is the one to measure.

A module reached only through `import()` is deliberately not preloaded: that would undo the lazy import.

**Testing the storage layer.** `/play/?storage=opfs|fsa|fallback` picks the media backend for that page
load, so a browser that has OPFS can still be made to take the fallback path (and the download and import
buttons with it). Without the parameter the page uses the best the browser offers. It is a testing and
diagnostic switch, not a setting: it overrides the choice made in the Library for that load.
The folder choice is tested in the browser check with a mocked picker returning a real directory handle (headless
Chromium has no folder picker); with the real picker it was checked by hand in desktop Chrome on macOS: picking a
folder, the link surviving a full Chrome restart, an incognito window (no crash on reload, the choice enabled), and
dragging a spine onto the screen with a mouse. Dragging by touch is not verified; on a touch screen a tap loads.

**Disks and storage.** Disk images are stored in the media store under `disks/` and used through its random
access (`readRange` to mount, `writeRange` for what the machine writes, only the bytes that changed, when the
drive's motor stops, on eject, and before the machine or the page goes away), never through the media index.
A disk that comes back with a snapshot is the snapshot's own copy: it is not linked to the stored image, and
Download saves it.

## Pictures

The README's pictures are PNGs in [`img/`](../img/), captured from the emulator with no ROMs loaded
(`node tools/capture-images.js`).

## Headless MAME

These need MAME (`apt install mame`) and run headless. Three quirks of headless MAME are handled in the scripts:

* its screen buffer is only refreshed on mode changes, so the older `run-vdg.js` scripts capture each phase one frame
  late; the raster comparison and the MC-10 `--video` run avoid this by recording with `-aviwrite`. It keeps two
  bitmaps and redraws only when the fetched bytes change, so a still picture can leave a capture holding the other,
  stale one: `samv.asm` flips a byte that draws black either way every field to force a redraw
* its display start address ignored the SAM F bits in these runs, so the video test keeps its display data at `$0000`
* MAME's Lua API has no `read_u16be`; scripts read two bytes instead.

---

See also: [Architecture](architecture.md) · [Verification](verification.md) · [CONTRIBUTING.md](../CONTRIBUTING.md) · [AGENTS.md](../AGENTS.md)
