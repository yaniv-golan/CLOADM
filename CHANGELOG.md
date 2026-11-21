# Changelog

All notable changes to CLOADM are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project intends to use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once releases are tagged.

## [Unreleased]

### Changed

- **The floppy-disk suite is split in four.** `tests/disks.test.js` had grown to about 150 s (v0.1.6 added about 900
  lines of mount-race and new-disk-race cases, each importing and mounting 40-track images, and a mount is about
  1.3 s of flux encoding, as it was in v0.1.5), close to and on CI over `tests/all.js`'s 240 s per-suite cap. Its cases, unchanged, now run in
  `disks.test.js`, `disks-mount-race.test.js`, `disks-mount-case.test.js` and `disks-newdisk.test.js`, with the shared
  firmware and store fixtures in `tests/disks-common.js`. No check was removed or loosened (206 passing checks before
  and after); the disk code itself is unchanged.

- **The home page's Dragon 64 looks like the real one.** The hero and the machine card draw it in inline SVG from a
  3D model of the real case's side contour, seen from the front left: the low front, the sloping keyboard deck, the
  raised rear plateau with its ventilation grooves (cut through the side edges, as on the real case) and the rear
  chamfer. On it are the black badge with a red dragon
  glyph, rainbow DRAGON and a white 64, the red power LED, and the black keyboard in its real layout with legends
  (shifted symbols hidden at phone width). The browser check makes sure the art is drawn, fits the page and is
  aria-hidden.

### Fixed

- **Reset after a game no longer says CLOADM failed.** Many machine-code games set BASIC's warm-start flag and
  vector ($71 = $55, $72-$73 pointing at a NOP of their own), so **Reset** goes back into the game with RAM kept,
  as on a real machine. The boot box then counted 5 seconds from the Reset, saw no OK and said "No OK after 5
  seconds … a problem in CLOADM". The watchdog now arms only on a power-on (a new machine, **Switch off and on**,
  ROMs changed). After a Reset that a program took over, the box says "A program took over Reset" and offers
  **Switch off and on** for a clean BASIC (`Session.bootStatus` answers `reset`, with `takeover`).

- **Add ROMs no longer keeps old offers to switch machine.** A ROM drop's "Switch to …" offers stayed for the
  whole visit, so opening Add ROMs later (from the boot box, say) still offered "Switch to Tano Dragon 64" after a
  drop of Dragon 64 ROMs. Offers now show only with the drop that made them: they go when Add ROMs closes and on a
  machine change, power-on or Reset. A machine whose sockets hold the same ROMs as the one in use (the Dragon 64 and
  the Tano Dragon 64) is not offered, and **Switch to …** asks first, as the machine menu does.

- **Reset keeps the 6809's flags, and a CoCo's Reset latches no serial edge, as MAME's.** A Reset (not a power-on)
  sets only CC's I and F, leaving the others as they were (the 6309 too), and leaves PIA1's CA1 line as it is
  instead of latching a new edge from the serial port. Found by the new lockstep comparison of the Reset button
  (`run.js <profile> --reset`, `tools/mame-diff/sam/reset.asm`): every instruction identical through two Resets on
  every SAM machine compared and on the 6309 (dragon64h, tanodr64h), and four cases in the regression gate.

- The **Switch off and on** button's tooltip said it ejects the tape and cartridge; they stay in, and it says so.

- **Opening a snapshot no longer says CLOADM failed.** Opening a snapshot (a file or a quick-save slot), or putting
  a moment back with Claude's **↶ Restore to …**, no longer brings up the boot-failure box ("No OK after 5 seconds …
  a problem in CLOADM"), whenever in its run the moment was saved: before, one taken more than five seconds into its
  run showed the box the instant it opened, and an earlier one showed it after the rest of the five seconds. A
  loaded moment is not a power-on; it is now marked as such (`bootStatus` answers `restored`). A **Reset** leaves a
  loaded moment on the Reset rules (RAM kept, no "the boot failed"; a program holding BASIC's warm-start vector gets
  "A program took over Reset"); **Switch off and on**, or a ROM change, arms the boot check again. The browser check
  opens a snapshot of a game, waits 6 s of the machine's own frames, and requires no box.

