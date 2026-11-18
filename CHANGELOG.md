# Changelog

All notable changes to CLOADM are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project intends to use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once releases are tagged.

## [Unreleased]

### Fixed

- **CoCo 3: a memory write from outside the CPU left the CPU at the old clock.** The Debugger's memory write
  (which goes through the bus) to `$FFD8`/`$FFD9` set the GIME's fast bit but not the machine's clock divider,
  which only a following instruction could update: the GIME was at 1.79 MHz while the CPU still spent 4 clocks per
  cycle (about 14,934 instead of 29,867 cycles per frame). Writing the rate the GIME already held never corrected
  it (`js/chips/gime.js` reports no change then) and only a later write that changed the bits did. An outside write
  now takes the new divider at once; a program's own write keeps the instruction-timed path unchanged
  (`js/machines/coco3.js`, `tests/coco3.test.js`). A snapshot taken while the bug was live (a quick slot, a saved
  file) holds the GIME fast with the divider at 4; restoring it now derives the divider from the GIME, so the
  machine runs at the rate it reports instead of staying slow for good. An outside rate write while the disk
  controller's HALT holds an instruction drops that instruction (as any outside change does: its halted time counts
  at the old rate) so the CPU runs on at the new one; a snapshot of an instruction held after its own speed change
  keeps its saved divider.

### Changed

- **"Allow and resume".** While Claude is paused by your key, a card waiting for your answer says so, and its
  accept button reads **Allow and resume** (**Load and resume** on the load card): one click gives consent and lets
  Claude go on. The decline button never resumes. The status shows the pause (with Resume) rather than *Waiting for
  your OK*. Turning "Let Claude use the emulator" off while Claude is paused now withdraws consent for what the pause
  holds: on Resume the waiting action is refused, even one you had allowed on its card (before, it still ran), and
  typing held back is dropped instead of typed. Turning the switch on while paused does not resume.
  Esc while paused with a card up stops Claude. A card that ends the browser's Fullscreen is no longer taken for your
  Esc (which stops Claude) when a key paused Claude just before the browser reported it.
- **More of your input pauses Claude.** An edit in the Debugger (a byte, a register, a flag), the embed API's `poke`,
  `loadBasic`, `load` and `insertTape`, and a gamepad, the mouse as joystick or the on-screen touch stick and its
  FIRE (a fire press, or a push out of the dead zone; not a stick resting with noise or jittering at the dead zone's
  edge) now pause Claude acting on that machine, as a key does. On a phone, a card taller than the room the sheet
  leaves it now scrolls so its buttons show (with the key and privacy lines below the message box, Allow was hidden
  under the status line). Paused at a card you then decline, Claude is no longer shown as acting while it only writes
  its reply; every paused state says "Paused: you pressed a key · Claude's next action waits · Esc stops Claude".
- **The Ask panel's pause and the acting tools' gate are one mechanism.** The pause made by your input
  (`Session.personInput`) is the one the acting tools' gate and pre-act re-check wait on, and it ends with its turn
  (`endClaudePause`), refusing the waiting call. Your input pauses an acting call from its gate onwards (a card
  waiting, its `INCLUDE` read), even before Claude's first change of the turn; nothing is written and no restore point
  is taken while paused. `include-unreadable` is in `assemble_and_load`'s description and in the codes table of
  `docs/claude.md`. New `tests/claude-ask-acting.test.js`, and the browser check's `askEsc` group covers Stop on the
  page views' pill while a call waits at its gate.

### Fixed

