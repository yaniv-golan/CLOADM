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
| `js/debugger.js`, `js/session.js`, `js/selftest.js` | The debugger (`Emu.Debugger`, reached through `Session.debug`), the DOM-free front end and the ROM self-test |
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
(`tests/debug-session.test.js`). The machine's state and timing are unaffected.

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
its own event, before its halted cycles were charged. Such a write is queued (`Coco3Machine.outsideWrite`) and made at the machine's own
time - usually by the same run's after-loop flush, or `runCycles`' next top if a stall held it - where one made while
parked lands, so the machine ends identically either way. The queue is carried in the machine's snapshot as an optional key at the same format version (an
older build ignores it; a file without it restores owing none), and a run that throws on its way out of the window
still makes it. `poke` writes the memory image with no
bus cycle, at once - unless a queued write is still waiting (after a stall), which it then follows, so the later
call's value is final; a UI POKE or a debugger write made while the machine is paused then waits with the queue,
and the byte reads as it was until the machine next runs. A read is not deferred: it is serviced in the window, at the held access's time, with its device side effects
there - a read that releases HALT is what a halted loop waits for (`tests/held-writeio.test.js`).

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

A page reads `SNAPSHOT_OLDEST` to `SNAPSHOT_VERSION` (now 1 to 3) and says so when a file is newer or older. Files from
pre-release builds carry the identifier `"cloadm-snapshot"` and another layout; a page recognises them and says it does
not read them. `SNAPSHOT_VERSION` goes up whenever a `saveState()` changes what it writes, and `js/machines/machine.js`
records what changed. A version that only adds state keeps `SNAPSHOT_OLDEST`, so older files stay readable: a key an
older file lacks takes the restored machine's power-on value. A version that renames, removes or changes the meaning of
state sets `SNAPSHOT_OLDEST` to itself.

## The embed protocol

The calls travel as `postMessage` (`js/embed-api.js` describes the protocol), so the page around the iframe can
be on any site. `peek` answers only while the machine runs the built-in firmware with no cartridge: with your ROMs
loaded, memory can hold copies of them, and CLOADM never hands ROM code to another page. Or host your own copy: it is static files with no build step.

---

See also: [Development](development.md) · [Verification](verification.md)