### 0.1.6-pre

#### Added

- **Claude reads the Dragon 64 Plus's 80-column screen.** `screen_text` (and `machine_info`'s `video.readable`) used
  to decline the HD6845S screen; now, while the Display tab shows it, it reads the board's 2K video RAM as the CRTC
  walks it (start address R12/R13, R1 columns, R6 rows, the 2K wrapping), the same walk the picture is drawn from,
  with `screenRows`, `startAddress` and `base`. Codes `$20`-`$7E` are read as ASCII, an assumption no source could
  confirm; it declines, rather than guess, an interlace mode, inconsistent or oversized registers, rows under the
  board's 10-line character and any other code. No character
  generator ROM is needed. Verified with our own firmware (`tools/mame-diff/d64plus/plustext.asm`): in lockstep
  with MAME 0.264 to HALT, and six screens identical to MAME's pixel for pixel (`run.js d64plus --plustext
  [--video]`); `tests/d64plus-screen-text.test.js` and the browser check's Ask Claude on a d64plus.

#### Changed

- **The welcome demo's sound is one short clean tone.** "2 COLOUR AND SOUND" used to write one DAC value per frame, a
  staircase that ticked at the field rate and popped from full scale to zero about once a second. It now plays a
  single tone as the colour bars start: a square wave around the DAC's centre `$80` (high `$B0`, low `$50`, about 37 %
  of full scale), 659.9 Hz (a cycle-counted loop: 1356 cycles a period at 0.894886 MHz) for 264 periods, 0.40 s, ending
  on `$80`, and then nothing more is written to the DAC. The bars, their scrolling, the colour-set flip and the key
  that returns are unchanged; the first bar frame comes 0.4 s later. `tests/demo-tone.test.js` runs the demo on the
  Dragon 64, CoCo and CoCo 3 and checks pitch, length, amplitude, the first and last value, the largest step, 200+
  silent frames afterwards and the picture against the bars' definition.

- **Every DriveWire server the Session builds reads the store's case rule, and now each one is pinned.** The
  Session creates three servers on the same media: the Becker port's, the one a real CoCo is served from over Web
  Serial (`serveRealCoco`), and the chat's. Each is given the store's name comparison at construction (GAME.DSK and
  game.dsk are one file on a folder that does not tell cases apart), but only the Becker one was tested, so
  dropping that wiring from either of the other two left every suite green. `tests/drivewire-samename-servers.test.js`
  checks all three: on a case-insensitive store a named-object mount of the other spelling resolves to the drive
  that already holds the file and adds no drive, and a second drive on that file is refused naming the first; on a
  case-sensitive store the same calls are two files, so the mount takes a free drive with its own bytes and the
  second drive is allowed (the control that stops these checks passing on a server which refuses everything). The
  real CoCo is served over a stub serial port, not Web Serial. No product change: `js/` is untouched, and the
  wiring was already right, just untested (on the commit before this one, with both non-Becker wirings removed, the
  three suites that cover those servers still passed).

#### Fixed

- **A new blank disk and an import of its name racing each other.** Both check the library for the name and then
  write it, with a listing and the wait for the drives' writes in between, so two of them could both pass the
  check: the later write replaced the earlier image under its own name, and the drive then read back the other
  image's bytes (a new blank disk could end up holding the imported image's bytes, and the imported bytes were
  gone with no error at all). A new disk, a drive import and a Library import are now made one at a time: a
  second one waits for the first to have written and then checks again, so it is refused as it would have been
  had it come second -- the second new disk with "There is already a disk named … in your library", an import of
  the name with the drive it is in, and a new disk's first free name skips a disk a queued import has just made.
  Names compare the way the store does, so `GAME.DSK` and `game.dsk` are one name on a case-insensitive store and
  two on a case-sensitive one. A second creation of a name -- in another drive or the same one, under the same
  spelling or another case, and including a name a new disk picks for itself -- is refused and the first one's
  bytes are kept; a disk already in the library is replaced only by an import asked for after its creation
  finished, which is how a disk in a drive takes a newer copy of itself (and if the first creation fails, nothing
  is refused). A Library import waiting its turn when the library starts moving is refused rather than written
  into the folder it is leaving. There is no deadline: a creation whose store write never answers holds the later
  ones until it does, as a hung store write already holds a mount or a library move, so nothing runs alongside it.

- **Moving your library no longer loses (or strands) what was being saved.** **Where your library is kept** copies
  every file to the new place, and it could copy the library out from under a Library operation already under way:
  an import, a rename, a delete, a quick-save slot or a DriveWire image started just before the move landed in the
  old place after it began, so it was either dropped or missing from the moved library. The move now waits for
  those operations to finish first (theirs or their failure, which stays theirs to report), and refuses a new one
  while it copies, saying "The library is being moved: try again once it is done" - the same answer the Library's
  own changes already gave. The wait is bounded: an operation that never ends (a folder whose permission went, a
  store that stopped answering) does not hang the move for good - after 30 seconds in all, the drives' last writes
  and the Library's operations waiting together under the one limit, it stops with a message and your library stays
  where it was. The Undo of a save, a ROM drop or ROM pack restore (which write the library's own index), and a
  DriveWire mount or named-object create on the emulated machine's Becker port (a mount hands the drives the store
  they then write in, and so did a NitrOS-9 boot) are covered too. A mount begun while the copy runs is
  refused. A guest's create (the stat, the write of the new object and handing the guest its drive) is one Library
  operation: begun while the move copies it is refused (answered 0); under way when the move starts, the move waits
  for it, then finds the guest's new drive mounted and is refused itself ("Eject the disks first"), with nothing
  copied and the session on the place that drive writes to. A NitrOS-9 boot is refused before it changes the machine
  if a move began during its reads; past them, a move that begins during its mount waits for it and is refused the
  same way, so a boot is never left half done; an image added in the NitrOS-9 slot whose boot a move then refuses
  says it was kept ("… was saved to your Library but not booted: …"). This covers the Becker-port server; serving a
  real CoCo over Web Serial and the Claude chat's own DriveWire server are not covered here (`js/session.js`,
  `js/drivewire/server.js`, `tests/move-inflight.test.js`).
- **DriveWire's Save drive 0 threw when its image list could not be read.** With no drive chosen, **Save drive 0**
  asks the store for the first image; a refused listing (a folder whose permission was revoked, a store that would
  not answer) made that a promise nothing handled, and with no image at all it read a name off an empty list
  ("Cannot read properties of undefined"). It now says what the Library says, on the status line ("the DriveWire
  images: the folder's permission was revoked", or "No DriveWire image to save: add one first."), and the box
  renders empty rather than aborting (`js/ui/drivewire-panel.js`; the browser check refuses the listing and clicks Save with no drive chosen,
  counting unhandled rejections).

- **A background save that fails can no longer stop the media library saving anything again.** The page's
  handler for a failed background write (a full browser, a permission that went away) draws the status line; if
  that handler itself threw, the media index's write queue took the exception and every later write was dropped
  for the rest of the session (the ROM images of a program loaded afterwards, the recent list, the name map), and
  waiting for the queue rejected with the handler's error. The index now catches its handler's error and reports
  the failed write itself (`console.error`: always when no handler is set, as an embedder may leave it, and when
  the handler threw), and the queue goes on (`js/media/library.js`).
- **A disk image no longer fails to go into a drive when another drive is writing.** Mounting a stored disk reads
  it once every queued change has reached storage; when a change was queued while it read, it read again, and after
  four reads it gave up with "the drives kept writing while it was read". The check counted every change to every
  stored disk, so writes on another drive (or a long transfer to a slow store) could use the four up and make a
  perfectly good mount fail with no data lost. The mount now reads again only for changes to the image it is
  mounting, and which names are that image follows the store's case rule (the same measured rule the Library's
  guards use): on a store that keeps `A.VDK` and `a.vdk` apart only its exact name counts, and on one that holds
  them as one file either spelling does. A store whose rule is not measured yet is taken as case-insensitive, so
  the mount reads again rather than keep bytes that may be stale. An image that really keeps changing under the
  read still ends with the same message after four reads (`js/session.js`).
- **A NitrOS-9 floppy image added to the Library is written through the disk queue.** Picking or dropping a
  NitrOS-9 floppy image stored it with a direct write, outside the queue the drives and the Library's disk changes
  use, so a mount of the same name reading at that moment could take the bytes from before the write without
  reading again (a torn read). The write is now queued like every other change to a stored disk, so such a mount
  waits for it or reads again (`js/session.js`).

- **The browser check drives Stop in both orders, and reads the translated key as the exact set.** The ask check
  clicked **Stop** as soon as the pill said "Claude is typing line …", and the pill takes its line number from
  the typist queue before any key has been read (`js/ui/claude.js`). Stop could then land with nothing typed,
  and the page correctly said "– stopped before typing" (`js/claude/actions.js`: it says "while" only when keys
  were delivered) while the check demanded "while": a one-frame race. Measured on a Mac with a probe in a copy:
  Stop was clicked with 0 keys read and the line still said "while" in 6 of 6 runs, and the same code failed the
  phone case on a loaded full run. The check now waits, fail-closed, until the typing job has read a key and is
  still typing, asserts that state at the click, and then asserts "– stopped while typing 40 lines" exactly. A
  new case holds the machine with the page **Pause** (which pauses the machine, not Claude), asserts the job is
  typing with 0 keys read, and asserts "– stopped before typing 40 lines" exactly; it runs last because its turn
  makes a restore point. The translated Shift+2 check asserted that the character's key was among those held, so
  a page bug leaving SHIFT down with `@` would pass; it now asserts the whole held set from the matrix
  (`js/machines/keyboards.js`): `2, SHIFT` for `"` and `@` for `@` (this host's Chromium reports `@` for
  Shift+2, so only that branch runs; the `"` case is asserted but unexercised here). `tools/browser-check.js`
  only; no page behaviour changed.