- **Ask Claude no longer goes silent during a turn.** While Claude thought or wrote a long tool call (a `load_basic`
  program streams no text), the side panel showed nothing and had no Stop until Claude acted on the machine. Every
  view (the side panel, the phone sheet, the full-screen chat, and the page views: Share, the Library, Add ROMs and
  the Debugger) now shows the turn's status with **Stop**:
  *Thinking…*, *Using <tool>…* or *Waiting for your OK*, with the card scrolled into view. Stop at a card or while
  a tool runs ends the turn without another request. A stream that sends nothing for 60 seconds ends the turn
  with "Claude stopped answering", and an error event in the stream reads as the error it stands for (an
  overloaded API says so).
  Stop now also ends a turn while `assemble_and_load` waits for an `INCLUDE` file that never arrives (the read is
  aborted, and on its own gives up after 15 seconds with the new tool error `include-unreadable`). A pause made by
  pressing a key on the machine ends with its turn, so the next turn no longer starts paused with no Resume; the
  full-screen chat now has **Resume** beside Stop while paused (on a phone held sideways too, above its keyboard),
  the side panel's status line has Resume too (where the open panel covers the screen), the pill on the screen
  fits a phone's screen (its buttons were cut off), a later turn that only answers in text is no longer paused by a
  key, and a key pressed while a card waits for your answer pauses Claude without hiding the card (see "Allow and
  resume"). While Claude is
  paused, **Esc stops Claude** in every view (the side panel at any width, the phone sheet, minimised, the
  full-screen chat in its chat and BASIC views, a phone held sideways with its keyboard); it is Stop only, not
  also BREAK to BASIC, and a confirmation, menu or card open during the pause takes the first Esc. The pause's
  status says so ("Paused: you pressed a key · Claude's next action waits · Esc stops Claude"); before, Esc there was BREAK, Claude stayed
  paused and a later Resume typed everything it held. The browser's Fullscreen hid every Stop and Resume: the
  fullscreen screen now shows Claude's status with Stop (and Resume while paused), leaving Fullscreen while paused
  (Esc there) stops Claude, and a card waiting for your answer ends Fullscreen. A Reset or a power cycle while
  Claude acts on that machine or is paused stops Claude ("[stopped: you reset the machine]"), and so does any other
  restart of it (a program or cartridge that starts, the welcome menu, LIZA, ROMs cleared) and any program you
  load or run on it; a snapshot load or a
  machine switch closes the conversation; a later Resume never types held keys or runs a stopped action. The page
  views hid every Stop (Claude's own "3" at the welcome menu opens Add ROMs): they now show Claude's status at the
  bottom of the window with Stop, Resume while paused and Answer while a card waits, and a card raised while a view
  is open closes the view so the card shows. Wherever no other Stop can be reached (a phone held sideways with its
  touch keyboard and the panel closed or minimised), the same status with Stop shows over the screen. Every way you send input to
  the machine Claude is using now pauses Claude as a key on the screen does: a key with the focus on the page,
  Shift (and Ctrl or Alt on a CoCo 3), an on-screen key, a paste, the type-in panel, a tap on the welcome menu
  and a POKE from the book (before, those went in unpaused and counted as
  Claude's, so your "1" at the welcome menu started LIZA as if Claude had chosen it). A "[stopped]" note no longer
  stays in the side panel after a turn the full-screen chat starts. With a drawer tab open from the Ask panel's
  rail, Esc closes the tab first (as a menu) and is no longer also BREAK; a page view closes the tab. A card waiting
  for your answer makes the touch keyboard step aside in every layout. A reply
  with no text is no longer kept as an empty message, which made the API refuse every later request of the chat: a
  turn of tool calls only is kept as a note of the tools used (for the model, not shown), a refused question is dropped (and shown with
  "Claude declined to answer this one."), and requests are always sent as a conversation the API accepts (one that cannot be made valid fails the turn with
  an error instead of being sent; a blank line starts no turn).
- Claude no longer asks in prose before loading a long program and then has the page ask again: the policy now
  tells it to call `load_basic`, whose card is the question.

### 0.1.2-pre

#### Added

- **A touch joystick in the on-screen panel.** A **Keys | Joystick** switch (on machines with a joystick port, so
  not the MC-10 or Alice, and not with a Hi-Res interface or The Rat in that port) turns the phone or tablet panel
  into an analogue stick on the right joystick — the one the first gamepad drives — with the pads' own dead zone,
  a floating base and about 56 px of travel, plus a large FIRE on the same button bit a stick's fire button uses,
  a key strip (SPACE, ENTER, BREAK, 1, 2, Y, N, ABC) and one-press ABC for the full keyboard. The stick and FIRE can
  be held at once; a gamepad connecting stands the stick down; the mode is remembered per machine and
  `?touch=joystick|keys` sets it for the visit. Keys mode is unchanged, with Hide keys moved into the panel's Menu.
- **NitrOS-9 from a floppy:** the release's `_40d_1.dsk` (35/40-track NitrOS-9 floppies) boots the same way with
  CLOADM's own floppy loader and the CoCo disk controller, no Disk BASIC ROM needed.
- **The Speech/Sound Pak on the Dragon 64.** The cartridge port's board menu now offers the Pak on the Dragon 64
  as it does on the CoCo 1/2, CoCo 2B and CoCo 3, music only (speech is still not implemented). The Dragon 64's
  run of this project's diagnostic firmware matches MAME 0.264 instruction for instruction to HALT, which is what
  offering it rests on; the other Dragon-family models (Dragon 32, Dragon 200, Dragon 200-E, Tano Dragon 64, Dragon Professional (Alpha)
  and Dragon 64 Plus) have not been run, so they do not offer it.

#### Fixed

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
- **CoCo 3 disk controller HALT:** a sector read with the CPU halted could read the data register before its byte
  (NitrOS-9's floppy booter read LSN 0 one byte off, and every byte twice at 1.78 MHz). HALT now suspends the CPU
  inside an instruction as MAME's does, and the cartridge slot's line delays follow the CPU rate. A halted read whose
  DRQ never comes (an empty drive) holds the CPU across frames instead of the page: the screen and timers run on, and
  a disk in the drive or a Force Interrupt releases it. Changing the CPU's registers while it is held (a program
  loaded and started, a jump, the debugger) drops the held instruction, as does writing over its code: the CPU
  goes on from the new state when HALT is released. A held instruction runs again with exactly the bytes it had
  read (a 6309 TFM whose source overlaps its destination copied its own new bytes), however long it is. The debugger counts no instruction while the CPU is halted: Step waits a frame and reports
  "Halted", Over/Out/Run-to wait two seconds, and Run keeps the frames going without stopping.
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
- **The HD6309 now runs the 6809 programs.** Choosing the 6309 (Machine tab, or `?machine=dragon64&cpu=6309`)
  opened on "Welcome: examples/undefined: HTTP 404": the Session's welcome-menu, LIZA, colour-demo and Claude-chat
  lookups were keyed by the literal CPU and had no 6309 entry, so the page fetched a missing file, the screen kept
  the bare stub, the Media tab lost the colour demo, and the choice stuck for later visits. The lookups now go by
  CPU family (`js/cpu/cpus.js`), and the 6309 — which runs every 6809 instruction in emulation mode — gets the 6809
  welcome build, LIZA and demo, and the 6809 chat firmware. The stored 6309 choice is unchanged.
- Opening the full-screen chat from a view no longer forgets that the Ask panel reopens when the view closes if the
  chat fails to open (for example, its firmware does not load).
- The browser's Back from a view leaves the focus on the screen, as "← Emulator" and Esc do (it landed on the page or on
  the opener's button), also when the Ask panel reopens over the conversation.
- After a reload while a view was open over the chat, Back no longer leaves `?app=claude` in the emulator's address: a
  page loaded on `?app=claude` now keeps the emulator's own entry, without the parameter, under the chat.
- "What is this code doing?" asked from the full screen chat (Ctrl+K) disassembled the chat firmware and its
  registers; it now reads the BASIC session, as the read tools do (`Session.codeAt`).

- **The app bar stays one row from 1200 px wide up, in any system font.** On a machine whose fallback font is wider
  than the developer's (CI's: Library, Debugger, Help and GitHub wrapped onto a second row, 116 px against 68 at
  1280 x 720) the status text now gives way with an ellipsis before anything wraps; below 1200 px the bar wraps as
  before. The browser check measures it with `getBoundingClientRect` at 1280 x 720, in the page's font and in a wide one. The status text's `title` holds the whole text, so what the bar clips
  can be read on hover.

#### Changed

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
  relied on the "Let Claude use the emulator" switch is `no-consent` once it is off; nothing lands while paused. A
  `ChatSession` built without a gate now refuses every acting tool (`no-consent`) instead of allowing it. `run.target`'s
  schema is `anyOf` an integer `ADDRESS_MIN`-`ADDRESS_MAX` or a string.
- **Sound plays through an AudioWorkletNode** (`js/host/audio-worklet.js`) instead of the deprecated
  ScriptProcessorNode, so the console no longer warns on every page load and sound is played on the audio thread,
  away from the page's work. The samples are unchanged (the emulation core is untouched): the output stage makes
  them on the page as before and sends each frame through the worklet's MessagePort as a transferred chunk (no
  SharedArrayBuffer, which GitHub Pages can't enable). The worklet's queue is bounded (300 ms, the oldest dropped on
  overrun) and runs dry into silence, faded over 5 ms, never repeating old samples. The latency targets are
  unchanged (10 to 80 ms queued, frames dropped past 150 ms); measured from a frame's samples being made to their
  being rendered (Chromium, headless, five runs each) the median latency went from 80 to 144 ms to 33 to 67 ms.
  Where AudioWorklet is missing (an old browser, plain `http://` other than `localhost`), its module can't load (or
  hasn't loaded within 3 s) or its processor fails, a ScriptProcessorNode plays the same queue, so sound keeps working; with AudioWorklet working none is created.
  The worklet is in the service worker's list, so offline sound works too.
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
- **Snapshots are format version 2:** a CoCo 3 instruction held by the disk controller's HALT is saved with the
  machine. Version 1 files still open; a page from before this change refuses version 2 files as newer.
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
- **Ask Claude says what it reads, and that it is only the emulator.** The panel's header is "Claude can read
  (emulator only):" with the chips "Screen text" and "Memory"; the placeholder and the phone peek say "Ask about this
  machine"; the empty state says "Claude reads only this emulated <model> (its screen text and memory), never your
  computer" and follows a machine switch, on phones too; a new footer line says "Your messages and what Claude
  reads go to Anthropic with your key." The full screen card names the BASIC session's model. The switch is "Let
  Claude use the emulator" everywhere (page, docs, README).
- The test gate (`tests/all.js`) fails a suite that exits 0 without printing its summary, so a suite that stops
  part-way on a promise that never settles can no longer count as a pass (found by this: `tests/allsignal.test.js`
  had been exiting silently), and `tests/machine.test.js` now ends with the summary line every suite prints.
- Test follow-ups: `tests/restore-points.test.js` proves the chat's "Restore to before Claude's changes" keeps the
  point when the restore throws; `tests/allsummary.test.js` proves `tests/all.js` fails a run whose regression gate
  is missing or ran fewer cases than `--count`; `tests/claude-acting-contract.test.js` proves every acting tool's
  description names "Let Claude use the emulator".

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
  regression hash gate, the headless browser check, and a CI workflow running both on every push.
