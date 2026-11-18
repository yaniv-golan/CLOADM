# Changelog

All notable changes to CLOADM are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project intends to use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once releases are tagged.

## [Unreleased]

### Fixed

- **The Debugger works on an HD6309.** On a machine with the CPU option set to 6309 the Debugger screen threw
  `ORDER[cpu] is not iterable`: its register order and flag tables had no 6309 entry. It now shows the full 6309
  register set (PC A B E F D W Q V MD X Y U S DP, with the condition codes as on the 6809) in the order the core
  has them, and the fields edit the core as the 6809's do; Q, the 32-bit accumulator, is shown and edited as eight
  hex digits. The tables live in `js/debugger.js` (`REGISTER_ORDER`, `REGISTER_DIGITS`, `FLAGS`) and the panel
  reads them, so a CPU is added, and a register's width set, in one place. A register field still takes a label
  (a program's `START`) as it does on the 6809. A direct operand is now disassembled against the CPU's real DP on a
  6309, where it used DP 0 (`js/debugger.js`). `Session.codeAt` (Ask's "What is this code doing?") had the same two
  faults on a 6309 - it read 6309-only opcodes with the 6809's table (LDQ shown as data) and left E F W Q V MD out
  of the registers it sent; both come from one helper now (`codeDisassembly`, also used by the Claude
  `disassemble` tool), so the debugger, the trace and Ask cannot disagree.

### Changed

- **Claude's acting tools follow the read tools' contract.** `poke`, `type_text`, `load_basic`, `press_break`,
  `assemble_and_load` and `run` are entries of one table in `js/claude/chat.js`, and `ChatSession.runTool` runs each
  the same way: the consent gate (`ChatSession.gate`, which the Session now sets instead of wrapping the backend),
  the tool's read-only checks, a Stop check, then the change inside the turn's restore point
  (`ChatSession.withRestorePoint`); the offered schemas and the gated names both come from that table. Anything
  uncoded inside a tool is the new code `tool-failed`, never a raw exception (`asToolError`, applied in `runTool` and
  in the backend). Stop while the consent card is up is `stopped` (it was `consent-declined`). Every schema states
  its ranges and defaults from the constants the code applies (`POKE_MIN`, `BYTE_MIN`/`BYTE_MAX`,
  `ASSEMBLE_DEFAULT_ORG`, `RUN_DEFAULT_TARGET` are new) and every description names the codes the tool returns and
  its whole result. The brief states the contract (`TOOL_CONTRACT`), and `docs/claude.md` lists every code with its
  remedy. New `tests/claude-acting-contract.test.js`: every acting tool against every outcome through the backend
  with a mocked API, the schemas against the constants, and the gate and restore point for every tool. Just before
  the change a synchronous re-check (`ChatSession.recheck`, set by the Session) catches what happened while a card
  waited or a check ran (an INCLUDE read): Claude paused waits for Resume (Stop or Esc: `stopped`), and a call that
  relied on the "Let Claude use the machine" switch is `no-consent` once it is off; nothing lands while paused. A
  `ChatSession` built without a gate now refuses every acting tool (`no-consent`) instead of allowing it. `run.target`'s
  schema is `anyOf` an integer `ADDRESS_MIN`-`ADDRESS_MAX` or a string.
- **Test gates (tooling): a green run means what it says.** `node tools/browser-check.js`: an unknown or empty
  `--only` group list is an error (exit 2) listing the valid groups, where it used to run nothing and pass; each group
  runs on its own, so one that throws is that group's FAIL with its stack and the rest still run; every wait's
  timeout is a FAIL where it was called unless the wait is marked optional with its reason, and a page that crashed,
  closed or navigated away is a FAIL in every wait, optional or not (a negative check passes only on a live page); fixed sleeps are replaced
  by condition waits wherever a condition exists (the windows that remain are listed in `docs/development.md`); the
  NitrOS-9 release-image checks are a counted `SKIP` when the images are not cached (never fetched in CI); and the
  run ends with groups run / passed / failed and the ok / FAIL / SKIP counts (`tools/browser-check-lib.js`,
  `tests/browser-check-lib.test.js`). `node tests/all.js` prints `regress 146/146 included` and fails if its regression
  shards did not cover every case (`node tests/regress.test.js --count`).
- CI runs the gates on every push to `main`, `claude/**` and `ds/**`: `node tests/all.js` and the browser check in
  4 parallel shards, then a `gates` job that fails unless all passed and reports the commit, its tree hash, the run attempt (flagging a re-run) and the
  counts. A check fails the run if any browser-check group (as `node tools/browser-check.js --list-groups` prints its
  `GROUPS` table) is in no shard, in two, or a shard names a group that isn't one. A newer push to a branch
  cancels the older run there; runs on `main` are never cancelled.
- CI installs Playwright more robustly: the chromium download is cached on the Playwright version and runner image, and the OS packages install with up to 3 tries with `apt-get update` between (a flaky apt mirror no longer fails a browser-check shard before any test runs).
- AGENTS.md: a green CI run on the exact commit is the definition of done; `regress.test.js` needn't run separately
  where `all.js` ran; nothing else runs beside the browser check; a review section (verify the run's SHA and tree,
  replay mutations, re-run gates only for non-additive changes to tests, tools or CI); the report gives the CI run.

#### Added

- **NitrOS-9 from a floppy:** the release's `_40d_1.dsk` (35/40-track NitrOS-9 floppies) boots the same way with
  CLOADM's own floppy loader and the CoCo disk controller, no Disk BASIC ROM needed.

#### Fixed

- **CoCo 3 disk controller HALT:** a sector read with the CPU halted could read the data register before its byte
  (NitrOS-9's floppy booter read LSN 0 one byte off, and every byte twice at 1.78 MHz). HALT now suspends the CPU
  inside an instruction as MAME's does, and the cartridge slot's line delays follow the CPU rate. A halted read whose
  DRQ never comes (an empty drive) holds the CPU across frames instead of the page: the screen and timers run on, and
  a disk in the drive or a Force Interrupt releases it. Changing the CPU's registers while it is held (a program
  loaded and started, a jump, the debugger) drops the held instruction, as does writing over its code: the CPU
  goes on from the new state when HALT is released. A held instruction runs again with exactly the bytes it had
  read (a 6309 TFM whose source overlaps its destination copied its own new bytes), however long it is. The debugger counts no instruction while the CPU is halted: Step waits a frame and reports
  "Halted", Over/Out/Run-to wait two seconds, and Run keeps the frames going without stopping.

#### Changed

- **Snapshots are format version 2:** a CoCo 3 instruction held by the disk controller's HALT is saved with the
  machine. Version 1 files still open; a page from before this change refuses version 2 files as newer.

### Fixed

- **Ask Claude's restore points:** a restore that can't happen (the ROMs changed since the point was taken: Forget
  ROMs, Run without ROMs) no longer throws the points away and stops Claude first: it says why, changes nothing and
  keeps every point. After a restore, a disk still in the same drive since the point (the same mount, not ejected
  or changed in the Library) goes on saving its writes to the Library (before, later writes were silently not
  saved), and if the machine wrote to it since the point its stored image is first put back to the image the drive
  holds, so the undone turn's writes are not left mixed in; a disk not written since is not rewritten. Any other
  disk (ejected, replaced, mounted again or moved since the point, write-protected, or a file that can't be written)
  is not rolled back: the Library's file is left alone and the restore says the restored disk isn't saved. In the
  full-screen chat the Library now also refuses to replace, rename or delete a disk in the BASIC session's drives, and
  the BASIC session's drives are saved when the page is hidden. A disk mounted again in the drive it is in is read
  only once no write to the Library is in flight (a restore's put-back, an import, another drive's write), so a
  drive and its file no longer end up as two versions, and two mounts of one image at once can't both go in.
  Moving the library waits for the disks' last writes, and while it moves no disk goes in and the Library
  changes nothing (an import, rename or delete then would have been lost from the moved library).
  Every acting tool, `load_basic` included, takes the turn's restore point through
  one shared path, so a new tool can't miss it. The restore control now says that points live in memory only (a
  reload, ending the chat or switching machine loses them) and that other saved files are not rolled back.

### Added

- **The Speech/Sound Pak on the Dragon 64.** The cartridge port's board menu now offers the Pak on the Dragon 64
  as it does on the CoCo 1/2, CoCo 2B and CoCo 3, music only (speech is still not implemented). The Dragon 64's
  run of this project's diagnostic firmware matches MAME 0.264 instruction for instruction to HALT, which is what
  offering it rests on; the other Dragon-family models (Dragon 32, Dragon 200, Dragon 200-E, Tano Dragon 64, Dragon Professional (Alpha)
  and Dragon 64 Plus) have not been run, so they do not offer it.

### Fixed

- **The HD6309 now runs the 6809 programs.** Choosing the 6309 (Machine tab, or `?machine=dragon64&cpu=6309`)
  opened on "Welcome: examples/undefined: HTTP 404": the Session's welcome-menu, LIZA, colour-demo and Claude-chat
  lookups were keyed by the literal CPU and had no 6309 entry, so the page fetched a missing file, the screen kept
  the bare stub, the Media tab lost the colour demo, and the choice stuck for later visits. The lookups now go by
  CPU family (`js/cpu/cpus.js`), and the 6309 — which runs every 6809 instruction in emulation mode — gets the 6809
  welcome build, LIZA and demo, and the 6809 chat firmware. The stored 6309 choice is unchanged.

### Changed

- **Esc in the full-screen chat escalates.** On the chat screen Esc is BREAK while a reply streams (it stops the reply)
  or while a line is typed (the firmware drops it); on an empty, idle prompt it leaves the chat, exactly as
  "← Emulator" does. The focus pill there reads "Esc stops a reply, clears the line, then leaves the chat".
- **The hints under the screen are one line of fixed height**, one note at a time: "No ROMs needed · click anywhere
  for sound" until sound starts, then the key hint until it is done, then an empty line that keeps its height. The
  monitor leaves a little more room (100vh − 260px), so on a first visit the Reset row is inside a 1280 × 720 window
  and nothing under the screen moves. The key hint now reads "Esc = BREAK · Home = CLEAR · Backspace = ←" (it no longer
  says "keys type what they say", which is wrong in positional mode) and always fits: one line when the column is at least
  360 px wide, otherwise a fixed two-line box.
- **Link errors say what to do:** `app=bogus isn't something CLOADM has (try app=claude)` (likewise `start=`), the
  unknown-`machine=` error lists the machine picker's names rather than ids, and a `load=`, `tape=` or `cart=` the
  other site won't let CLOADM fetch says "Couldn't download it: the site may not allow other sites to load its files."
  instead of "Failed to fetch".
- In the BASIC-session view (Ctrl+B from the chat) the corner label reads "The chat · live", so it is no longer a
  second "Back to the chat" beside the button.

### Fixed

- Opening the full-screen chat from a view no longer forgets that the Ask panel reopens when the view closes if the
  chat fails to open (for example, its firmware does not load).
- The browser's Back from a view leaves the focus on the screen, as "← Emulator" and Esc do (it landed on the page or on
  the opener's button), also when the Ask panel reopens over the conversation.
- After a reload while a view was open over the chat, Back no longer leaves `?app=claude` in the emulator's address: a
  page loaded on `?app=claude` now keeps the emulator's own entry, without the parameter, under the chat.

### Changed

- **Ask Claude says what it reads, and that it is only the emulator.** The panel's header is "Claude can read
  (emulator only):" with the chips "Screen text" and "Memory"; the placeholder and the phone peek say "Ask about this
  machine"; the empty state says "Claude reads only this emulated <model> (its screen text and memory), never your
  computer" and follows a machine switch, on phones too; a new footer line says "Your messages and what Claude
  reads go to Anthropic with your key." The full screen card names the BASIC session's model. The switch is "Let
  Claude use the emulator" everywhere (page, docs, README).

### Fixed

- "What is this code doing?" asked from the full screen chat (Ctrl+K) disassembled the chat firmware and its
  registers; it now reads the BASIC session, as the read tools do (`Session.codeAt`).

### 0.1.1-pre

#### Added

- **`load_basic`**, a new acting tool for Claude: a BASIC program is tokenized for the machine's BASIC (Dragon,
  CoCo Color/Extended/Disk/Super Extended, MC-10) and put straight into program memory, as a load from tape or disk
  would, with coded errors. Claude types programs of 3 lines or fewer and offers `load_basic` for longer ones,
  and checks the result (LIST and the screen) before saying it worked. Loading asks on every call with its own card
  ("Don't ask again this session" stops it for the visit). The same load is `Session.loadBasic(program)` and the
  embed API's `loadBasic`, for automation, with no card.
  "Don't ask again this session" is offered only while "Let Claude use the emulator" is on: with the switch off
  every load asks, and Stop while the card is up ends the call as `stopped` rather than `load-declined`.

- **Booting NitrOS-9 from the page:** on the CoCo 3 (6809 or HD6309), NitrOS-9 Level 2 boots from the user's own
  DriveWire image (the release's `_becker.dsk`) with no ROM: CLOADM's own loader (`js/machines/nitros9.js`) takes
  the internal ROM's place and boots drive 0 over the Becker port. The NitrOS-9 slot under the screen, a dropped
  image's offer, `?nitros9=` links (never carrying the image), and clear refusals for images that can't boot
  this way (`js/media/os9.js`). The loader moved from `tools/nitros9/bootdw3.asm` to the page.

#### Fixed

- "← Emulator" (and Esc, and the browser's Back) now always return to the emulator. Opened from
  `/play/?app=claude`, the Debugger, Library and Share went back to the full-screen chat instead, and after a reload
  on a view, Back and the chat's "← Emulator" could land on the Debugger again. The views and the full-screen chat
  now share one history model (`page.openStep` / `page.toEmulator` in js/ui/page.js): at most one is above the
  emulator, in one history entry marked with the page load that added it, and the views follow `popstate` as well
  as `hashchange`. A view opened from the full-screen chat moves the conversation to the side panel, and coming back to the
  emulator (by "← Emulator", Esc or Back) reopens the Ask panel on that conversation, so a waiting question or a reply
  in progress is not left unseen.

- **Claude's `type_text` dropped keys** while BASIC was busy (storing a line, scrolling) and still reported
  success. Typing is now paced by what the machine consumes: each key is held until the CPU has read its keyboard
  column, released until it has seen the key go, and after Enter nothing more is pressed until the machine reads
  the keyboard again. The result says what the machine took (`requested`, `consumed`, `lines_requested`,
  `lines_delivered`); a machine that stops reading the keyboard ends the call with `not-consumed` and how far it
  got, and a character the keyboard has no key for is `not-typable`.

#### Changed

- AGENTS.md: an item's scope comes from its brief or issue; contributors don't edit a roadmap.

### 0.1.0 (first public release, not tagged yet)

Everything on `main` so far. Hardware behaviour is checked against MAME 0.264 in instruction lockstep (and pixel
by pixel for video) with firmware written for this project; docs/verification.md lists each
comparison and every known difference. No ROMs are included: users supply their own.

#### Added

- **Machines:** Dragon 32, Dragon 64, Dragon 200-E (its character generator, rewired VDG and Spanish keyboard),
  Dragon Professional (Alpha: boot ROM bank, AY-3-8912, built-in WD2797 with two drives, modem registers),
  Tandy Color Computer 1/2 (4K, 16K, 32K or 64K RAM), Color Computer 3 with the GIME (NTSC verified; PAL as our
  own 312-line model), MC-10 (4K/20K), Matra Alice and Prológica CP-400. A built-in stub firmware runs programs
  without any ROMs; the MC6845 CRTC chip is in place for later models.
- **Video:** scanline-accurate VDG, T1 and GIME drawing, including mid-frame mode and palette changes; composite
  NTSC/PAL artifact colours with a phase switch (CoCo 3 compatibility modes included); CRT shader, scaling,
  integer scaling and aspect options.
- **CPU timing:** the SAM CPU rates (the "speed POKEs") timed per bus cycle from the MC6883 data sheet, with the
  Machine and POKEs tabs.
- **Storage:** a media layer on browser-private storage (OPFS) and local files (File System Access API), with an
  import/download fallback; ROMs, recent programs, disks and snapshots live on it. The Library page with shelves,
  filters, the type-in card and the magazine rack.
- **Floppy disks:** WD2797, WD2791 and WD1773; DragonDOS, Premier/Delta and RS-DOS controller cartridges; VDK, DSK,
  JVC and DMK images, read and write, up to four drives, write-protect and download; the drives card under the
  screen. Disk images written by MAME and by CLOADM from the same firmware are byte-identical.
- **Cartridges (CoCo 1/2):** bank-switched ROM cartridges, Games Master Cartridge (SN76489), Orchestra-90 and the
  Multi-Pak, with sound compared against MAME's recorded audio; the cartridge port menu.
- **Cassette:** CSAVE/CSAVEM capture to downloadable `.CAS`, WAV loading (noise, drift, inverted phase and DC
  offset tolerated) and WAV export, on the Dragons, CoCo 1/2/3, MC-10 and Alice; the tape screen.
- **Printer, serial and DriveWire:** printer output with download; the Dragon 64's 6551 ACIA and the bit-banger
  serial port to an in-page terminal, a loopback plug or Web Serial; an in-browser DriveWire 4 server on the
  Becker port with WebSocket channels, and serving a real CoCo over Web Serial (tested with a mocked port only).
- **Snapshots:** `.cloadm` files (versioned gzip JSON) for every model, capture and share, opening by drag and
  drop, and three quick-save slots.
- **Debugger core:** 6809/6803 disassembler; breakpoints, watchpoints, single step, step over, run to return or
  address, instruction trace and memory and register access through the Session.
- **Input:** translated and positional keyboard modes for every family, keyboard joystick, gamepads, the CoCo
  Max Hi-Res module and the CoCo 3 mouse.
- **Programs that need no ROMs:** the welcome program, the colour demo, and LIZA (after ELIZA), for the 6809 and,
  on the MC-10 and Alice, the 6803.
- **Claude chat terminal (core):** the Messages API backend with streaming and tools, the chat firmware with its
  own 42×24 upper and lower case font, a host-side key store that keeps the API key out of the machine, and the
  DriveWire chat channel. The page that exposes it is not there yet.
- **Site:** the landing page at `/`, the emulator at `/play`, the `/roms` page, Help and Credits, with a light
  variant for reading pages and a phone layout.
- **Development:** the MAME lockstep, video, raster, byte and audio comparison tools in `tools/mame-diff/`, the
  regression hash gate, the headless browser check, and a CI workflow running both on every push. The test gate
  (`tests/all.js`) fails a suite that exits 0 without printing its summary, so a suite that stops part-way on a
  promise that never settles can no longer count as a pass (found by this: `tests/allsignal.test.js` had been
  exiting silently), and `tests/machine.test.js` now ends with the summary line every suite prints.