- **The browser check is host-independent, and its keyboard checks no longer race the machine.** Several of
  its checks only passed on a PC or on an idle machine. The desktop "Commands…" check expected `Ctrl K`, but
  the page chooses that hint when `navigator.platform` is not a Mac or an iOS device (`js/ui/command-box.js`)
  and a Mac renders `⌘K`. That block now pins the platform to a PC before the page loads and asserts the
  literal `Ctrl K`, the Mac block keeps its own, and a new table pins Mac, iPhone, iPad, Windows and Linux and
  asserts each one's literal hint, so the page's own platform test is exercised on every branch and a wrong or
  missing hint fails. The input checks read the keyboard matrix at fixed moments: `heldNow` ran a fixed 3
  emulated frames (translated Shift+2 and positional Q), and the joystick "does not type" check read it with
  no wait at all. A held key goes through `KeyQueue`, which applies one change a frame and holds a key 3
  frames, so on a loaded machine the read could see the previous step's release and not yet the new state. The
  two `heldNow` checks now wait for the queue itself to drain (`session.keys.pending`), and the joystick check
  drains the queue and the matrix before reading. Measured on a Mac with `--only input,commands`: the old
  checks failed `input` in 2 of 3 runs, and this code passed all 45 checks in 3 of 3. `tools/browser-check.js`
  only; no page behaviour changed.

