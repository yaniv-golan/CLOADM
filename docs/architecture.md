# Architecture

[CLOADM](../README.md) › Architecture

How CLOADM is put together. How to build and test it is in [development.md](development.md).

## The site and the modules

The site: the landing page `index.html` at `/`, the emulator `play/index.html` at `/play/`, and the reading pages
`roms/`, `help/` and `credits/` (each sets `<base href="../">`, so scripts, styles and examples load from the
site root; every link CLOADM makes points at `/play/`). `?start=welcome` or `?start=liza` opens the emulator running that program.
`img/` holds pictures of the emulator captured by `node tools/capture-images.js` with no ROMs loaded.

Native ES modules, no build step (so the page must be served over HTTP; `file://` doesn't load modules). `js/emu.js`
is the library entry point: it exports everything that runs without a browser page, and Node tests and tools load it
through `tests/load.js`. `Session` (`js/session.js`) is the DOM-free front end: machine switching with remembered
options, ROM sockets, loading programs, tapes and cartridges, and real-time pacing. The page (`js/ui/`) is a thin layer
of one module per panel over a Session, and an embedding page can drive a Session the same way.

| Folder | Contents |
|---|---|
| `js/cpu/` | CPU cores (`Emu.CPU6809`, `Emu.CPU6803`). A core only talks to a `bus` (`read`/`write`); what machines, the interrupt hub and the debugger use of a core is written down in `js/cpu/README.md`. |
| `js/chips/` | Standalone chips: `Emu.MC6821` (PIA), `Emu.MC6847` (VDG / T1), `Emu.SAM6883`, `Emu.GIME`, `Emu.WD17xx` (WD2797 / WD2791 / WD1773 floppy controllers), `Emu.FloppyDrive`, `Emu.SN76489` (the Games Master's sound chip), `Emu.AY8910` (AY-3-8910/8912 sound), `MOS6551` (ACIA); MAME-exact time for them (`attotime.js`, `attoclock.js`: the floppy, the disk controllers and the 6551's baud clock) |
| `js/machines/` | `Emu.Machine` base class; families registered in `Emu.families` (`sam`, `alpha` (the Dragon Alpha, on the SAM machine), `coco3`, `mc10`); shared parts (the Dragon/CoCo PIA board, the typist, the no-ROM stub firmware and text console); expansion devices (`bus.js`: the cartridge slot's lines `Emu.CartSlot`, the program pak; the floppy controller cartridges `Emu.DragonFdc`, `Emu.PremierFdc` and `Emu.CocoFdc`, and the Alpha's built-in `AlphaFdc`, in `fdc.js`; the banked ROM cartridge, Games Master, Orchestra-90 and Multi-Pak in `carts.js`, with `Emu.cartridgeFor` choosing a board; a device taken out, ejected or replaced, is detached: it drops the lines it asserts, its timer events and handler leave the machine, its sound goes to 0 and a disk controller commits what was written, a Multi-Pak's slots first); keyboard matrices and the queue host key presses go through (`Emu.KeyQueue`); the data-only model registry `Emu.profiles` with `Emu.createMachine(id)` |
| `js/video/` | `Emu.Frame` (colour codes plus a colour table, drawn scanline by scanline by the video chips) and presenters (`Emu.CanvasPresenter`) |
| `js/media/` | File formats (`Emu.formats`), the cassette signal (`Emu.Tape`) and deck (`Emu.CassetteDeck`, which also records what the machine writes), `cassette.js`: WAV read and write, the signal of a `.CAS`, and decoding a signal back to `.CAS`, disk images (`disk.js`: VDK, JVC, DMK to and from flux tracks), and the media index and its one-time migration (`js/media/library.js`) |
| `js/host/` | Browser keyboard mapping, audio output (the browser-free output stage `AudioOutput`; `audio-worklet.js`, the AudioWorklet processor and the `SampleQueue` it plays, which samples reach as transferred chunks through its MessagePort), small settings in localStorage, and the media storage backends (OPFS, File System Access, the download/import fallback) |
| `js/asm/` | Two-pass assembler engine (`Emu.assemble(src, cpu)`) with one instruction-set plugin per CPU (`Emu.isa['6809']`, …), and the disassembler (`Emu.disassemble(cpu, addr, { peek, labelOf })`) with one opcode table per CPU (`js/asm/dis6809.js`, `js/asm/dis6803.js`, `js/asm/dis7000.js`) |
| `js/machines/halt-replay.js` | The CoCo 3's HALT inside an instruction (`machine.halt`, a `HaltReplay`): where HALT arrived and was released in the last step, an I/O access waiting for the release, an instruction held past the end of a run and run again with its bus accesses replayed, and the outside writes queued while one is held. `js/machines/coco3.js` keeps the bus decode and the run loop, which use it |
| `js/debugger.js`, `js/session.js`, `js/selftest.js` | The debugger (`Emu.Debugger`, reached through `Session.debug`), the DOM-free front end and the ROM self-test |
| `js/drives.js` | The floppy drives of a Session (`Emu.DiskDrives`, `session.drives`): the disk controller and cartridge, blank disks, mounts from the media store and the writes back to it, the drives' status, and the links a restore point relinks |
| `js/library.js` | The media library of a Session (`Emu.MediaLibrary`, `session.library`): what the person keeps in the media store (list, open, download, rename, delete, import), the recent list, disk-name creations one at a time, the store's case rule (`sameName`), and moving the library to another store |
| `js/mcp/tools.js`, `cli/mcp.js` | The machine tools for MCP clients, transport-neutral (one table of name, schema, annotations and handler; the in-page Claude's tools run through the page's own path), and their stdio transports: the MCP server and `--serve` ([mcp.md](mcp.md)) |
| `cli/cloadm.js` | The command-line tool: a Session in Node, run in emulated frames (`Session.runFrames`) with no clock, steps from the command line or a script, one step table described by `--describe` ([automation.md](automation.md)) |
| `js/claude/`, `js/host/key-store.js` | The Claude chat: the Messages API backend, the brief, the byte channels (in-page and DriveWire), the conversation and its machine tools; the host-side key store |
| `js/config.js`, `js/embed-api.js`, `embed/cloadm.js` | URL parameters read, checked and written (`Emu.parseUrlConfig`, `Emu.buildUrl`); the embed API on a Session (`Emu.EmbedApi`) and the script an embedding page includes (`CLOADM.attach`) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline use and installing: the service worker (its file list written by `node tools/pwa-files.js --write`) and the app manifest |
| `js/ui/` | The page: one module per panel (screen, machine menu, drawer, media, ROMs, POKEs, assembler, self-test, the Library and its type-in card). The emulator layout: header with the machine menu, the screen in a monitor bezel per family, controls, cassette and cartridge slots, and a drawer with the tabs Media, Display, Input, POKEs and Machine. Messages follow `js/ui/feedback.js`: no status line; a state stays on its control (the tape deck, a drive, a ROM's row, the assembler's errors), an event is a toast at the bottom, or in a fixed slot at the top when no place there is free (never invisible; 4 s, 8 s with Undo, Show, Load or Details; cleared by the next action; shown on the page it belongs to, the emulator, the Library or Your ROMs), something blocking is an orange attention card, and what the machine shows itself is not repeated |
| `css/tokens.css`, `css/reading.css`, `fonts/` | Design tokens (colour, type, shape) shared by every page, with the light variant the reading pages (`<html class="reading">`: landing, `/roms`, Help, Credits) take from a light system setting (the emulator stays dark); the reading pages' layout; the self-hosted Archivo and JetBrains Mono fonts with their SIL OFL licences |

`Emu.Machine` owns everything the models share:

* the frame loop
* a cycle-accurate event scheduler on one absolute tick counter: events are named, cancellable data (so they can be
  saved), fire in the middle of an instruction when the CPU touches I/O, and video line events reschedule themselves
* the keyboard matrix, auto-typing (`m.typist`) and the cassette deck (`m.deck`)
* audio capture
* ROM slots, PC hooks for the no-ROM stub, program injection and BASIC program loading

A family supplies only its hardware: the memory map, chips, per-frame video events and rendering. A model is a profile
entry that names its family and adds per-model data: timing standard, RAM size, ROM sockets and quirks.

**Scanline video.** The VDG has no line buffer: it converts each display byte as it is fetched, so a mode or palette
change part-way through a line shows above the change with the old setting and below it with the new one, on that same
line. The machines therefore draw each active line as the beam passes it: `MC6847.positionFromClock()` converts VDG
clocks since HS into a byte position (0-32 across the active area; MAME's rule, first visible pixel 25 clocks after
HS, four clocks per byte), the machine fetches and draws the bytes up to there (`MC6847.drawSamples()`) when a video
bit changes, and `MC6847.endLine()` finishes the line at HS. A write takes effect at the end of its bus cycle. The SAM's display address counter is modelled
as the chip's flip-flop chain (B0-B3 bytes, bit 4 the 16-byte offset in a row, bits 5+ the row) with per-mode carry
divisions, so a mid-field mode change keeps its address position - which is why such a field is not the same as a
static picture of the new mode. The CoCo 3's GIME already latched its palette and video registers per scanline.

## Audio output

The machine produces no samples: each frame it records its sound level as `[cycle, level]` events
(`machine.audioEvents`). The host turns them into sound in `js/host/`, and nothing there feeds back into the machine,
so the samples the chips make are the same with sound on, off, or played anywhere else.

* `AudioOutput` (`audio.js`, browser-free) averages the level over each sample's window (a box filter), DC-blocks it
  and writes one chunk a frame to its sink. The command line's `--wav` uses it with no filter and a sink that only
  collects.
* On the page the sink is a `PortSink`: chunks go, transferred, through the MessagePort of an `AudioWorkletNode`,
  whose processor (`audio-worklet.js`, `cloadm-output`) plays them from a `SampleQueue` on the audio thread and
  reports what it has taken every 4 render quanta. The module imports nothing and is loaded with
  `audioWorklet.addModule()` from its own URL: no build step, and `sw.js` keeps it for offline use.
* The ScriptProcessorNode fallback plays the same `SampleQueue` on the page's thread where no worklet module can load.
  Every supported browser has AudioWorklet, but it needs a secure context, and the connector's inline side-panel view
  (`connector/fold.js`) runs under a CSP that allows no fetched, `blob:` or `data:` script, so no module can be loaded
  there. It is made only then, never alongside a working worklet.

Latency is steered to `TARGET_MS` (40 ms) of queued sound:

* inside 10-80 ms a frame is played as it is; outside, it is resampled by a held 2% toward `TARGET_MS` (the slow
  drift between the machine's clock and the sound card's);
* **bounded catch-up after a stall.** Too shallow: once the queue has run dry and faded out (a pause, a debugger stop,
  a stalled or hidden tab), `SampleQueue` re-primes: it plays silence until `TARGET_MS` is queued (or twice that long
  with something queued, so a lone frame still plays), then fades in, so playback restarts `TARGET_MS` deep at once
  instead of on one frame. Too deep: past `SKIP_MS` (120 ms) `AudioOutput` drops whole frames until the queue is back
  to `TARGET_MS`, within `CATCHUP_MS` of real time, moving its filter's input so the next frame doesn't step.
  `tests/audio.test.js` runs both on a model of the page's clock (`simulate`), `tests/audio-worklet.test.js` the
  queue and processor, and the browser check's `audio` group the real page.

## The debugger core

`js/debugger.js` is the debugger behind the Session, browser-free: `session.debug` is one debugger per machine,
made on first use. It has breakpoints on an address, watchpoints on a read, a write or both over an address
range, single-step, step over a subroutine call, run to return (both arrive at the caller's stack level, so a
recursive call passing the same address deeper down doesn't count; run to return reads the return address where
each CPU stacks it: at S on the 6809, at S+1 on the 6803, which pushes it low byte first), run to an address (each stops with kind
`limit` if it doesn't get there within its instruction limit, rather than leaving the machine running), and a log of the last N
instructions with their registers, cycle counts and disassembly. Registers and memory can be read and written.
`js/asm/disassembler.js` (6809, 6309 and 6803) gives each instruction's mnemonic, addressing mode and bytes, and
shows bytes that are not instructions as `FCB` data of exactly the length the CPU core reads for them; a program
that came from the assembler has its symbols in the disassembly. The 6309 has its own opcode table
(`js/asm/dis6309.js`), written from the HD63B09EP Technical Reference Guide's opcode table (printed pp. 11-18),
Atkinson's opcode map (printed p. 152) and its per-instruction pages; it decodes every opcode the part has, and
assembling, disassembling and reassembling gives back the same bytes for all 436 of them. An undefined opcode on a
6309 traps rather than running (Atkinson printed pp. 151-153), so it is listed as one byte of data on page 1 and
two behind a `$10`/`$11` prefix.

A step runs one instruction through the machine's own frame path, so it costs what the instruction costs and
debugging changes no timing: `tests/debugger.test.js` compares 40 stepped instructions with a free run, and shows
that a debugger which never stops leaves the instruction trace identical. The debugger's own memory view and
disassembly read memory directly, not through the bus the program runs on, so inspecting a watched byte never
stops the machine. Its errors are `SessionError`, like the rest of the Session API. Breakpoints and watchpoints travel in
the machine's snapshot. While a breakpoint or watchpoint is set, the page's frame loop runs the machine through the
debugger (`Debugger.runFrame`), so a running program stops there; the frames it runs are identical to free ones
(`tests/debug-session.test.js`). When a breakpoint or watchpoint stops the machine in the middle of a frame, the
frame stays open with the sound it had made so far, and that sound is played when the frame finishes after you
resume; while the machine is stopped the speaker is silent, so a stop can be heard as a short gap or click
(`tests/debug-session.test.js`). The machine's state and timing are unaffected. A command that runs outside the
frame loop (Step, Over, Out, Run to) closes each frame its instructions pass, through the machine's own `runFrame`
with nothing left to run, at the point a free run would close it, and opens the next before an instruction runs; so
after a long Over the open frame still holds the machine's tick, Run goes on in the next frame, and the frames and
instructions are those of a free run (`tests/debugger-catchup.test.js`), the machine's own per-frame work included
(sound, tape, the typist's keys). The Session's per-frame work is not done for those frames, because they are closed
inside the debugger and not by the frame loop: the host's keys, the chat machine's bytes and the machine beside it in the
picture-in-picture (`runBeside`) do not run, the page plays none of their sound, and `cli/cloadm.js --wav` records none of
it. A screenshot through MCP after a step that crosses a frame's end shows the frame the step closed (`js/mcp/tools.js`,
the step tool).

**Time between instructions.** A family's `ioTime()` is "the tick at which the current instruction touches the
bus"; between instructions there is no such access, and it answers `now()` (`Machine.ioTime`, and the CoCo 3's
`accessStart`, which ends a MAME-compat scheduler slice). That matters because the CPU keeps its cycle count after
a step — the trace and the debugger read it — so an answer taken from it between steps would fire scheduler events
up to a whole instruction early for a tool that looks at the machine between steps (a debugger's write, a stub
hook), and a restored machine, whose CPU comes back with a count of its own, would answer differently from the
original for the same access. Inside an instruction nothing changes, which is what the regression hashes pin
(`tests/iotime.test.js`). On the CoCo 3 a pre-step event handler may see `ioTime()` up to `div - 1` clocks before
its own `e.at`: `runCycles` fires events due before `justUnder(cycle + div)`, so an event lands in the step it
precedes while the machine's time is still the end of that window (the `justUnder` note in
`js/machines/coco3.js`), which is what MAME's scheduler does too.

A step in which no instruction runs is not an instruction for the debugger: a halted cycle (HALT asserted), or the
CoCo 3's instruction held by the disk controller's HALT and suspended at the end of a run (it runs again from its
start once HALT is released). It makes no trace entry, counts toward no limit and reports no watchpoint hit; the
instruction's accesses are reported once, when it completes, and a breakpoint is checked once, at its start. With
the CPU halted, Step waits one frame of machine time for an instruction, then stops with kind `halted` ("Halted at
..." on the Debugger screen) and the PC unchanged; Over, Out and run to an address wait two seconds, then stop the
same way. Run goes on: the machine stays halted, its frames run, and the program goes on when HALT is released.
Setting a register to a new value, or writing over the memory it used, while an instruction is held drops it: the CPU goes on from the state you gave it once HALT is
released (`docs/verification.md`, CoCo 3 floppy HALT).

**Writes from outside during a held access.** While that suspended instruction's events run, the CoCo 3 holds the
machine at the held access's time (`heldIo`, above). A write from outside the CPU reaching the bus there would land
in a state no instruction may see: a rate write (`$FFD6`-`$FFD9`) would drop the suspended instruction from inside
its own event, before its halted cycles were charged. Such a write is queued (`HaltReplay.outsideWrite`) and made at the machine's own
time - usually by the same run's after-loop flush, or `runCycles`' next top if a stall held it - where one made while
parked lands, so the machine ends identically either way. The queue is carried in the machine's snapshot as `outsideWrites` (snapshot version 3; a version 1 or
2 file has none and restores owing none), and a run that throws on its way out of the window
still makes it. `poke` writes the memory image with no
bus cycle, at once - unless a queued write is still waiting (after a stall), which it then follows, so the later
call's value is final; a UI POKE or a debugger write made while the machine is paused then waits with the queue,
and the byte reads as it was until the machine next runs. A read is not deferred: it is serviced in the window, at the held access's time, with its device side effects
there - a read that releases HALT is what a halted loop waits for (`tests/held-writeio.test.js`).

**Probes and bus taps.** The host observes a running machine through internal hooks, shared by the
debugger, the Session and the developer features built on them (the memory-write observer, `Session.watchWrites`, and the
profiler). All are host state: never in a snapshot, untouched by a reset, and free when nothing is registered. Their public
clients are `watchWrites` (below) and the profiler (`js/profiler.js`, `Session.profile`): one probe that charges the
cycles `cpu.totalCycles` moved since the last probe to the instruction that ran, and a read and a write tap over the
whole address space for its spin test, all on `session.hooks` and taken off when it stops.

* `machine.addProbe(fn)` → `remove()`. `fn(pc)` runs before each CPU step, in registration order, from the family's
  `runCycles`. `pc` is the address of the instruction about to run, unless an interrupt is taken at that step: then
  the handler's first instruction runs instead, and the interrupted one later. The probes share the one
  `machine.pcWatch` slot, which stays `null` with no probe (one test per instruction), holds the probe itself when
  there is one, and a dispatcher only for two or more. A probe added or removed from inside a probe takes effect at
  the next instruction: one removed by an earlier probe still runs for the instruction under way. Each instruction
  is probed once: a CoCo 3 instruction suspended by HALT had its call when it first started, and is not probed
  again when it resumes.
* `machine.busTaps.addReadTap({ start, end }, fn)` and `addWriteTap({ start, end }, fn)` → `remove()`
  (`js/machines/bustaps.js`). `fn(address, value)` runs after each read or write of an address from `start` to `end`
  (both inclusive) through the machine's `read`/`write`, in registration order. The first tap of a kind shadows
  `machine.read` (or `write`) with an instance property; the last one removed deletes it, so the bus is the family's
  own method again, whatever order the taps came off in. Nothing else may shadow those methods: a second observer is
  a tap. `busTaps.rawRead`/`rawWrite` are the family's methods below every tap: the debugger's own memory writes go
  there, so they fire no watchpoint and no tap.
* `machine.addRunEnd(fn)` → `remove()`. `fn()` runs when a run of instructions ends: in `runFrame` once the frame's
  instructions are run, before the frame closes (whether it ran free or through a `runTo`), and in the debugger after each
  instruction it steps. Like the probes, the hooks share one slot (`machine.runEndWatch`), `null` with none.
* A bus write tap added with `{ old: true }` also gets the byte the address read as just before the write
  (`machine.peek`, no bus cycle), read only for an address such a tap covers.
* Each access is reported once. On the CoCo 3, an instruction suspended by the disk controller's HALT runs again from
  its start and replays the accesses it made before the held one (`HaltReplay.replayRead`/`replayWrite`); those
  were reported when they were made, so taps skip the replay (`Machine.replaying()`). The debugger's taps are the one
  exception (`{ replays: true }`): a watchpoint hit belongs to the instruction that completes, so the debugger drops
  what a suspended run saw and takes the accesses again from the run that completes it, as described above.
* The debugger's watchpoints are a client: it holds a read tap and a write tap over the whole address space while
  some watchpoint watches that kind of access, and none otherwise, so a debugger with no watchpoints leaves the bus
  as it is.
* The Session's own probes and taps (`session.hooks`, `js/hooks.js`) follow the person's machine: the machine in
  use, or the BASIC session running beside a full-screen chat (never the chat machine). `Session.followPerson`
  (called by `install`, itself called by `adopt` for a machine switch or an opened snapshot and by the chat's machine
  views) takes them off the old machine and puts them on the new one in the order they were added. The move is all or nothing: if one cannot
  go on the new machine (its bus already shadowed), the ones added are taken off again, all stay on the old
  machine, and the error is thrown. The Session's load detector (the EXEC
  after CLOADM) is a probe on the machine it loads into; it goes when it decides, or when the typist drops the EXEC
  it waits to type (`Typist.typeWhen`'s `cancel`: a reset, a later load, a restore point). `hooks.add(attach)` keeps
  anything else on the machine in use the same way: `session.serial` keeps its port listener and each trace (the
  6551's `addTrace`, or a bit-banger port listener) there, and a probe while an `'instant'` subscriber is.

* **The memory-write observer** (`Session.watchWrites`, `js/writewatch.js`) is a client of the Session's hooks: a write
  tap per observer queues `{ address, value, old, pc, at, frame }` during the bus cycle (no callback runs there), and
  the queue is delivered after the writing instruction completes and before the next one starts: by the probe of the
  next instruction, by the run-end hook (a write in a frame's last instruction arrives before the frame closes), and,
  while an observer is registered, by the Session's own run of the frame (`WriteWatch.runTo`, an instruction at a time
  through `runCycles(end, 1)`), so a callback that returns `'stop'` stops the run there through the debugger's stop path
  (`kind: 'write'`). Nothing is delivered while a CoCo 3 instruction is held (`machine.cpuHeld`); its writes are reported
  once, by the taps' `replaying()` rule. `pc` is the probe's (for the bytes an interrupt stacks, the instruction it came
  before). A callback may set keys, the joystick and mouse, send serial bytes and poke memory; `switchMachine`,
  `openSnapshot` and `snapshotFile` refuse with a `SessionError` while one runs. `tests/writewatch.test.js` covers it.

`tests/probes.test.js` covers the probes on each CPU family, the taps removed in every order, a watchpoint beside a
tap, the CoCo 3's held instruction (one tap report and one probe call per access and instruction), and the
Session's hooks across `openSnapshot`, `switchMachine` and the chat's views, with a move that fails part way;
`tests/tape-load.test.js` loads tapes with other probes beside the load detector.

The **Debugger** screen (`/play/#debugger`) shows the assembler's source, the registers (click to edit) and
condition codes, the machine's screen, the disassembly around the program counter (click a line for a
breakpoint), the breakpoints and watchpoints (add one by address or label), memory (click a byte to edit it or
watch it) and the trace. Run / Pause is F5, Step F11, Over F10, Out Shift+F11.

## Snapshot format

The file is gzip-compressed JSON (`js/media/snapshot.js`; an unpacked file is read too) with these fields:
`format` (`"cloadm-state"`), `version`, `machine` (the model's id), `name` (the model's name), `taken` (ISO 8601 time),
`config` (the model's options), `roms` (the CRC of each ROM it ran with, never the ROM) and `state` (what every
component's `saveState()` wrote, byte arrays as base64). A shared moment also has `share` (the ROM and cartridge images
it names). The layout is `SNAPSHOT_VERSION` in `js/machines/machine.js`.

A page reads `SNAPSHOT_OLDEST` to `SNAPSHOT_VERSION` (now 1 to 4) and says so when a file is newer or older. Files from
pre-release builds carry the identifier `"cloadm-snapshot"` and another layout; a page recognises them and says it does
not read them. `SNAPSHOT_VERSION` goes up whenever a `saveState()` changes what it writes, and `js/machines/machine.js`
records what changed. A version that only adds state keeps `SNAPSHOT_OLDEST`, so older files stay readable: a key an
older file lacks takes the restored machine's power-on value. A version that renames, removes or changes the meaning of
state sets `SNAPSHOT_OLDEST` to itself.

## The embed protocol

The calls travel as `postMessage` (`js/embed-api.js` describes the protocol), so the page around the iframe can
be on any site. `peek` answers only while the machine runs the built-in firmware with no cartridge and no NitrOS-9: with your ROMs
or your NitrOS-9 image loaded, memory can hold copies of them, and CLOADM never hands ROM code to another page. Or host your own copy: it is static files with no build step.

---

See also: [Development](development.md) · [Verification](verification.md)