- **The test gate's summary check, closed where it could still pass a suite that failed** (the follow-ups from that
  change's review). A suite that stopped part-way could still print its summary from a `beforeExit` or `exit`
  handler, and the gate read that as a pass; every write made while the process is shutting down is now marked and
  not read as a summary (`tests/no-exit.js`, `tests/suite-verdict.js`). A suite whose summary it reached while
  running and which then printed a line at exit was FAILED on main; that healthy suite now passes. A suite that
  printed `FAIL <what>` to stdout and then a passing summary, or reset its own exit code, passed; any line starting
  `FAIL ` now fails it whatever it exits with (no suite here prints one on a passing run: they were all run and
  scanned, and `tests/allsummary.test.js` holds that). The static check that every suite prints exactly one readable
  summary now reads double-quoted strings, `console.info`/`console.debug`, `%d` formats and a concatenation of
  three or more literals, which it missed before. Every summary pattern's `^` and `$` is held by a rejected line
  only that anchor rejects, so no anchor is unpinned. `tests/asm.test.js`'s
  comment claimed the LIZA conversation was counted in its tally; it is not, and its failures now print in the
  gate's one `FAIL ` shape rather than only in the summary's last word.
- **A regression count that never answers fails the gate instead of hanging it.** `tests/all.js` asks the
  regression suite for its case count with `--count`; that call had no timeout, so a child that never exited left the
  gate waiting for ever. It now runs under a 10 s cap (about 180x the measured 55 ms, so a slow machine is never
  mistaken for a hang), kills the whole process group on timeout, and fails the run naming the child. The test's own
  bound is a hard one with the group kill, so a regression there hangs nothing.

### 0.1.5-pre

#### Added

- **Install CLOADM as an app.** **Install CLOADM…**, at the foot of the **machine menu**, runs the browser's own install prompt where there
  is one (Chromium, with its mini-infobar suppressed and the page's own card asked instead) and shows the steps
  that install it elsewhere (Firefox Android, Samsung Internet) and on iOS, which has no install event (Share →
  Add to Home Screen). Once a program has run for a minute on a visit, the page offers it in a card that
  covers nothing you look at or press (the screen, the machine controls, the app bar, any on-screen key):
  bottom-right over the page, beside the screen, or a one-line strip between the screen and the keys on a phone
  held upright. With no such room it is deferred unspent and comes when a resize makes room; a menu or a view
  opening takes it away unanswered and it returns when they close. It never takes the keyboard from the machine
  (Esc on the screen stays BREAK); Esc elsewhere or **Not now** to wait 14 days (a
  second **Not now** ends the offers), **Don't ask again** to end them at once, and the browser's `appinstalled`
  shows "Installed." and stops asking. The card, the Menu item and their state are `js/ui/install.js` (the rules
  are pure functions, pinned in `tests/install.test.js`); the Help page has the steps for every browser.

#### Changed

- **Restore points: one small line instead of a card after every message** (UX ruling R12). Under the latest turn
  that changed the machine: "↶ Restore to 23:58 · Restore points…", the second opening every point (the last 10)
  and what restoring does and doesn't roll back; while a turn runs, "Restore point at 23:58 · Stop first to restore".
  The same line in the side panel, the phone sheet and the full-screen chat; after a restore it moves to the
  previous point's turn. The "✓ restore point made" log line is gone, and nothing calls it Undo.
- **What Claude did, one line per action under each turn** (UX ruling R13), replacing the activity log: "✓ typed
  "DIR"", "– didn't type "DIR": you said no", "– typed "DIR", but the machine didn't read the keys", "✗ couldn't
  …", partial pokes and loads, " · undone at 00:02" after a restore; a turn of more than 3 actions folds its ✓ lines
  into one button with the reads counted; a turn that only read says so on a plain line ("read the screen 2×,
  memory 1×") and a read that failed is a ✗ line. A reset of the machine under Claude's typing is reported as
  `machine-restarted` ("– typed "1", then the machine restarted"), not as a Stop. Never printed on
  the full-screen chat's own screen
  (`js/claude/actions.js`, `js/ui/claude-lines.js`, `tests/claude-actions.test.js`).
- **A released CHANGELOG section can no longer be edited by accident.** `tests/changelog.test.js` compares each
  `### <version>` section with the same section in its release tag (`git show v<version>:CHANGELOG.md`), byte for
  byte, except for three named copy corrections kept in `tests/changelog-guard.js` with a reason each; new entries
  go under `## [Unreleased]`. It also fails if the newest tagged heading has no `## [Unreleased]` above it. CI's
  suites job now checks out with `fetch-depth: 0` so the tags are there; a checkout without them prints a SKIP
  line naming each missing tag and does not claim a comparison.
- **The browser check's `ask` group no longer fails now and then on "Ask Claude opens the side panel again".** The race
  was in the test: a machine switch fetches the welcome menu's program and starts it when the bytes arrive, and the
  test's `stubPrompt` (which ends the menu) could run first, so the menu started after it and the Ask button, which
  opens the full screen chat while the menu runs, did not open the side panel. The test now waits for the menu to
  start before ending it. The product behaves as designed (the menu starts, then the button follows it).
- **Tests for the welcome menu's offer on a 6309.** `tests/cpu6309-offer.test.js`: on every model with a 6309 option,
  switching to it offers the menu (`'menu', 'back'`), `offerMenu()` offers it after a link's `menu: false` switch, the
  file it fetches is `examples/welcome.bin` (the 6809 build, the same one the 6809 gets, and it exists), and an
  embedded session or a machine with ROMs is not offered it. The browser check's `cpu6309` group opens the literal
  `?machine=coco3&cpu=6309` link: the menu is on screen, no error toast, no 404, no page error, and the Debugger
  shows E, F, W, Q, V and MD. Each check turns red when the lookups go back to the CPU name instead of its family
  (the old "Welcome: examples/undefined: HTTP 404"), or when the link's `cpu` is dropped.

#### Fixed

- **Claude no longer forgets what it did, and no longer claims more than the machine shows.** Claude in the Ask
  panel said it had typed DIR and PROCS, and later that it could find no record of doing so. The chat kept only
  each reply's text, so the next request held Claude's claims without the tool calls and results behind them; a
  turn that failed after its tools ran (Stop, a network error, a stall) was dropped whole although the machine had
  changed. A turn is now recorded whole (the line, every `tool_use` with its `tool_result` as sent, the reply); a
  failed turn keeps the rounds that completed, with a note from the page saying how it ended; the oldest turns are
  dropped whole, never half a tool pair. What the views show is unchanged. `press_break` and `run "RUN"` now go
  through the paced typist and say whether the machine read the keys (`press_break` answered `{pressed:true}` at
  once, and `run` `{started:true}` with RUN only queued); every keyboard tool's description says that *consumed*
  means the keyboard was scanned with the key down, not that the program acted on it. The brief tells Claude to
  check a change with `screen_text`, `peek` or `machine_info` before saying it happened, and to call it unverified
  when it can't; it no longer assumes BASIC (a machine with NitrOS-9 running, or without ROMs, is described as it
  is) and gives the machine's own screen size rather than the chat firmware's, which only the full-screen chat is
  told (`js/claude/chat.js`, `js/claude/backend.js`, `js/claude/history.js`, `js/claude/brief.js`,
  `js/machines/typist.js`, `tests/claude-history.test.js`).
- **Disk names that differ only in case on a folder that does not tell them apart.** In a library kept in a folder on
  macOS or Windows, `GAME.DSK` and `game.dsk` are one file, so putting both in drives (or importing one over the
  other) had two drives writing one file. Every Library and drive guard — mount, import, rename, delete, new blank
  disk and its first-free name, and the drives card's "Disks in your library" list — now compares names the way the
  store does, and the shown name stays the one the disk was stored with. The store's rule is measured, not assumed,
  from a listing and one stat: nothing is written to the user's folder. (It differs by file system, not by backend:
  for example, Chromium's Origin Private File System tells `GAME.DSK` from `game.dsk`, while a folder on a default
  (case-insensitive) APFS or NTFS volume does not.) A store with no name to ask about yet is treated as
  case-insensitive until it has one. A case-only rename (`GAME.DSK` to `game.dsk`) is refused where it would replace
  the file and then delete it. A store that does tell cases apart keeps behaving exactly as before.
- **DriveWire: one image in two drives.** The same disk image could be mounted on two DriveWire drives, or put
  there while a drive already had it; both drives read and write the stored image in place, a sector at a time, so
  they overwrote each other's sectors. Mounting an image a DriveWire drive already holds is now refused, naming
  that drive, and the drives panel no longer offers it for another drive. Mounting it again in the drive that
  already has it still works, as changing its write-protect box does. A DriveWire image and a floppy cannot be the
  same stored file, so nothing changes between the two kinds.

### 0.1.4-pre

#### Added

- **Claude reads the CoCo 3's GIME text screens.** `screen_text` now reads every GIME text mode on the CoCo 3
  (6809 or 6309): 32, 40, 64 and 80 columns, with or without attribute bytes - NitrOS-9's 80-column screen and
  BASIC's `WIDTH 40`/`WIDTH 80` included - where it used to answer that it only handled the 32-column VDG screen.
  The GIME itself walks the screen from the emulator's own state (video start, row pitch, horizontal offset, lines
  per row and the rows shown), never the registers a program can't read back. Attribute bytes come back as runs
  of colour, underline and blink, never as characters; the GIME's international characters as the letters they
  show (`Ç ü é …`). A GIME bitmap, or rows too short to show a character, is still declined with a reason. Checked
  against MAME 0.264 on `coco3` and `coco3h` with new firmware (`run.js coco3 --video --text`): 14 screens, every
  pixel outside the glyph shapes of our own font identical, and MAME's glyphs where the expected text says.
- **The Ctrl/⌘K command box is discoverable.** With nothing typed it lists every command, grouped (Claude, Files, Views,
  Settings, Machine), with no row chosen until the first ↓ (so Enter on the empty box does nothing); the list scrolls
  inside the window and keeps the chosen row in view. A **Commands…** link in the app bar (behind Menu on a phone,
  and in the touch keys' Menu) opens it on every screen size, the Ask panel's empty state mentions the key on
  desktop, and Help has a **Commands and shortcuts** section and a **What Claude can do** section. When the
  one-row app bar (1200 px and up) would not fit in a wide fallback font, the key hints and the RAM size give way
  before anything wraps (the machine button's title and accessible name still say the RAM size).

#### Fixed

- **Time between instructions: an outside I/O access no longer runs the machine ahead.** `ioTime()` answers "the
  tick at which the current instruction touches the bus", but between instructions it returned the end of the
  *last* step, because the CPU keeps its cycle count after a step. A tool that looked at the machine between
  steps — a debugger's write, a stub hook — therefore fired scheduler events up to a whole instruction early
  (a 6309 `TFM` is tens of thousands of cycles, ~3.3 frames on the CoCo 3), and a machine restored from a
  snapshot answered differently from the original for the same access. The same fault in the CoCo 3's
  `accessStart()`, reachable between steps through the MAME-compat interrupt sync. Between instructions both now
  answer `now()`, which also moves the exact-time clock (`clockUnits()`/`tickAt()`) back to the machine's own
  time for every family. A CoCo 3 instruction suspended by the disk controller's HALT is the one between-step
  state that keeps the held access's time while its events run, and takes `now()` again once parked. Inside an
  instruction nothing changed (`tests/iotime.test.js`). One regression hash moved — the CoCo 3's SSC trace, from
  24,298 to 24,301 instructions — because its card is caught up between steps: on all three models the catch-up
  was early, but only the CoCo 3's step lengths are multiplied by `div`, so only there did the early answer
  cross a card instruction (counted on the card, the CoCo 1/2 and 2B run it 3,932 steps either way and the
  CoCo 3 56,541 before, 56,545 after). Its device-write rows and work RAM are identical.
- **Symbols typed on the keyboard are the ones you typed.** In translated mode (the default) the host's Shift went
  through to the machine, so a character the host types with Shift but the machine has unshifted came out
  SHIFTed: `:` typed `*` on every machine, `@` typed SHIFT+@ (a pause in Color BASIC) and `^` SHIFT+UP; on a
  layout that shifts other characters (the digits on AZERTY, for one) many more were wrong. The character now
  decides the machine's SHIFT, whatever the host's Shift is doing; letters and the named keys (BREAK, CLEAR, the
  arrows) still take the host's Shift. Typing fast also lost SHIFT: when the keys queued up behind the host,
  letting go of Shift could reach the machine before the shifted keys typed with it (`!"#` typed `!23`).
  Positional mode keeps the host's Shift as the key at its position, so the MC-10's and Alice's left Shift is
  CONTROL there, as the positional map always said.
- **The Mac's CLEAR is documented.** The Keys help and `docs/using.md` now say that on a Mac keyboard without
  `Home` or forward `Delete`, CLEAR is `Fn`+`←` or `Fn`+`Delete`, and that `Option` and `Cmd` stay with the Mac.
- **The docs, the page and two messages sent NitrOS-9 users to the wrong place.** The project's GitHub releases page
  has only "Source code" archives, no disk images. Everything that said to get a NitrOS-9 release there
  (`docs/using.md`, the NitrOS-9 slot's note under the screen, the "no image" messages) now names the v3.3.0
  SourceForge page, the two archives (`nos96809l2v030300coco3.zip`, `nos96309l2v030300coco3.zip`) and the file inside
  each to use (`..._becker.dsk` for DriveWire, `..._40d_1.dsk` for the floppy drive). The pins in
  `tools/nitros9/fetch.js` are unchanged (checked: both archives download from that page and the images match their SHA-256).
- NitrOS-9 card: the image list no longer sticks out past the card (it is capped to the card's width, and its title
  shows the whole name). A long file name in a Drives tile now stays on one line with the ellipsis in the middle, so
  the ending (`coco3_40d_1.dsk`) stays visible, and the full name is the tile's title. The browser check measures
  both at 1280, 1440, 1920 and 390 px wide.
- **Dragon 200-E: positional keyboard mode typed nothing.** `positionalKeys` had no layout for the 200-E's keyboard,
  so every physical key was dropped. The layout is the Dragon's with one binding changed, as in MAME 0.264's
  `dragon200e` ports (read from a running MAME): the physical `;` key is the 200-E's N-tilde. `tests/input.test.js`
  checks all 55 physical keys against MAME's rows and bits, and the browser check types in positional mode on a
  200-E.

### 0.1.3-pre

#### Fixed

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
- **The app bar stays one row from 1200 px wide up, in any system font.** On a machine whose fallback font is wider
  than the developer's (CI's: Library, Debugger, Help and GitHub wrapped onto a second row, 116 px against 68 at
  1280 x 720) the status text now gives way with an ellipsis before anything wraps; below 1200 px the bar wraps as
  before. The browser check measures it with `getBoundingClientRect` at 1280 x 720, in the page's font and in a wide one. The status text's `title` holds the whole text, so what the bar clips
  can be read on hover.

#### Changed

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
- Test follow-ups: `tests/restore-points.test.js` proves the chat's "Restore to before Claude's changes" keeps the
  point when the restore throws; `tests/allsummary.test.js` proves `tests/all.js` fails a run whose regression gate
  is missing or ran fewer cases than `--count`; `tests/claude-acting-contract.test.js` proves every acting tool's
  description names "Let Claude use the emulator".

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
